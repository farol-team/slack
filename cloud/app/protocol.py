"""Cloud-side mirror of runner protocol.rs.

Every frame on wss://api.farol.team/runner/v1 is a `type`-tagged
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


class TurnEventKind(str, Enum):
    agent_message_chunk = "agent_message_chunk"
    tool_call = "tool_call"
    tool_call_update = "tool_call_update"
    plan = "plan"
    permission_request = "permission_request"
    error = "error"


class TurnStatus(str, Enum):
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


class TurnEvent(BaseModel):
    type: Literal["turn_event"] = "turn_event"
    turn_id: UUID
    kind: TurnEventKind
    text: str
    permission_id: Optional[str] = None


class TurnResult(BaseModel):
    type: Literal["turn_result"] = "turn_result"
    turn_id: UUID
    status: TurnStatus
    session_id: Optional[str] = None
    error: Optional[str] = None


# ---------- cloud -> runner ----------

class AssignTurn(BaseModel):
    type: Literal["assign_turn"] = "assign_turn"
    turn_id: UUID
    slack_channel: str
    slack_thread_ts: str
    # Human names, for the working directory the runner derives:
    # ~/Farol/<workspace>/<channel>. Empty when Slack would not tell us.
    workspace_name: str = ""
    channel_name: str = ""
    prompt: str
    agent: str
    # Explicit override. Empty means the runner derives its own path from the
    # names above — it is the only side that knows what exists on that machine.
    cwd: str = ""
    resume_session: Optional[str] = None
    memory: Optional[MemoryConfig] = None


class PermissionDecision(BaseModel):
    type: Literal["permission_decision"] = "permission_decision"
    turn_id: UUID
    permission_id: str
    approved: bool


class CancelTurn(BaseModel):
    type: Literal["cancel_turn"] = "cancel_turn"
    turn_id: UUID


class Pong(BaseModel):
    type: Literal["pong"] = "pong"


class Error(BaseModel):
    type: Literal["error"] = "error"
    code: str
    message: str


# ---------- envelope union ----------

RunnerMessage = Union[Hello, Ping, TurnEvent, TurnResult]
CloudMessage = Union[AssignTurn, PermissionDecision, CancelTurn, Pong, Error]


def parse_runner_message(raw: dict) -> RunnerMessage:
    """Dispatch inbound runner frame by its `type` tag."""
    tag = raw.get("type")
    models = {
        "hello": Hello,
        "ping": Ping,
        "turn_event": TurnEvent,
        "turn_result": TurnResult,
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
