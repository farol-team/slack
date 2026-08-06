"""Chat router: registry of connected runners plus the conversation
model. A Chat is a Slack thread bound to one member's runner and one
ACP session; a Turn is a single turn (prompt -> result) inside a chat.
The wire protocol stays turn-based — chats exist only cloud-side."""

from __future__ import annotations

import asyncio
import json
import os
import time
import httpx
import logging
from dataclasses import dataclass, field
from typing import Optional
from uuid import UUID, uuid4

from fastapi import WebSocket

from . import protocol as p

log = logging.getLogger("chat_router")


@dataclass
class Runner:
    """A connected thin client (one developer's machine)."""
    ws: WebSocket
    user_key: str            # OpenViking user key, resolved from token
    workspace_id: str
    agents: list[str] = field(default_factory=list)
    runner_version: str = ""
    runner_id: int = 0       # SaaS row id, for liveness reporting
    last_seen: float = field(default_factory=time.monotonic)
    last_touch: float = 0.0  # last lastSeenAt report to the SaaS


@dataclass
class Chat:
    """A Slack thread ↔ agent conversation. Long-lived: owns the ACP
    session id and the bindings a thread accumulates (owner, cwd, agent).
    BYOA: only the owner's runner ever executes turns of this chat."""
    chat_id: UUID
    slack_team: str
    slack_channel: str
    thread_ts: str
    workspace_id: str        # ovAccountId
    user_key: str            # owner = author of the first mention
    # Human names, passed to the runner so it can derive a working directory
    # a person recognises: ~/Farol/<workspace>/<channel>.
    workspace_name: str = ""
    channel_name: str = ""
    cwd: str = ""
    agent: str = ""
    session_id: Optional[str] = None
    status: str = "idle"     # idle | running
    current_turn_id: Optional[UUID] = None


@dataclass
class Turn:
    """One turn of a chat (wire protocol: one task)."""
    turn_id: UUID
    chat: Chat
    runner: Runner
    prompt: str
    # The message that asked: reactions land there, not on the thread root,
    # so a follow-up in a long thread marks itself and not the first mention.
    trigger_ts: str = ""
    # Files attached to the asking message: the runner fetches them through
    # the gateway, so Slack's private URLs and the bot token stay here.
    attachments: list = field(default_factory=list)
    status: str = "running"
    # permission_id -> (slack message ts, what was asked). The text is
    # kept so the buttons can be replaced by their outcome later.
    permission_msgs: dict[str, tuple[str, str]] = field(default_factory=dict)

    # The renderer and button handlers address tasks by their Slack
    # coordinates — proxy them from the chat.
    @property
    def slack_channel(self) -> str:
        return self.chat.slack_channel

    @property
    def slack_thread_ts(self) -> str:
        return self.chat.thread_ts

    @property
    def slack_team(self) -> str:
        return self.chat.slack_team


class ChatRouter:
    """Owns runner connections, chats and in-flight turns. In-memory for
    MVP; chats/turns are mirrored to the SaaS for persistence."""

    def __init__(self) -> None:
        self.runners: dict[str, Runner] = {}                 # token -> Runner
        self.chats: dict[tuple[str, str], Chat] = {}         # (channel, thread_ts)
        self.turns: dict[UUID, Turn] = {}                    # running turns

    # ---------- runner lifecycle ----------

    async def register(self, ws: WebSocket, hello: p.Hello) -> Optional[Runner]:
        """Authenticate runner token against the SaaS control plane
        (`runner.validate` tRPC procedure)."""
        saas_url = os.environ["FAROL_SAAS_URL"].rstrip("/")
        workspace_id = user_key = None

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                res = await client.get(
                    f"{saas_url}/api/trpc/runner.validate",
                    params={"input": json.dumps({"json": {
                        "token": hello.token,
                        "agents": hello.agents,
                        "version": hello.runner_version,
                    }})},
                )
            payload = res.json()
            data = payload.get("result", {}).get("data", {}).get("json", {})
            if data.get("valid"):
                workspace_id, user_key = data["workspaceId"], data["userKey"]
        except Exception:
            log.exception("SaaS token validation failed")

        if not workspace_id:
            await ws.send_text(encode(p.Error(code="auth_failed",
                                              message="invalid runner token")))
            return None

        runner = Runner(ws=ws, user_key=user_key, workspace_id=workspace_id,
                        agents=hello.agents, runner_version=hello.runner_version,
                        runner_id=data.get("runnerId", 0))
        self.runners[hello.token] = runner
        log.info("runner registered: ws=%s agents=%s", workspace_id, hello.agents)
        return runner

    async def unregister(self, runner: Runner, slack=None) -> None:
        """Drop a disconnected runner. Its running turns are orphaned:
        the thread is told, buffered stream tail is flushed, the chat
        goes idle so a later reply can retry."""
        for token, r in list(self.runners.items()):
            if r is runner:
                del self.runners[token]
        for turn in list(self.turns.values()):
            if turn.runner is runner and turn.status == "running":
                turn.status = "orphaned"
                turn.chat.status = "idle"
                turn.chat.current_turn_id = None
                self.turns.pop(turn.turn_id, None)
                self._mirror("chatSync.turn", {
                    "chatUuid": str(turn.chat.chat_id),
                    "turnUuid": str(turn.turn_id), "status": "orphaned",
                })
                if slack is not None:
                    try:
                        await slack.flush(turn)
                        await self._close_pending_permissions(
                            turn, slack, "the runner disconnected")
                        await slack.post_status(
                            turn, ":warning: Runner disconnected — the task "
                                  "was interrupted. Reply in this thread to "
                                  "retry once it reconnects.")
                        slack.cleanup(turn)
                    except Exception:
                        log.exception("orphan notify failed")
        log.info("runner unregistered: ws=%s", runner.workspace_id)

    def pick_runner(self, workspace_id: str, user_key: Optional[str] = None) -> Optional[Runner]:
        """Route a turn to a runner. BYOA: pass the author's user_key so
        the turn lands on their own runner only."""
        for r in self.runners.values():
            if r.workspace_id == workspace_id and (user_key is None or r.user_key == user_key):
                return r
        return None

    # ---------- SaaS mirror (fire-and-forget persistence) ----------

    @staticmethod
    def _mirror(procedure: str, payload: dict) -> None:
        """Persist a chat/turn event in the SaaS without blocking the
        hot path; a lost mirror write only degrades the dashboard."""
        async def send() -> None:
            try:
                saas_url = os.environ["FAROL_SAAS_URL"].rstrip("/")
                payload["secret"] = os.environ["INTERNAL_API_SECRET"]
                async with httpx.AsyncClient(timeout=10) as client:
                    for attempt in range(3):
                        res = await client.post(
                            f"{saas_url}/api/trpc/{procedure}",
                            json={"json": payload},
                            headers={"x-internal-secret":
                                     os.environ["INTERNAL_API_SECRET"]},
                        )
                        # These writes are fired independently, so a turn can
                        # reach the SaaS before the chat it belongs to. 404
                        # means "not yet" far more often than "never".
                        if res.status_code != 404 or attempt == 2:
                            if res.status_code >= 400:
                                log.warning("saas mirror %s -> %s", procedure,
                                            res.status_code)
                            return
                        await asyncio.sleep(0.5 * (attempt + 1))
            except Exception:
                log.warning("saas mirror %s failed", procedure)
        asyncio.create_task(send())

    # ---------- chat / turn lifecycle ----------

    def get_chat(self, channel: str, thread_ts: str) -> Optional[Chat]:
        return self.chats.get((channel, thread_ts))

    def open_chat(self, *, slack_team: str, channel: str, thread_ts: str,
                  workspace_id: str, user_key: str, cwd: str = "",
                  workspace_name: str = "", channel_name: str = "",
                  agent: str = "") -> Chat:
        chat = Chat(chat_id=uuid4(), slack_team=slack_team,
                    slack_channel=channel, thread_ts=thread_ts,
                    workspace_id=workspace_id, user_key=user_key,
                    workspace_name=workspace_name, channel_name=channel_name,
                    cwd=cwd, agent=agent)
        self.chats[(channel, thread_ts)] = chat
        self._mirror("chatSync.upsert", {
            "chatUuid": str(chat.chat_id), "ovAccountId": workspace_id,
            "ownerUserKey": user_key, "slackChannelId": channel,
            "threadTs": thread_ts,
        })
        return chat

    async def start_turn(self, chat: Chat, runner: Runner, prompt: str,
                         memory: Optional[p.MemoryConfig] = None,
                         trigger_ts: str = "",
                         attachments: Optional[list] = None) -> Turn:
        turn = Turn(turn_id=uuid4(), chat=chat, runner=runner, prompt=prompt,
                    trigger_ts=trigger_ts or chat.thread_ts,
                    attachments=attachments or [])
        self.turns[turn.turn_id] = turn
        chat.status = "running"
        chat.current_turn_id = turn.turn_id

        msg = p.AssignTurn(
            turn_id=turn.turn_id, slack_channel=chat.slack_channel,
            slack_thread_ts=chat.thread_ts, prompt=prompt,
            workspace_name=chat.workspace_name, channel_name=chat.channel_name,
            attachments=[
                p.Attachment(
                    name=a["name"], mime=a["mime"], size=a["size"],
                    url=f"{os.environ.get('FAROL_CLOUD_PUBLIC_URL', '').rstrip('/')}"
                        f"/files/{turn.turn_id}/{i}",
                )
                for i, a in enumerate(turn.attachments)
            ],
            agent=chat.agent or (runner.agents[0] if runner.agents else ""),
            cwd=chat.cwd, resume_session=chat.session_id, memory=memory,
        )
        await runner.ws.send_text(encode(msg))
        log.info("turn %s of chat %s (%s#%s)%s", turn.turn_id, chat.chat_id,
                 chat.slack_channel, chat.thread_ts,
                 " [resume]" if chat.session_id else "")
        self._mirror("chatSync.turn", {
            "chatUuid": str(chat.chat_id), "turnUuid": str(turn.turn_id),
            "status": "running", "prompt": prompt,
            "runnerId": runner.runner_id,
        })
        return turn

    async def on_turn_event(self, ev: p.TurnEvent, slack) -> None:
        """Render runner events into the Slack thread."""
        turn = self.turns.get(ev.turn_id)
        if not turn:
            return

        if ev.kind == p.TurnEventKind.agent_message_chunk:
            # Slack-friendly streaming: edit one message as chunks accumulate.
            await slack.stream_chunk(turn, ev.text)
        elif ev.kind in (p.TurnEventKind.tool_call, p.TurnEventKind.tool_call_update):
            # A tool call and its updates share one title, and an update that
            # changed only its status carries none. Both used to become their
            # own Slack message: one file write cost six.
            await slack.set_status(turn, ev.text)
        elif ev.kind == p.TurnEventKind.plan:
            await slack.post_status(turn, f":clipboard: plan:\n{ev.text}")
        elif ev.kind == p.TurnEventKind.permission_request:
            ts = await slack.post_permission_request(turn, ev.permission_id, ev.text)
            if ev.permission_id and ts:
                turn.permission_msgs[ev.permission_id] = (ts, ev.text)
        elif ev.kind == p.TurnEventKind.error:
            await slack.post_status(turn, f":warning: {ev.text}")

    async def on_turn_result(self, res: p.TurnResult, slack) -> None:
        # The turn is over: fold its outcome into the chat and drop the
        # in-flight entry — thread continuity lives on the Chat.
        turn = self.turns.pop(res.turn_id, None)
        if not turn:
            return
        turn.status = res.status.value
        chat = turn.chat
        if res.session_id:
            chat.session_id = res.session_id
        chat.status = "idle"
        chat.current_turn_id = None
        self._mirror("chatSync.turn", {
            "chatUuid": str(chat.chat_id), "turnUuid": str(turn.turn_id),
            "status": turn.status,
            **({"acpSessionId": res.session_id} if res.session_id else {}),
            **({"error": res.error} if res.error else {}),
        })
        await self._close_pending_permissions(turn, slack, "the turn finished")
        await slack.post_result(turn, res)
        slack.cleanup(turn)

    async def _close_pending_permissions(self, turn: Turn, slack, why: str) -> None:
        """A turn can end while its buttons are still on screen — the agent
        answered its own question, the runner timed it out, or the machine
        went away. Whatever the reason, the thread should stop offering a
        choice nobody will read."""
        if slack is None:
            return
        for permission_id, (ts, description) in list(turn.permission_msgs.items()):
            try:
                await slack.close_permission(
                    turn, ts, description, f":grey_question: No longer waiting — {why}")
            except Exception:
                log.exception("could not close permission %s", permission_id)
        turn.permission_msgs.clear()

    async def decide_permission(self, value: str, approved: bool,
                                decided_by: str = "", slack=None) -> bool:
        """Slack button -> runner. `value` is `<turn_id>:<permission_id>`: the
        permission id alone is the agent's JSON-RPC counter, which restarts at
        0 in every agent process, so a click in one thread could answer a
        request in another. Returns False when nothing is waiting any more —
        the turn ended, was cancelled, or the request already timed out."""
        turn_part, _, permission_id = value.rpartition(":")
        turn = None
        if turn_part:
            try:
                turn = self.turns.get(UUID(turn_part))
            except ValueError:
                turn = None
        else:
            # A button posted before this format existed. Best effort, and the
            # old ambiguity with it.
            permission_id = value
            turn = next((t for t in self.turns.values()
                         if permission_id in t.permission_msgs), None)

        if turn is None or permission_id not in turn.permission_msgs:
            log.info("permission %s no longer waiting", value)
            return False

        await turn.runner.ws.send_text(encode(p.PermissionDecision(
            turn_id=turn.turn_id, permission_id=permission_id, approved=approved)))
        ts, description = turn.permission_msgs.pop(permission_id)
        if slack is not None:
            who = f"<@{decided_by}>" if decided_by else "a teammate"
            outcome = (f":white_check_mark: Approved by {who}" if approved
                       else f":no_entry: Denied by {who}")
            await slack.close_permission(turn, ts, description, outcome)
        return True

    async def cancel_by_thread(self, channel: str, thread_ts: str) -> bool:
        chat = self.get_chat(channel, thread_ts)
        if not chat or not chat.current_turn_id:
            return False
        turn = self.turns.get(chat.current_turn_id)
        if not turn:
            return False
        await turn.runner.ws.send_text(encode(p.CancelTurn(turn_id=turn.turn_id)))
        return True


def encode(msg: p.CloudMessage) -> str:
    return msg.model_dump_json(exclude_none=True)


# Singleton for the process.
router = ChatRouter()
