//! SessionManager: executes cloud-assigned tasks on local ACP agents.
//! One task = one ACP session bound to a Slack thread.

use crate::acp::{AcpClient, AcpEvent};
use crate::cloud::CloudSender;
use crate::config::RunnerConfig;
use crate::protocol::{
    AssignTurn, CloudMessage, TurnEvent, TurnEventKind, TurnResult, TurnStatus,
};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tracing::{error, info};
use uuid::Uuid;

struct RunningTask {
    client: Arc<AcpClient>,
    session_id: Option<String>,
    /// Pending permission: ACP JSON-RPC request id + optionId для approve/deny.
    pending_permissions: HashMap<String, (u64, String, String)>,
}

pub struct SessionManager {
    config: RunnerConfig,
    cloud: CloudSender,
    tasks: Arc<Mutex<HashMap<Uuid, Arc<Mutex<RunningTask>>>>>,
}

impl SessionManager {
    pub fn new(config: RunnerConfig, cloud: CloudSender) -> Self {
        Self {
            config,
            cloud,
            tasks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Entry point for CloudMessage::AssignTurn.
    pub async fn handle_assign(&self, task: AssignTurn) {
        // An empty cwd means the cloud has no opinion: it does not know what
        // exists on this machine. The runner answers with the folder bound to
        // this channel, or the one it derives from the names and creates.
        let cwd = if task.cwd.is_empty() {
            match self.config.workspace_for(
                &task.slack_channel, &task.workspace_name, &task.channel_name,
            ) {
                Ok(dir) => dir,
                Err(e) => {
                    error!("cannot prepare a working directory: {e}");
                    self.finish(task.turn_id, TurnStatus::Failed, None,
                                Some(format!("cannot prepare a working directory: {e}")));
                    return;
                }
            }
        } else {
            PathBuf::from(&task.cwd)
        };
        // Security gate: never run outside allowlisted directories.
        if !self.config.is_cwd_allowed(&cwd) {
            error!("rejected cwd outside allowlist: {cwd:?}");
            self.finish(task.turn_id, TurnStatus::Failed, None,
                        Some(format!("cwd not allowed by local policy: {}", cwd.display())));
            return;
        }

        // Fall back to the first adapter that is actually on this machine —
        // falling back to the first *configured* one would spawn something
        // absent and surface as a cryptic spawn error in the Slack thread.
        let agent = match self.config.agents.iter().find(|a| a.name == task.agent)
            .or_else(|| self.config.agents.iter()
                .find(|a| crate::agents::is_installed(&a.command, None)))
        {
            Some(a) => a.clone(),
            None => {
                self.finish(task.turn_id, TurnStatus::Failed, None,
                            Some("no ACP adapter installed on this runner".into()));
                return;
            }
        };

        let (ev_tx, mut ev_rx) = mpsc::channel::<AcpEvent>(64);

        // Env injection for the memory layer: agents that support
        // OpenViking pick it up via MCP server config in session/new.
        // PATH is not decoration: an adapter's shebang resolves `node` through
        // it, and a desktop app's own PATH has neither Homebrew nor nvm in it.
        let env: Vec<(String, String)> = vec![(
            "PATH".to_string(),
            crate::agents::spawn_path(None),
        )];

        let client = match AcpClient::spawn(&agent.command, &agent.args, &cwd, &env, ev_tx).await {
            Ok(c) => c,
            Err(e) => {
                self.finish(task.turn_id, TurnStatus::Failed, None, Some(format!("spawn: {e}")));
                return;
            }
        };

        if let Err(e) = client.initialize().await {
            self.finish(task.turn_id, TurnStatus::Failed, None, Some(format!("initialize: {e}")));
            return;
        }

        // MCP servers for the agent: team memory endpoint.
        let mcp_servers = match &task.memory {
            Some(mem) => json!([{
                "name": "team-memory",
                "type": "http",
                "url": mem.mcp_url,
                "headers": { "Authorization": format!("Bearer {}", mem.user_key) }
            }]),
            None => json!([]),
        };

        // The resolved directory, not what the cloud asked for: they differ
        // whenever the cloud had no opinion and this machine chose.
        let cwd_str = cwd.to_string_lossy().to_string();
        let session_id = match &task.resume_session {
            Some(sid) => {
                client.load_session(sid, &cwd_str, mcp_servers).await.ok();
                Some(sid.clone())
            }
            None => client.new_session(&cwd_str, mcp_servers).await.ok(),
        };

        let client = Arc::new(client);
        let running = Arc::new(Mutex::new(RunningTask {
            client: client.clone(),
            session_id: session_id.clone(),
            pending_permissions: HashMap::new(),
        }));
        self.tasks.lock().await.insert(task.turn_id, running.clone());

        // Forward ACP events to the cloud (cloud renders them into Slack).
        let cloud = self.cloud.clone();
        let turn_id = task.turn_id;
        tokio::spawn(async move {
            while let Some(ev) = ev_rx.recv().await {
                let (kind, text, permission_id) = match ev {
                    AcpEvent::MessageChunk(t) => (TurnEventKind::AgentMessageChunk, t, None),
                    AcpEvent::ToolCall { title } => (TurnEventKind::ToolCall, title, None),
                    AcpEvent::ToolCallUpdate { title } => (TurnEventKind::ToolCallUpdate, title, None),
                    AcpEvent::Plan(t) => (TurnEventKind::Plan, t, None),
                    AcpEvent::PermissionRequest { request_id, description, allow_id, reject_id } => {
                        let pid = request_id.to_string();
                        running.lock().await
                            .pending_permissions.insert(pid.clone(), (request_id, allow_id, reject_id));
                        (TurnEventKind::PermissionRequest, description, Some(pid))
                    }
                };
                cloud.send(&CloudMessage::TurnEvent(TurnEvent {
                    turn_id, kind, text, permission_id,
                }));
            }
        });

        info!("task {} started, session {:?}", task.turn_id, session_id);
        let sid = session_id.clone().unwrap_or_default();
        // prompt ждёт финальный ответ агента — потенциально минуты.
        // Мьютекса на клиенте нет: respond_permission/cancel пишут в stdin
        // параллельно через свой мьютекс внутри AcpClient.
        let result = client.prompt(&sid, &task.prompt).await;

        // If the entry is gone, the task was cancelled: the agent process
        // is already dead and the Cancelled result already sent.
        let Some(entry) = self.tasks.lock().await.remove(&task.turn_id) else {
            return;
        };
        // One task = one process: reap the agent, the session lives on
        // disk and can be resumed by a fresh process via session/load.
        entry.lock().await.client.shutdown().await;
        match result {
            Ok(()) => self.finish(task.turn_id, TurnStatus::Done, session_id, None),
            Err(e) => self.finish(task.turn_id, TurnStatus::Failed, session_id, Some(e.to_string())),
        }
    }

    /// Slack pressed Approve/Deny — relay into the agent.
    pub async fn handle_permission(&self, turn_id: Uuid, permission_id: String, approved: bool) {
        let tasks = self.tasks.lock().await;
        if let Some(task) = tasks.get(&turn_id) {
            let mut t = task.lock().await;
            if let Some((request_id, allow_id, reject_id)) = t.pending_permissions.remove(&permission_id) {
                let option_id = if approved { allow_id } else { reject_id };
                let _ = t.client.respond_permission(request_id, &option_id).await;
            }
        }
    }

    /// Slack pressed Stop: cancel the session, then kill the agent
    /// process — Stop must actually stop work on the machine.
    pub async fn handle_cancel(&self, turn_id: Uuid) {
        let entry = self.tasks.lock().await.remove(&turn_id);
        let Some(task) = entry else { return };
        let (session_id, client) = {
            let t = task.lock().await;
            (t.session_id.clone(), t.client.clone())
        };
        if let Some(sid) = &session_id {
            let _ = client.cancel(sid).await;
        }
        client.shutdown().await;
        self.finish(turn_id, TurnStatus::Cancelled, session_id, None);
    }

    fn finish(&self, turn_id: Uuid, status: TurnStatus, session_id: Option<String>, error: Option<String>) {
        self.cloud.send(&CloudMessage::TurnResult(TurnResult {
            turn_id, status, session_id, error,
        }));
    }

    /// Graceful shutdown: kill all agent processes.
    pub async fn shutdown(&self) {
        for (_, task) in self.tasks.lock().await.drain() {
            task.lock().await.client.shutdown().await;
        }
    }
}
