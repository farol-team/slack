"""Slack surface: Events API handlers, Block Kit rendering,
and the message-ingestion buffer feeding OpenViking."""

from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import datetime, timezone
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
            "team_name": data.get("teamName") or "",
            "store_files": data.get("storeFiles", True),
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


def make_channel_name_resolver(resolve_installation):
    """Slack channel id -> its name, asked once per channel and kept.
    The runner turns it into a directory a person recognises."""
    cache: dict[tuple[str, str], str] = {}

    async def resolve(team_id: str, channel_id: str) -> str:
        key = (team_id, channel_id)
        if key in cache:
            return cache[key]
        try:
            inst = await resolve_installation(team_id)
            info = await AsyncWebClient(token=inst["bot_token"]).conversations_info(
                channel=channel_id)
            name = (info["channel"] or {}).get("name") or ""
        except Exception:
            log.exception("conversations_info failed for %s", channel_id)
            return ""
        if name:
            cache[key] = name
        return name

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

    async def react(self, turn: Turn, name: str, add: bool = True) -> None:
        """Mark the message that asked. Best-effort: a workspace that has not
        granted `reactions:write` still gets its answer, just without the
        marks — an emoji is not worth failing a turn over."""
        if not turn.trigger_ts:
            return
        try:
            client = await self.client_for(turn.slack_team)
            call = client.reactions_add if add else client.reactions_remove
            await call(channel=turn.slack_channel, timestamp=turn.trigger_ts,
                       name=name)
        except Exception as e:
            log.info("reaction %s %s failed: %s", "add" if add else "remove",
                     name, e)

    async def post_result(self, turn: Turn, res: p.TurnResult) -> None:
        await self.flush(turn)
        await self.react(turn, "eyes", add=False)
        if res.status.value == "done":
            # The answer is the result; a line saying so is noise.
            await self.react(turn, "white_check_mark")
            return
        emoji = {"failed": ":x:", "cancelled": ":no_entry_sign:"}
        text = f"{emoji.get(res.status.value, ':question:')} Task {res.status.value}"
        if res.error:
            text += f"\n```{res.error}```"
        client = await self.client_for(turn.slack_team)
        await client.chat_postMessage(channel=turn.slack_channel,
                                      thread_ts=turn.slack_thread_ts, text=text)


# ---------------------------------------------------------------------------
# Ingestion: every Slack message -> OpenViking (batched)
# ---------------------------------------------------------------------------

async def _mirror_file(account: str, channel: str, file_id: str, name: str,
                       mime: str, size: int, uri: str) -> None:
    """Record an imported file in the SaaS. OpenViking lists an imported
    resource as a 0-byte directory, so a dashboard that wants to say how much
    was stored has to be told; the record also turns a Slack deletion into
    one lookup instead of a walk of every channel."""
    try:
        saas = os.environ["FAROL_SAAS_URL"].rstrip("/")
        secret = os.environ["INTERNAL_API_SECRET"]
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"{saas}/api/trpc/memory.fileImported",
                json={"json": {"ovAccountId": account, "slackChannelId": channel,
                               "slackFileId": file_id, "name": name, "mime": mime,
                               "bytes": size, "uri": uri, "secret": secret}},
                headers={"x-internal-secret": secret})
    except Exception:
        log.warning("recording file %s in the SaaS failed", name)


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

    # A cap, not a taste: every import costs embeddings, and media costs a
    # vision model on top. Twenty megabytes is a generous document and a
    # ridiculous screenshot.
    MAX_FILE_BYTES = 20 * 1024 * 1024

    async def add_file(self, workspace_id: str, channel: str, f: dict,
                       bot_token: str, author: str) -> Optional[str]:
        """Put a shared file into the channel's memory. OpenViking reads it —
        text, PDF, image alike — so what lands is searchable content, not a
        note that a file once existed."""
        name = f.get("name") or f.get("id") or "file"
        size = int(f.get("size") or 0)
        if size > self.MAX_FILE_BYTES:
            log.info("skipping %s: %s bytes over the limit", name, size)
            return None

        try:
            async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
                res = await client.get(
                    f["url_private"],
                    headers={"Authorization": f"Bearer {bot_token}"})
            res.raise_for_status()
        except Exception:
            log.exception("file download failed: %s", name)
            return None

        # The Slack file id makes the name unique: OpenViking keys the
        # resource off the file name, and two `design.pdf` from two channels
        # must not collide in one flat namespace.
        file_id = f.get("id") or re.sub(r"[^A-Za-z0-9]+", "", name)[:12]
        safe = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or "file"
        try:
            uri = await self.ov.import_file(
                workspace_id, f"{file_id}-{safe}", res.content,
                f.get("mimetype") or "", f"resources/slack/{channel}/files",
                reason=f"shared by {author} in Slack channel {channel}")
        except Exception:
            log.exception("import failed: %s", name)
            return None
        if uri:
            log.info("file in memory: %s -> %s", name, uri)
            await _mirror_file(workspace_id, channel, file_id, name,
                               f.get("mimetype") or "", size, uri)
        return uri

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
                      ingestion: IngestionBuffer, build_memory,
                      resolve_installation, resolve_member) -> None:
    resolve_channel_name = make_channel_name_resolver(resolve_installation)

    async def dispatch(event, say, context, *, prompt: str,
                       channel_name: Optional[str] = None) -> None:
        """One path for both ways of asking: a mention in a channel and a
        direct message. Everything after 'who asked' is identical."""
        channel = event["channel"]
        thread_ts = event.get("thread_ts", event["ts"])
        team_id = context["team_id"]

        # Runners register under the SaaS ovAccountId (runner.validate),
        # not the Slack team id — resolve the installation to bridge the
        # two id spaces before routing.
        try:
            inst = await resolve_installation(team_id)
            workspace = inst["ov_account_id"]
        except Exception:
            log.exception("installation resolve failed for %s", team_id)
            await say(text="This Slack workspace is not linked to a service "
                           "workspace. Reinstall the app from the dashboard.",
                      thread_ts=thread_ts)
            return

        # BYOA: the task runs on the author's own runner, under their
        # identity — never on a teammate's machine.
        author = event["user"]
        user_key = await resolve_member(team_id, author)
        if user_key is None:
            await say(text=f"<@{author}> I couldn't match you to a Farol "
                           "account. Sign in to the dashboard with your work "
                           "email, then mention me again.", thread_ts=thread_ts)
            return

        # Chat = the thread. The first message opens it and binds owner/cwd;
        # later ones are new turns resuming the same ACP session. Ownership
        # is checked before anything else: a foreign author in an owned
        # thread is refused even if they have their own runner.
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
                           "Install Farol Runner from the dashboard and press "
                           "Connect to Slack.", thread_ts=thread_ts)
            return

        if chat is None:
            # Names, not ids: the runner builds ~/Farol/<workspace>/<channel>
            # out of them. cwd stays empty — only the machine knows what
            # directories it has.
            name = (channel_name if channel_name is not None
                    else await resolve_channel_name(team_id, channel))
            chat = router.open_chat(
                slack_team=team_id, channel=channel, thread_ts=thread_ts,
                workspace_id=workspace, user_key=user_key,
                workspace_name=inst.get("team_name") or "", channel_name=name)

        # Memory scope = this conversation only: the reply's audience is the
        # channel (or the DM), so the agent must not read what it cannot see.
        memory = build_memory(workspace, user_key, channel)
        attachments = await collect_attachments(event, team_id)
        turn = await router.start_turn(chat, runner, prompt, memory,
                                       trigger_ts=event["ts"],
                                       attachments=attachments)
        # The machine has it: say so on the message that asked, before the
        # agent has anything to show.
        await renderer.react(turn, "eyes")

    async def collect_attachments(event, team_id: str) -> list[dict]:
        """What was attached to the question. The bytes stay here: the runner
        fetches them through the gateway with the task token it already has,
        so the bot token never leaves the cloud."""
        files = event.get("files") or []
        out = []
        for f in files:
            if not f.get("url_private"):
                continue
            out.append({
                "name": f.get("name") or f.get("id") or "attachment",
                "mime": f.get("mimetype") or "application/octet-stream",
                "size": int(f.get("size") or 0),
                "url_private": f["url_private"],
                "team_id": team_id,
            })
        return out

    @app.event("app_mention")
    async def on_mention(event, say, context):
        await dispatch(event, say, context, prompt=event["text"])

    @app.event("message")
    async def on_message(event, say, context):
        # Skip bot messages and mentions (mentions are tasks, handled above).
        # A file upload is a message with subtype `file_share`: it carries the
        # files people want remembered, so it is the one subtype we keep.
        subtype = event.get("subtype")
        if event.get("bot_id") or (subtype and subtype != "file_share"):
            return

        # A DM is a task without ceremony: no mention needed, and nothing of
        # it goes into team memory — a private conversation is scoped to
        # itself, and the channel archive belongs to the channel.
        if event.get("channel_type") == "im":
            await dispatch(event, say, context,
                           prompt=event.get("text", ""), channel_name="dm")
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

        # Files shared in a channel belong to the channel's memory: text as
        # itself, everything else as a record of what exists and where.
        files = event.get("files") or []
        if files:
            try:
                inst = await resolve_installation(team_id)
            except Exception:
                log.exception("no installation for files in %s", team_id)
                inst = {}
            # A workspace may forbid copies of its files; the text of the
            # conversation is a separate decision, already made above.
            if inst.get("store_files", True) and inst.get("bot_token"):
                for f in files:
                    if f.get("url_private"):
                        await ingestion.add_file(account, event["channel"], f,
                                                 inst["bot_token"],
                                                 event.get("user", "?"))

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
        turn = await router.start_turn(chat, runner, event.get("text", ""), memory,
                                       trigger_ts=event["ts"])
        await renderer.react(turn, "eyes")

    @app.event("file_deleted")
    async def on_file_deleted(event, context):
        """What Slack forgets, memory forgets. The SaaS knows where the copy
        landed, so this is one lookup rather than a walk of every channel."""
        file_id = event.get("file_id")
        if not file_id:
            return
        team_id = context["team_id"]
        try:
            account = (await resolve_installation(team_id))["ov_account_id"]
            saas = os.environ["FAROL_SAAS_URL"].rstrip("/")
            secret = os.environ["INTERNAL_API_SECRET"]
            async with httpx.AsyncClient(timeout=10) as client:
                res = await client.post(
                    f"{saas}/api/trpc/memory.fileDeleted",
                    json={"json": {"slackFileId": file_id, "secret": secret}},
                    headers={"x-internal-secret": secret})
            uri = (((res.json() or {}).get("result") or {})
                   .get("data", {}).get("json", {}).get("uri"))
        except Exception:
            log.exception("file_deleted: lookup failed for %s", file_id)
            return
        if not uri:
            return
        ok = await ingestion.ov.delete_uri(account, uri)
        log.info("file_deleted: %s removed=%s", uri, ok)

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

