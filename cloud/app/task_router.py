"""Chat router: registry of connected runners plus the conversation
model. A Chat is a Slack thread bound to one member's runner and one
ACP session; a Task is a single turn (prompt -> result) inside a chat.
The wire protocol stays task-based — chats exist only cloud-side."""

from __future__ import annotations

import asyncio
import json
import os
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
    cwd: str = ""
    agent: str = ""
    session_id: Optional[str] = None
    status: str = "idle"     # idle | running
    current_task_id: Optional[UUID] = None


@dataclass
class Task:
    """One turn of a chat."""
    task_id: UUID
    chat: Chat
    runner: Runner
    prompt: str
    status: str = "running"
    # permission_id -> slack message ts (to update the buttons)
    permission_msgs: dict[str, str] = field(default_factory=dict)

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
        self.tasks: dict[UUID, Task] = {}                    # running turns

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
                    params={"input": json.dumps({"json": {"token": hello.token}})},
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
                        agents=hello.agents, runner_version=hello.runner_version)
        self.runners[hello.token] = runner
        log.info("runner registered: ws=%s agents=%s", workspace_id, hello.agents)
        return runner

    def unregister(self, runner: Runner) -> None:
        for token, r in list(self.runners.items()):
            if r is runner:
                del self.runners[token]
        for task in list(self.tasks.values()):
            if task.runner is runner and task.status == "running":
                task.status = "orphaned"
                task.chat.status = "idle"
        log.info("runner unregistered: ws=%s", runner.workspace_id)

    def pick_runner(self, workspace_id: str, user_key: Optional[str] = None) -> Optional[Runner]:
        """Route a turn to a runner. BYOA: pass the author's user_key so
        the turn lands on their own runner only."""
        for r in self.runners.values():
            if r.workspace_id == workspace_id and (user_key is None or r.user_key == user_key):
                return r
        return None

    # ---------- chat / turn lifecycle ----------

    def get_chat(self, channel: str, thread_ts: str) -> Optional[Chat]:
        return self.chats.get((channel, thread_ts))

    def open_chat(self, *, slack_team: str, channel: str, thread_ts: str,
                  workspace_id: str, user_key: str, cwd: str,
                  agent: str = "") -> Chat:
        chat = Chat(chat_id=uuid4(), slack_team=slack_team,
                    slack_channel=channel, thread_ts=thread_ts,
                    workspace_id=workspace_id, user_key=user_key,
                    cwd=cwd, agent=agent)
        self.chats[(channel, thread_ts)] = chat
        return chat

    async def start_turn(self, chat: Chat, runner: Runner, prompt: str,
                         memory: Optional[p.MemoryConfig] = None) -> Task:
        task = Task(task_id=uuid4(), chat=chat, runner=runner, prompt=prompt)
        self.tasks[task.task_id] = task
        chat.status = "running"
        chat.current_task_id = task.task_id

        msg = p.AssignTask(
            task_id=task.task_id, slack_channel=chat.slack_channel,
            slack_thread_ts=chat.thread_ts, prompt=prompt,
            agent=chat.agent or (runner.agents[0] if runner.agents else ""),
            cwd=chat.cwd, resume_session=chat.session_id, memory=memory,
        )
        await runner.ws.send_text(encode(msg))
        log.info("turn %s of chat %s (%s#%s)%s", task.task_id, chat.chat_id,
                 chat.slack_channel, chat.thread_ts,
                 " [resume]" if chat.session_id else "")
        return task

    async def on_task_event(self, ev: p.TaskEvent, slack) -> None:
        """Render runner events into the Slack thread."""
        task = self.tasks.get(ev.task_id)
        if not task:
            return

        if ev.kind == p.TaskEventKind.agent_message_chunk:
            # Slack-friendly streaming: edit one message as chunks accumulate.
            await slack.stream_chunk(task, ev.text)
        elif ev.kind in (p.TaskEventKind.tool_call, p.TaskEventKind.tool_call_update):
            await slack.post_status(task, f":hammer_and_wrench: `{ev.text}`")
        elif ev.kind == p.TaskEventKind.plan:
            await slack.post_status(task, f":clipboard: plan:\n{ev.text}")
        elif ev.kind == p.TaskEventKind.permission_request:
            ts = await slack.post_permission_request(task, ev.permission_id, ev.text)
            if ev.permission_id and ts:
                task.permission_msgs[ev.permission_id] = ts
        elif ev.kind == p.TaskEventKind.error:
            await slack.post_status(task, f":warning: {ev.text}")

    async def on_task_result(self, res: p.TaskResult, slack) -> None:
        # The turn is over: fold its outcome into the chat and drop the
        # in-flight entry — thread continuity lives on the Chat.
        task = self.tasks.pop(res.task_id, None)
        if not task:
            return
        task.status = res.status.value
        chat = task.chat
        if res.session_id:
            chat.session_id = res.session_id
        chat.status = "idle"
        chat.current_task_id = None
        await slack.post_result(task, res)
        slack.cleanup(task)

    async def decide_permission(self, permission_id: str, approved: bool) -> None:
        """Slack button -> runner. Locate the turn that owns this permission."""
        for task in self.tasks.values():
            if permission_id in task.permission_msgs:
                await task.runner.ws.send_text(encode(p.PermissionDecision(
                    task_id=task.task_id, permission_id=permission_id, approved=approved)))
                del task.permission_msgs[permission_id]
                return
        log.warning("permission %s not found", permission_id)

    async def cancel_by_thread(self, channel: str, thread_ts: str) -> bool:
        chat = self.get_chat(channel, thread_ts)
        if not chat or not chat.current_task_id:
            return False
        task = self.tasks.get(chat.current_task_id)
        if not task:
            return False
        await task.runner.ws.send_text(encode(p.CancelTask(task_id=task.task_id)))
        return True


def encode(msg: p.CloudMessage) -> str:
    return msg.model_dump_json(exclude_none=True)


# Singleton for the process.
router = ChatRouter()
