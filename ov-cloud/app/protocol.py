"""Cloud-side mirror of ov-runner protocol.rs.

Every frame on wss://api.yourservice.io/runner/v1 is a `type`-tagged
envelope. Field names match the Rust serde representation exactly
(snake_case tags, camelCase-free) so the runner and cloud stay in sync.
"""

from __future__ import annotations

from enum import Enum
from typing import Literal, Optional, Union
from uuid import UUID

from pydantic import BaseModel, Field


# ---------- shared payloads ----------

class MemoryConfig(BaseModel):
    mcp_url: str
    user_key: str


class TaskEventKind(str, Enum):
    agent_message_chunk = "agent_message_chunk"
    tool_call = "tool_call"
    tool_call_update = "tool_call_update"
    plan = "plan"
    permission_request = "permission_request"
    error = "error"


class TaskStatus(str, Enum):
    done = "done"
    failed = "failed"
    cancelled = "cancelled"


# ---------- runner -> cloud ----------

class Hello(BaseModel):
    type: Literal["hello"] = "hello"
    token: str
    runner_version: str
    agents: list[str]
    os: str


class Ping(BaseModel):
    type: Literal["ping"] = "ping"


class TaskEvent(BaseModel):
    type: Literal["task_event"] = "task_event"
    task_id: UUID
    kind: TaskEventKind
    text: str
    permission_id: Optional[str] = None


class TaskResult(BaseModel):
    type: Literal["task_result"] = "task_result"
    task_id: UUID
    status: TaskStatus
    session_id: Optional[str] = None
    error: Optional[str] = None


# ---------- cloud -> runner ----------

class AssignTask(BaseModel):
    type: Literal["assign_task"] = "assign_task"
    task_id: UUID
    slack_channel: str
    slack_thread_ts: str
    prompt: str
    agent: str
    cwd: str
    resume_session: Optional[str] = None
    memory: Optional[MemoryConfig] = None


class PermissionDecision(BaseModel):
    type: Literal["permission_decision"] = "permission_decision"
    task_id: UUID
    permission_id: str
    approved: bool


class CancelTask(BaseModel):
    type: Literal["cancel_task"] = "cancel_task"
    task_id: UUID


class Pong(BaseModel):
    type: Literal["pong"] = "pong"


class Error(BaseModel):
    type: Literal["error"] = "error"
    code: str
    message: str


# ---------- envelope union ----------

RunnerMessage = Union[Hello, Ping, TaskEvent, TaskResult]
CloudMessage = Union[AssignTask, PermissionDecision, CancelTask, Pong, Error]


def parse_runner_message(raw: dict) -> RunnerMessage:
    """Dispatch inbound runner frame by its `type` tag."""
    tag = raw.get("type")
    models = {
        "hello": Hello,
        "ping": Ping,
        "task_event": TaskEvent,
        "task_result": TaskResult,
    }
    model = models.get(tag)
    if model is None:
        raise ValueError(f"unknown runner message type: {tag}")
    return model.model_validate(raw)


class CloudOutbound(BaseModel):
    """Serializable outbound frame helper."""
    message: CloudMessage

    def dump(self) -> str:
        return self.message.model_dump_json(exclude_none=True)


def encode(msg: CloudMessage) -> str:
    return msg.model_dump_json(exclude_none=True)
