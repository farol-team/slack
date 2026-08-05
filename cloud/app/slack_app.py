"""Slack surface: Events API handlers, Block Kit rendering,
and the message-ingestion buffer feeding OpenViking."""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from typing import Optional

import json
import httpx
from slack_bolt.async_app import AsyncApp
from slack_bolt.authorization import AuthorizeResult
from slack_sdk.web.async_client import AsyncWebClient

from . import protocol as p
from .memory import OpenVikingClient
from .chat_router import Turn, router

log = logging.getLogger("slack_app")

def create_bolt(signing_secret: str, authorize_fn) -> AsyncApp:
    """Build the Bolt app with multi-workspace authorize."""
    return AsyncApp(signing_secret=signing_secret, authorize=authorize_fn)


def make_installation_resolver(saas_url: str, internal_secret: str,
                               ttl_secs: float = 300.0):
    """Resolve Slack team -> SaaS installation {bot_token, ov_account_id}.
    Cached per team with a TTL so a reinstall (new bot token) is picked
    up without restarting the service."""
    cache: dict[str, tuple[float, dict]] = {}

    async def resolve(team_id: str) -> dict:
        hit = cache.get(team_id)
        if hit and time.monotonic() - hit[0] < ttl_secs:
            return hit[1]
        async with httpx.AsyncClient(timeout=10) as client:
            # Serverless ingress strips custom headers — the secret rides
            # in the payload (the header stays for direct/dev setups).
            res = await client.get(
                f"{saas_url}/api/trpc/slack.installationByTeam",
                params={"input": json.dumps({"json": {
                    "teamId": team_id, "secret": internal_secret}})},
                headers={"x-internal-secret": internal_secret},
            )
        data = res.json().get("result", {}).get("data", {}).get("json", {})
        if not data.get("botToken"):
            raise RuntimeError(f"no installation for team {team_id}")
        inst = {
            "bot_token": data["botToken"],
            "bot_user_id": data.get("botUserId"),
            "ov_account_id": data.get("ovAccountId") or team_id,
        }
        cache[team_id] = (time.monotonic(), inst)
        return inst

    return resolve


def make_member_resolver(saas_url: str, internal_secret: str, resolve_installation):
    """Resolve a mention author -> the member's memory identity (BYOA).
    Tries the stored slackUserId link in the SaaS first; on a miss, looks
    up the author's email via the Slack API and lets the SaaS match a
    member by email (persisting the link for next time)."""
    cache: dict[tuple[str, str], str] = {}

    async def query(team_id: str, slack_user_id: str,
                    email: Optional[str]) -> Optional[str]:
        payload: dict = {"teamId": team_id, "slackUserId": slack_user_id,
                         "secret": internal_secret}
        if email:
            payload["email"] = email
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(
                f"{saas_url}/api/trpc/slack.memberByTeamUser",
                params={"input": json.dumps({"json": payload})},
                headers={"x-internal-secret": internal_secret},
            )
        data = res.json().get("result", {}).get("data", {}).get("json", {})
        return data.get("ovUserKey") or None

    async def resolve(team_id: str, slack_user_id: str) -> Optional[str]:
        cache_key = (team_id, slack_user_id)
        if cache_key in cache:
            return cache[cache_key]
        user_key = await query(team_id, slack_user_id, None)
        if user_key is None:
            inst = await resolve_installation(team_id)
            try:
                info = await AsyncWebClient(token=inst["bot_token"]).users_info(
                    user=slack_user_id)
                email = (info["user"].get("profile") or {}).get("email")
            except Exception:
                log.exception("users_info failed for %s", slack_user_id)
                return None
            if not email:
                return None
            user_key = await query(team_id, slack_user_id, email)
        if user_key:
            cache[cache_key] = user_key
        return user_key

    return resolve


def make_authorize(saas_url: str, internal_secret: str):
    """Multi-workspace authorize for Bolt, built on the installation resolver."""
    resolve = make_installation_resolver(saas_url, internal_secret)

    async def authorize(enterprise_id, team_id, user_id=None, **kwargs):
        inst = await resolve(team_id)
        # enterprise_id/team_id are required by AuthorizeResult — without them
        # every Slack event dies in the middleware with a 500.
        return AuthorizeResult(
            enterprise_id=enterprise_id,
            team_id=team_id,
            bot_token=inst["bot_token"],
            bot_user_id=inst.get("bot_user_id"),
        )

    return authorize


# ---------------------------------------------------------------------------
# Rendering: runner events -> Slack
# ---------------------------------------------------------------------------

class SlackRenderer:
    """Owns the 'one message per answer' streaming UX:
    chunks edit a single message instead of flooding the thread.
    Multi-workspace: resolves a per-team bot token via token_resolver."""

    def __init__(self, token_resolver):
        self._resolve = token_resolver        # async (team_id) -> bot_token
        self._clients: dict[str, AsyncWebClient] = {}
        self._stream_ts: dict[str, str] = {}       # turn_id -> message ts
        self._buffer: dict[str, list[str]] = defaultdict(list)
        self._last_edit: dict[str, float] = defaultdict(float)
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    async def client_for(self, team_id: str) -> AsyncWebClient:
        if team_id not in self._clients:
            token = await self._resolve(team_id)
            self._clients[team_id] = AsyncWebClient(token=token)
        return self._clients[team_id]

    async def stream_chunk(self, turn: Turn, chunk: str) -> None:
        key = str(turn.turn_id)
        async with self._locks[key]:
            self._buffer[key].append(chunk)
            # Slack rate limit friendly: edit at most ~1x/sec.
            if time.monotonic() - self._last_edit[key] < 1.0:
                return
            self._last_edit[key] = time.monotonic()
            text = "".join(self._buffer[key])
            client = await self.client_for(turn.slack_team)
            if key in self._stream_ts:
                await client.chat_update(channel=turn.slack_channel,
                                         ts=self._stream_ts[key], text=text)
            else:
                res = await client.chat_postMessage(
                    channel=turn.slack_channel, thread_ts=turn.slack_thread_ts, text=text)
                self._stream_ts[key] = res["ts"]

    async def flush(self, turn: Turn) -> None:
        """Force-final edit when the task finishes."""
        key = str(turn.turn_id)
        async with self._locks[key]:
            if key in self._stream_ts and self._buffer[key]:
                client = await self.client_for(turn.slack_team)
                await client.chat_update(channel=turn.slack_channel,
                                         ts=self._stream_ts[key],
                                         text="".join(self._buffer[key]))

    async def post_status(self, turn: Turn, text: str) -> None:
        client = await self.client_for(turn.slack_team)
        await client.chat_postMessage(channel=turn.slack_channel,
                                      thread_ts=turn.slack_thread_ts, text=text)

    async def post_permission_request(self, turn: Turn, permission_id: Optional[str],
                                      description: str) -> Optional[str]:
        blocks = [
            {"type": "section", "text": {"type": "mrkdwn",
             "text": f":lock: Agent requests permission:\n*{description}*"}},
            {"type": "actions", "block_id": f"perm_{permission_id}", "elements": [
                {"type": "button", "text": {"type": "plain_text", "text": "Approve"},
                 "style": "primary", "action_id": "perm_approve",
                 "value": permission_id or ""},
                {"type": "button", "text": {"type": "plain_text", "text": "Deny"},
                 "style": "danger", "action_id": "perm_deny",
                 "value": permission_id or ""},
                {"type": "button", "text": {"type": "plain_text", "text": "Stop task"},
                 "action_id": "task_stop", "value": str(turn.turn_id)},
            ]},
        ]
        client = await self.client_for(turn.slack_team)
        res = await client.chat_postMessage(channel=turn.slack_channel,
                                            thread_ts=turn.slack_thread_ts,
                                            text=f"Permission: {description}",
                                            blocks=blocks)
        return res.get("ts")

    def cleanup(self, turn: Turn) -> None:
        """Drop per-turn streaming state once the turn is finished."""
        key = str(turn.turn_id)
        for store in (self._stream_ts, self._buffer, self._last_edit, self._locks):
            store.pop(key, None)

    async def post_result(self, turn: Turn, res: p.TurnResult) -> None:
        await self.flush(turn)
        emoji = {"done": ":white_check_mark:", "failed": ":x:", "cancelled": ":no_entry_sign:"}
        text = f"{emoji.get(res.status.value, ':question:')} Task {res.status.value}"
        if res.error:
            text += f"\n```{res.error}```"
        blocks = [
            {"type": "section", "text": {"type": "mrkdwn", "text": text}},
            {"type": "context", "elements": [{"type": "mrkdwn",
                "text": "Reply in this thread to continue the conversation."}]}
            if res.session_id else {"type": "context", "elements": []},
        ]
        client = await self.client_for(turn.slack_team)
        await client.chat_postMessage(channel=turn.slack_channel,
                                      thread_ts=turn.slack_thread_ts,
                                      text=text, blocks=[b for b in blocks if b])


# ---------------------------------------------------------------------------
# Ingestion: every Slack message -> OpenViking (batched)
# ---------------------------------------------------------------------------

class IngestionBuffer:
    """Batch messages per channel and flush to OpenViking resources."""

    def __init__(self, ov: OpenVikingClient, max_batch: int = 50, flush_secs: int = 300):
        self.ov = ov
        self.max_batch = max_batch
        self.flush_secs = flush_secs
        self._buf: dict[str, list[str]] = defaultdict(list)
        self._workspace: dict[str, str] = {}   # channel -> account_id
        self._seen: dict[str, float] = {}      # "channel:ts" -> monotonic
        self._task: Optional[asyncio.Task] = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._flush_loop())

    def add(self, workspace_id: str, channel: str, line: str,
            msg_ts: str = "") -> None:
        # With several of our bots in one channel the same message event
        # arrives once per bot — dedupe by (channel, ts).
        if msg_ts:
            key = f"{channel}:{msg_ts}"
            if key in self._seen:
                return
            self._seen[key] = time.monotonic()
            if len(self._seen) > 10000:
                cutoff = time.monotonic() - 3600
                self._seen = {k: v for k, v in self._seen.items() if v > cutoff}
        self._workspace[channel] = workspace_id
        self._buf[channel].append(line)
        if len(self._buf[channel]) >= self.max_batch:
            asyncio.create_task(self.flush_channel(channel))

    async def _flush_loop(self) -> None:
        while True:
            await asyncio.sleep(self.flush_secs)
            for ch in list(self._buf):
                await self.flush_channel(ch)

    async def flush_channel(self, channel: str) -> None:
        lines, self._buf[channel] = self._buf.get(channel, []), []
        if not lines:
            return
        ws = self._workspace.get(channel, "unknown")
        try:
            await self.ov.add_resource(
                account_id=ws,
                content="\n".join(lines),
                path=f"resources/slack/{channel}/{time.strftime('%Y-%m-%d')}.md",
                reason=f"Slack #{channel} archive",
            )
            log.info("ingested %d lines from #%s", len(lines), channel)
        except Exception:
            log.exception("ingestion failed for #%s — re-buffering", channel)
            self._buf[channel] = lines + self._buf[channel]


# ---------------------------------------------------------------------------
# Event handlers (registered in main.py once bolt is configured)
# ---------------------------------------------------------------------------

def register_handlers(app: AsyncApp, renderer: SlackRenderer,
                      ingestion: IngestionBuffer, default_cwd: str,
                      build_memory,
                      resolve_installation, resolve_member) -> None:

    @app.event("app_mention")
    async def on_mention(event, say, context):
        channel = event["channel"]
        thread_ts = event.get("thread_ts", event["ts"])
        prompt = event["text"]
        team_id = context["team_id"]

        # Runners register under the SaaS ovAccountId (runner.validate),
        # not the Slack team id — resolve the installation to bridge the
        # two id spaces before routing.
        try:
            workspace = (await resolve_installation(team_id))["ov_account_id"]
        except Exception:
            log.exception("installation resolve failed for %s", team_id)
            await say(text="This Slack workspace is not linked to a service "
                           "workspace. Reinstall the app from the dashboard.",
                      thread_ts=thread_ts)
            return

        # BYOA: the task runs on the mention author's own runner, under
        # their identity — never on a teammate's machine.
        author = event["user"]
        user_key = await resolve_member(team_id, author)
        if user_key is None:
            await say(text=f"<@{author}> I couldn't match you to a Farol "
                           "account. Sign in to the dashboard with your work "
                           "email, then mention me again.", thread_ts=thread_ts)
            return

        # Chat = the thread. First mention opens it and binds owner/cwd;
        # later mentions are new turns resuming the same ACP session.
        # Ownership is checked before anything else: a foreign author in
        # an owned thread is refused even if they have their own runner.
        # (slack_team stays the Slack team id: the renderer resolves the
        # bot token by team, not by OV account.)
        chat = router.get_chat(channel, thread_ts)
        if chat is not None and chat.user_key != user_key:
            await say(text=f"<@{author}> this conversation runs on its "
                           "starter's machine. Mention me in a new thread to "
                           "start your own.", thread_ts=thread_ts)
            return
        if chat is not None and chat.status == "running":
            await say(text="A turn is already running in this thread — press "
                           "Stop or wait for it to finish.", thread_ts=thread_ts)
            return

        runner = router.pick_runner(workspace, user_key=user_key)
        if runner is None:
            await say(text=f"<@{author}> you don't have a runner connected. "
                           "Install Farol Runner on your machine and connect "
                           "it with a token from the dashboard.",
                      thread_ts=thread_ts)
            return

        if chat is None:
            chat = router.open_chat(slack_team=team_id, channel=channel,
                                    thread_ts=thread_ts, workspace_id=workspace,
                                    user_key=user_key, cwd=default_cwd)

        # Memory scope = this channel only: the reply's audience is the
        # channel, so the agent must not read what this channel can't.
        memory = build_memory(workspace, user_key, channel)
        await router.start_turn(chat, runner, prompt, memory)

    @app.event("message")
    async def on_message(event, context):
        # Skip bot messages and mentions (mentions are tasks, handled above).
        if event.get("bot_id") or event.get("subtype"):
            return
        team_id = context["team_id"]
        try:
            account = (await resolve_installation(team_id))["ov_account_id"]
        except Exception:
            # No installation -> no tenant to attribute the message to.
            log.exception("dropping message for unresolved team %s", team_id)
            return
        line = f"[{event['ts']}] <{event.get('user', '?')}>: {event.get('text', '')}"
        ingestion.add(account, event["channel"], line, event["ts"])

        # Conversational follow-up: a plain reply in a thread whose chat
        # is idle continues the conversation (ACP session resume) on the
        # owner's runner. Only the owner drives their own machine.
        thread_ts = event.get("thread_ts")
        if not thread_ts:
            return
        chat = router.get_chat(event["channel"], thread_ts)
        if chat is None or chat.status != "idle" or chat.session_id is None:
            return
        author = event.get("user")
        author_key = await resolve_member(team_id, author) if author else None
        if author_key != chat.user_key:
            return
        runner = router.pick_runner(chat.workspace_id, user_key=chat.user_key)
        if runner is None:
            return
        memory = build_memory(chat.workspace_id, chat.user_key, chat.slack_channel)
        await router.start_turn(chat, runner, event.get("text", ""), memory)

    @app.action("perm_approve")
    async def approve(ack, action):
        await ack()
        await router.decide_permission(action["value"], approved=True)

    @app.action("perm_deny")
    async def deny(ack, action):
        await ack()
        await router.decide_permission(action["value"], approved=False)

    @app.action("task_stop")
    async def stop(ack, body, action):
        await ack()
        channel = body["channel"]["id"]
        thread_ts = body["message"].get("thread_ts", body["message"]["ts"])
        await router.cancel_by_thread(channel, thread_ts)

