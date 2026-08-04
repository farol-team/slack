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
from .task_router import Task, router

log = logging.getLogger("slack_app")

def create_bolt(signing_secret: str, authorize_fn, fallback_token: str = "") -> AsyncApp:
    """Build the Bolt app with multi-workspace authorize."""
    if fallback_token:
        return AsyncApp(signing_secret=signing_secret, token=fallback_token)
    return AsyncApp(signing_secret=signing_secret, authorize=authorize_fn)


def make_installation_resolver(saas_url: str, internal_secret: str,
                               fallback_token: str = "", fallback_account: str = ""):
    """Resolve Slack team -> SaaS installation {bot_token, ov_account_id}.
    Cached per team. Fallback covers single-workspace dev mode."""
    cache: dict[str, dict] = {}

    async def resolve(team_id: str) -> dict:
        if team_id in cache:
            return cache[team_id]
        inst = None
        if saas_url and internal_secret and team_id:
            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    res = await client.get(
                        f"{saas_url}/api/trpc/slack.installationByTeam",
                        params={"input": json.dumps({"json": {"teamId": team_id}})},
                        headers={"x-internal-secret": internal_secret},
                    )
                data = res.json().get("result", {}).get("data", {}).get("json", {})
                if data.get("botToken"):
                    inst = {
                        "bot_token": data["botToken"],
                        "ov_account_id": data.get("ovAccountId") or team_id,
                    }
            except Exception:
                log.exception("installationByTeam failed for %s", team_id)
        if inst is None and fallback_token:
            inst = {"bot_token": fallback_token,
                    "ov_account_id": fallback_account or team_id}
        if inst is None:
            raise RuntimeError(f"no installation for team {team_id}")
        cache[team_id] = inst
        return inst

    return resolve


def make_authorize(saas_url: str, internal_secret: str, fallback_token: str,
                   fallback_account: str = ""):
    """Multi-workspace authorize for Bolt, built on the installation resolver."""
    resolve = make_installation_resolver(saas_url, internal_secret,
                                         fallback_token, fallback_account)

    async def authorize(enterprise_id, team_id, user_id=None, **kwargs):
        inst = await resolve(team_id)
        return AuthorizeResult(bot_token=inst["bot_token"])

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
        self._stream_ts: dict[str, str] = {}       # task_id -> message ts
        self._buffer: dict[str, list[str]] = defaultdict(list)
        self._last_edit: dict[str, float] = defaultdict(float)
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    async def client_for(self, team_id: str) -> AsyncWebClient:
        if team_id not in self._clients:
            token = await self._resolve(team_id)
            self._clients[team_id] = AsyncWebClient(token=token)
        return self._clients[team_id]

    async def stream_chunk(self, task: Task, chunk: str) -> None:
        key = str(task.task_id)
        async with self._locks[key]:
            self._buffer[key].append(chunk)
            # Slack rate limit friendly: edit at most ~1x/sec.
            if time.monotonic() - self._last_edit[key] < 1.0:
                return
            self._last_edit[key] = time.monotonic()
            text = "".join(self._buffer[key])
            client = await self.client_for(task.slack_team)
            if key in self._stream_ts:
                await client.chat_update(channel=task.slack_channel,
                                         ts=self._stream_ts[key], text=text)
            else:
                res = await client.chat_postMessage(
                    channel=task.slack_channel, thread_ts=task.slack_thread_ts, text=text)
                self._stream_ts[key] = res["ts"]

    async def flush(self, task: Task) -> None:
        """Force-final edit when the task finishes."""
        key = str(task.task_id)
        async with self._locks[key]:
            if key in self._stream_ts and self._buffer[key]:
                client = await self.client_for(task.slack_team)
                await client.chat_update(channel=task.slack_channel,
                                         ts=self._stream_ts[key],
                                         text="".join(self._buffer[key]))

    async def post_status(self, task: Task, text: str) -> None:
        client = await self.client_for(task.slack_team)
        await client.chat_postMessage(channel=task.slack_channel,
                                      thread_ts=task.slack_thread_ts, text=text)

    async def post_permission_request(self, task: Task, permission_id: Optional[str],
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
                 "action_id": "task_stop", "value": str(task.task_id)},
            ]},
        ]
        client = await self.client_for(task.slack_team)
        res = await client.chat_postMessage(channel=task.slack_channel,
                                            thread_ts=task.slack_thread_ts,
                                            text=f"Permission: {description}",
                                            blocks=blocks)
        return res.get("ts")

    async def post_result(self, task: Task, res: p.TaskResult) -> None:
        await self.flush(task)
        emoji = {"done": ":white_check_mark:", "failed": ":x:", "cancelled": ":no_entry_sign:"}
        text = f"{emoji.get(res.status.value, ':question:')} Task {res.status.value}"
        if res.error:
            text += f"\n```{res.error}```"
        blocks = [
            {"type": "section", "text": {"type": "mrkdwn", "text": text}},
            {"type": "actions", "elements": [
                {"type": "button", "text": {"type": "plain_text", "text": "Resume session"},
                 "action_id": "task_resume", "value": str(task.task_id)},
            ]} if res.session_id else {"type": "context", "elements": []},
        ]
        client = await self.client_for(task.slack_team)
        await client.chat_postMessage(channel=task.slack_channel,
                                      thread_ts=task.slack_thread_ts,
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
        self._task: Optional[asyncio.Task] = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._flush_loop())

    def add(self, workspace_id: str, channel: str, line: str) -> None:
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
                      memory_mcp_url: Optional[str],
                      resolve_installation=None) -> None:

    @app.event("app_mention")
    async def on_mention(event, say, context):
        channel = event["channel"]
        thread_ts = event.get("thread_ts", event["ts"])
        prompt = event["text"]
        workspace = context.get("team_id", "default")

        runner = router.pick_runner(workspace)
        if runner is None:
            await say(text="No runner connected. Install OV Runner on your machine "
                           "and connect it to this workspace.", thread_ts=thread_ts)
            return

        await router.assign(runner=runner, channel=channel, thread_ts=thread_ts,
                            prompt=prompt, cwd=default_cwd,
                            mcp_url=memory_mcp_url,
                            slack_team=workspace)

    @app.event("message")
    async def on_message(event, context):
        # Skip bot messages and mentions (mentions are tasks, handled above).
        if event.get("bot_id") or event.get("subtype"):
            return
        team_id = context.get("team_id", "default")
        account = team_id
        if resolve_installation:
            try:
                account = (await resolve_installation(team_id))["ov_account_id"]
            except Exception:
                pass
        line = f"[{event['ts']}] <{event.get('user', '?')}>: {event.get('text', '')}"
        ingestion.add(account, event["channel"], line)

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

    @app.action("task_resume")
    async def resume(ack, action, body, context):
        await ack()
        # Follow-up message in the same thread resumes the ACP session —
        # the runner sends session/load with the stored session_id.
        task_id = action["value"]
        log.info("resume requested for task %s (prompt via next thread message)", task_id)
