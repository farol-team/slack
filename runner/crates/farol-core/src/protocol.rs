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
    /// Streaming chunk of the agent's answer for a task (mapped to a Slack thread).
    TaskEvent(TaskEvent),
    /// Terminal state of a task.
    TaskResult(TaskResult),
    /// User decision on a permission request (relayed FROM Slack via cloud),
    /// answered back to the ACP agent.
    // ---- cloud -> runner ----
    /// New task created by a Slack mention / DM.
    AssignTask(AssignTask),
    /// Slack user pressed Approve/Deny — resolves a pending permission.
    PermissionDecision(PermissionDecision),
    /// Cancel a running task (Stop button / ❌ reaction).
    CancelTask { task_id: Uuid },
    Pong,
    /// Fatal: auth rejected, runner should stop and re-login.
    Error { code: String, message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hello {
    pub token: String,
    pub runner_version: String,
    /// Agents available locally, e.g. ["claude-code", "gemini"].
    pub agents: Vec<String>,
    pub os: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssignTask {
    pub task_id: Uuid,
    /// Slack thread this task is bound to (cloud owns the mapping).
    pub slack_channel: String,
    pub slack_thread_ts: String,
    /// Prompt text from the Slack user.
    pub prompt: String,
    /// Which agent to run (cloud may route by user's choice).
    pub agent: String,
    /// Project directory the agent should work in (must be allowlisted locally).
    pub cwd: String,
    /// Optional ACP session id to resume.
    #[serde(default)]
    pub resume_session: Option<String>,
    /// Memory endpoint config injected by the cloud (OpenViking MCP).
    pub memory: Option<MemoryConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryConfig {
    pub mcp_url: String,
    pub user_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskEvent {
    pub task_id: Uuid,
    pub kind: TaskEventKind,
    /// Text chunk / tool name / permission description.
    pub text: String,
    /// For permission events: cloud renders Approve/Deny buttons with this id.
    #[serde(default)]
    pub permission_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskEventKind {
    AgentMessageChunk,
    ToolCall,
    ToolCallUpdate,
    Plan,
    PermissionRequest,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskResult {
    pub task_id: Uuid,
    pub status: TaskStatus,
    /// ACP session id — cloud stores it to offer "resume" later.
    pub session_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionDecision {
    pub task_id: Uuid,
    pub permission_id: String,
    pub approved: bool,
}
