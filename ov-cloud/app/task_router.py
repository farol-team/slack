"""Task router: registry of connected runners, task lifecycle,
and the Slack thread <-> task <-> ACP session mapping."""

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

log = logging.getLogger("task_router")


@dataclass
class Runner:
    """A connected thin client (one developer's machine)."""
    ws: WebSocket
    user_key: str            # OpenViking user key, resolved from token
    workspace_id: str
    agents: list[str] = field(default_factory=list)
    runner_version: str = ""


@dataclass
class Task:
    task_id: UUID
    runner: Runner
    slack_channel: str
    slack_thread_ts: str
    prompt: str
    slack_team: str = ""
    session_id: Optional[str] = None
    status: str = "running"
    # permission_id -> slack message ts (to update the buttons)
    permission_msgs: dict[str, str] = field(default_factory=dict)


class TaskRouter:
    """Owns runner connections and task state. In-memory for MVP;
    swap for Postgres + Redis streams in production."""

    def __init__(self) -> None:
        self.runners: dict[str, Runner] = {}          # token -> Runner
        self.tasks: dict[UUID, Task] = {}             # task_id -> Task
        self.thread_index: dict[tuple[str, str], UUID] = {}  # (channel, ts) -> task

    # ---------- runner lifecycle ----------

    async def register(self, ws: WebSocket, hello: p.Hello) -> Optional[Runner]:
        """Authenticate runner token against the SaaS control plane.
        Calls `runner.validate` tRPC procedure; falls back to the legacy
        `ovr_{workspace}_{userkey}` format when OV_SAAS_URL is unset (dev)."""
        saas_url = os.getenv("OV_SAAS_URL", "").rstrip("/")
        workspace_id = user_key = None

        if saas_url:
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
        else:
            parts = hello.token.split("_", 2)
            if hello.token.startswith("ovr_") and len(parts) == 3:
                _, workspace_id, user_key = parts

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
        for task in self.tasks.values():
            if task.runner is runner and task.status == "running":
                task.status = "orphaned"
        log.info("runner unregistered: ws=%s", runner.workspace_id)

    def pick_runner(self, workspace_id: str, user_key: Optional[str] = None) -> Optional[Runner]:
        """Route a Slack task to a runner. MVP: the workspace owner's runner;
        production: route by the Slack user who mentioned the bot."""
        for r in self.runners.values():
            if r.workspace_id == workspace_id and (user_key is None or r.user_key == user_key):
                return r
        return None

    # ---------- task lifecycle ----------

    async def assign(self, runner: Runner, channel: str, thread_ts: str,
                     prompt: str, cwd: str, agent: str = "",
                     mcp_url: Optional[str] = None,
                     resume_session: Optional[str] = None,
                     slack_team: str = "") -> Task:
        task = Task(task_id=uuid4(), runner=runner, slack_channel=channel,
                    slack_thread_ts=thread_ts, prompt=prompt, slack_team=slack_team)
        self.tasks[task.task_id] = task
        self.thread_index[(channel, thread_ts)] = task.task_id

        memory = p.MemoryConfig(mcp_url=mcp_url, user_key=runner.user_key) if mcp_url else None
        msg = p.AssignTask(
            task_id=task.task_id, slack_channel=channel, slack_thread_ts=thread_ts,
            prompt=prompt, agent=agent or (runner.agents[0] if runner.agents else ""),
            cwd=cwd, resume_session=resume_session, memory=memory,
        )
        await runner.ws.send_text(encode(msg))
        log.info("task %s assigned (%s in #%s)", task.task_id, agent, channel)
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
        task = self.tasks.get(res.task_id)
        if not task:
            return
        task.status = res.status.value
        task.session_id = res.session_id
        await slack.post_result(task, res)

    async def decide_permission(self, permission_id: str, approved: bool) -> None:
        """Slack button -> runner. Locate the task that owns this permission.
        Newest first: ACP request ids restart from 0 in each agent process,
        so stale tasks collide; also skip tasks whose runner is gone."""
        for task in reversed(list(self.tasks.values())):
            if permission_id in task.permission_msgs \
                    and task.runner in self.runners.values():
                await task.runner.ws.send_text(encode(p.PermissionDecision(
                    task_id=task.task_id, permission_id=permission_id, approved=approved)))
                del task.permission_msgs[permission_id]
                return
        log.warning("permission %s not found", permission_id)

    async def cancel_by_thread(self, channel: str, thread_ts: str) -> bool:
        task_id = self.thread_index.get((channel, thread_ts))
        task = self.tasks.get(task_id) if task_id else None
        if not task:
            return False
        await task.runner.ws.send_text(encode(p.CancelTask(task_id=task.task_id)))
        return True


def encode(msg: p.CloudMessage) -> str:
    return msg.model_dump_json(exclude_none=True)


# Singleton for the process.
router = TaskRouter()
