//! Cloud protocol: messages exchanged between the runner and the SaaS
//! over a single outbound WebSocket (wss://api.farol.team/runner/v1).
//!
//! Direction: the runner always dials out — no open ports on the client.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Envelope for every frame on the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CloudMessage {
    // ---- runner -> cloud ----
    /// First frame after connect: authenticate + announce capabilities.
    Hello(Hello),
    /// Heartbeat, every ~30s.
    Ping,
    /// Streaming chunk of the agent's answer for a turn (mapped to a Slack thread).
    TurnEvent(TurnEvent),
    /// Terminal state of a turn.
    TurnResult(TurnResult),
    /// User decision on a permission request (relayed FROM Slack via cloud),
    /// answered back to the ACP agent.
    // ---- cloud -> runner ----
    /// New turn created by a Slack mention / DM.
    AssignTurn(AssignTurn),
    /// Slack user pressed Approve/Deny — resolves a pending permission.
    PermissionDecision(PermissionDecision),
    /// Cancel a running turn (Stop button / ❌ reaction).
    CancelTurn { turn_id: Uuid },
    Pong,
    /// Fatal: auth rejected, runner should stop and re-login.
    Error { code: String, message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hello {
    pub token: String,
    /// Also sent as `x-farol-runner-version` on the WS handshake (see
    /// `cloud::handshake_request`) — the cloud falls back to the header
    /// when this is empty.
    #[serde(default)]
    pub runner_version: String,
    /// Agents available locally, e.g. ["claude-code", "gemini"].
    pub agents: Vec<String>,
    /// Also sent as `x-farol-runner-os` on the handshake.
    #[serde(default)]
    pub os: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssignTurn {
    pub turn_id: Uuid,
    /// Slack thread this turn is bound to (cloud owns the mapping).
    pub slack_channel: String,
    pub slack_thread_ts: String,
    /// Human names behind those ids: the runner derives
    /// ~/Farol/<workspace>/<channel> from them. Empty when Slack withheld them.
    #[serde(default)]
    pub workspace_name: String,
    #[serde(default)]
    pub channel_name: String,
    /// Prompt text from the Slack user.
    pub prompt: String,
    /// Which agent to run (cloud may route by user's choice).
    pub agent: String,
    /// Explicit project directory. Empty means the runner decides — it is the
    /// only side that knows what exists on this machine. Allowlisted either way.
    #[serde(default)]
    pub cwd: String,
    /// Optional ACP session id to resume.
    #[serde(default)]
    pub resume_session: Option<String>,
    /// Memory endpoint config injected by the cloud (OpenViking MCP).
    pub memory: Option<MemoryConfig>,
    /// Files attached to the asking message. Fetched from the cloud gateway
    /// with the task token, never from Slack directly.
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryConfig {
    pub mcp_url: String,
    pub user_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnEvent {
    pub turn_id: Uuid,
    pub kind: TurnEventKind,
    /// Text chunk / tool name / permission description.
    pub text: String,
    /// For permission events: cloud renders Approve/Deny buttons with this id.
    #[serde(default)]
    pub permission_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnEventKind {
    AgentMessageChunk,
    ToolCall,
    ToolCallUpdate,
    Plan,
    PermissionRequest,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnResult {
    pub turn_id: Uuid,
    pub status: TurnStatus,
    /// ACP session id — cloud stores it to offer "resume" later.
    pub session_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionDecision {
    pub turn_id: Uuid,
    pub permission_id: String,
    pub approved: bool,
}
