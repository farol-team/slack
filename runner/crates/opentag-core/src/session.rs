//! SessionManager: executes cloud-assigned tasks on local ACP agents.
//! One task = one ACP session bound to a Slack thread.

use crate::acp::{AcpClient, AcpEvent};
use crate::cloud::CloudSender;
use crate::config::RunnerConfig;
use crate::protocol::{AssignTurn, CloudMessage, TurnEvent, TurnEventKind, TurnResult, TurnStatus};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tracing::{error, info, warn};
use uuid::Uuid;

/// How long a permission request may wait for a human before it is refused.
const PERMISSION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

/// The MCP server we hand the agent for team memory (see `handle_assign`).
const MEMORY_SERVER: &str = "team-memory";
/// ACP ToolKinds that only observe. `edit`, `delete`, `move`, `execute` and
/// anything unfamiliar are not here on purpose.
const READ_ONLY_KINDS: &[&str] = &["read", "search", "fetch"];

/// Whether this permission request can be answered without a human.
///
/// A button is worth asking for when a wrong answer costs something. Memory
/// calls cost nothing: the gateway already pins every one of them to the
/// asking channel and refuses writes into shared memory, so the button adds
/// no safety — it only teaches people to click Approve without reading.
/// Reading inside the working directory is bounded the same way, by the
/// runner's own allowlist.
///
/// The call still shows up in the Slack thread as a tool_call event; what
/// disappears is the interruption, not the visibility.
fn auto_allowed(title: &str, tool_kind: &str) -> bool {
    if READ_ONLY_KINDS.contains(&tool_kind) {
        return true;
    }
    // MCP tools are named after their server (`mcp__team-memory__find`), but
    // the separator differs between adapters — match the server name instead
    // of a fixed prefix. A tool name is a single token: the space rules out
    // a shell command that merely mentions the server.
    title.contains(MEMORY_SERVER) && !title.contains(char::is_whitespace)
}

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
                &task.slack_channel,
                &task.workspace_name,
                &task.channel_name,
            ) {
                Ok(dir) => dir,
                Err(e) => {
                    error!("cannot prepare a working directory: {e}");
                    self.finish(
                        task.turn_id,
                        TurnStatus::Failed,
                        None,
                        Some(format!("cannot prepare a working directory: {e}")),
                    );
                    return;
                }
            }
        } else {
            PathBuf::from(&task.cwd)
        };
        // Security gate: never run outside allowlisted directories.
        if !self.config.is_cwd_allowed(&cwd) {
            error!("rejected cwd outside allowlist: {cwd:?}");
            self.finish(
                task.turn_id,
                TurnStatus::Failed,
                None,
                Some(format!(
                    "cwd not allowed by local policy: {}",
                    cwd.display()
                )),
            );
            return;
        }

        // Fall back to the first adapter that is actually on this machine —
        // falling back to the first *configured* one would spawn something
        // absent and surface as a cryptic spawn error in the Slack thread.
        let agent = match self
            .config
            .agents
            .iter()
            .find(|a| a.name == task.agent)
            .or_else(|| {
                self.config
                    .agents
                    .iter()
                    .find(|a| crate::agents::is_installed(&a.command, None))
            }) {
            Some(a) => a.clone(),
            None => {
                self.finish(
                    task.turn_id,
                    TurnStatus::Failed,
                    None,
                    Some("no ACP adapter installed on this runner".into()),
                );
                return;
            }
        };

        let (ev_tx, mut ev_rx) = mpsc::channel::<AcpEvent>(64);

        // Env injection for the memory layer: agents that support
        // OpenViking pick it up via MCP server config in session/new.
        // PATH is not decoration: an adapter's shebang resolves `node` through
        // it, and a desktop app's own PATH has neither Homebrew nor nvm in it.
        let env: Vec<(String, String)> =
            vec![("PATH".to_string(), crate::agents::spawn_path(None))];

        // Whatever the person attached lands next to the work, before the
        // agent starts: a prompt that mentions a file it cannot open is worse
        // than one that never mentioned it.
        let prompt = match self.fetch_attachments(&task, &cwd).await {
            Ok(paths) if !paths.is_empty() => {
                let list = paths
                    .iter()
                    .map(|p| format!("- {}", p.display()))
                    .collect::<Vec<_>>()
                    .join("\n");
                format!("{}\n\nAttached files:\n{}", task.prompt, list)
            }
            Ok(_) => task.prompt.clone(),
            Err(e) => {
                error!("attachments failed: {e}");
                format!(
                    "{}\n\n(An attachment could not be downloaded: {e})",
                    task.prompt
                )
            }
        };

        let client = match AcpClient::spawn(&agent.command, &agent.args, &cwd, &env, ev_tx).await {
            Ok(c) => c,
            Err(e) => {
                self.finish(
                    task.turn_id,
                    TurnStatus::Failed,
                    None,
                    Some(format!("spawn: {e}")),
                );
                return;
            }
        };

        if let Err(e) = client.initialize().await {
            self.finish(
                task.turn_id,
                TurnStatus::Failed,
                None,
                Some(format!("initialize: {e}")),
            );
            return;
        }

        // MCP servers for the agent: team memory endpoint. `headers` is an
        // array of {name, value} — ACP's HttpMcpServer, not a JSON map. The
        // shape is not cosmetic: opencode rejects session/new outright, and
        // claude-agent-acp accepts the request but silently drops the server,
        // so the agent comes up with no memory tools at all.
        let mcp_servers = match &task.memory {
            Some(mem) => json!([{
                "name": MEMORY_SERVER,
                "type": "http",
                "url": mem.mcp_url,
                "headers": [
                    { "name": "Authorization", "value": format!("Bearer {}", mem.user_key) }
                ]
            }]),
            None => json!([]),
        };

        // The resolved directory, not what the cloud asked for: they differ
        // whenever the cloud had no opinion and this machine chose.
        let cwd_str = cwd.to_string_lossy().to_string();
        // A session that never opened cannot be prompted: prompting with an
        // empty id used to fail deep inside the agent, with a message nobody
        // could trace back to session/new.
        let session_id = match &task.resume_session {
            Some(sid) => {
                if let Err(e) = client.load_session(sid, &cwd_str, mcp_servers).await {
                    // Kept as-is: some adapters take a prompt for a session
                    // they never loaded. Worth seeing in the log either way.
                    warn!("session/load failed for {sid}: {e}");
                }
                Some(sid.clone())
            }
            None => match client.new_session(&cwd_str, mcp_servers).await {
                Ok(sid) => Some(sid),
                Err(e) => {
                    client.shutdown().await;
                    self.finish(
                        task.turn_id,
                        TurnStatus::Failed,
                        None,
                        Some(format!("session/new: {e}")),
                    );
                    return;
                }
            },
        };

        let client = Arc::new(client);
        let running = Arc::new(Mutex::new(RunningTask {
            client: client.clone(),
            session_id: session_id.clone(),
            pending_permissions: HashMap::new(),
        }));
        self.tasks
            .lock()
            .await
            .insert(task.turn_id, running.clone());

        // Forward ACP events to the cloud (cloud renders them into Slack).
        let cloud = self.cloud.clone();
        let turn_id = task.turn_id;
        tokio::spawn(async move {
            while let Some(ev) = ev_rx.recv().await {
                let (kind, text, permission_id) = match ev {
                    AcpEvent::MessageChunk(t) => (TurnEventKind::AgentMessageChunk, t, None),
                    AcpEvent::ToolCall { title } => (TurnEventKind::ToolCall, title, None),
                    AcpEvent::ToolCallUpdate { title } => {
                        (TurnEventKind::ToolCallUpdate, title, None)
                    }
                    AcpEvent::Plan(t) => (TurnEventKind::Plan, t, None),
                    AcpEvent::PermissionRequest {
                        request_id,
                        description,
                        tool_kind,
                        allow_id,
                        reject_id,
                    } => {
                        if auto_allowed(&description, &tool_kind) {
                            info!("permission auto-allowed: {description} (kind {tool_kind})");
                            let client = running.lock().await.client.clone();
                            if let Err(e) = client.respond_permission(request_id, &allow_id).await {
                                error!("auto-allow for {description} failed: {e}");
                            }
                            continue;
                        }
                        let pid = request_id.to_string();
                        running
                            .lock()
                            .await
                            .pending_permissions
                            .insert(pid.clone(), (request_id, allow_id, reject_id.clone()));
                        // Nobody may answer — a misconfigured Slack app delivers
                        // the click nowhere, and the agent would hold the thread
                        // forever. Silence becomes a refusal, not a deadlock.
                        let task = running.clone();
                        let pid_timeout = pid.clone();
                        tokio::spawn(async move {
                            tokio::time::sleep(PERMISSION_TIMEOUT).await;
                            let mut t = task.lock().await;
                            if t.pending_permissions.remove(&pid_timeout).is_some() {
                                tracing::warn!(
                                    "permission {pid_timeout} unanswered \
                                    for {}s — denying",
                                    PERMISSION_TIMEOUT.as_secs()
                                );
                                let _ = t.client.respond_permission(request_id, &reject_id).await;
                            }
                        });
                        (TurnEventKind::PermissionRequest, description, Some(pid))
                    }
                };
                cloud.send(&CloudMessage::TurnEvent(TurnEvent {
                    turn_id,
                    kind,
                    text,
                    permission_id,
                }));
            }
        });

        info!("task {} started, session {:?}", task.turn_id, session_id);
        let sid = session_id.clone().unwrap_or_default();
        // prompt ждёт финальный ответ агента — потенциально минуты.
        // Мьютекса на клиенте нет: respond_permission/cancel пишут в stdin
        // параллельно через свой мьютекс внутри AcpClient.
        let result = client.prompt(&sid, &prompt).await;

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
            Err(e) => self.finish(
                task.turn_id,
                TurnStatus::Failed,
                session_id,
                Some(e.to_string()),
            ),
        }
    }

    /// Pull the asking message's files into the working directory. The task
    /// token authorises it — the same one the memory endpoint takes — so the
    /// runner never sees a Slack token.
    async fn fetch_attachments(
        &self,
        task: &AssignTurn,
        cwd: &std::path::Path,
    ) -> anyhow::Result<Vec<PathBuf>> {
        if task.attachments.is_empty() {
            return Ok(vec![]);
        }
        let token = task
            .memory
            .as_ref()
            .map(|m| m.user_key.clone())
            .unwrap_or_default();
        let dir = cwd.join(".opentag").join("attachments");
        tokio::fs::create_dir_all(&dir).await?;
        let http = reqwest::Client::new();
        let mut saved = Vec::new();
        for att in &task.attachments {
            let res = http
                .get(&att.url)
                .header("Authorization", format!("Bearer {token}"))
                .send()
                .await?;
            if !res.status().is_success() {
                anyhow::bail!("{} -> HTTP {}", att.name, res.status());
            }
            // The name comes from Slack: keep the leaf, never a path.
            let leaf = std::path::Path::new(&att.name)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "attachment".into());
            let path = dir.join(leaf);
            tokio::fs::write(&path, res.bytes().await?).await?;
            info!("attachment saved: {}", path.display());
            saved.push(path);
        }
        Ok(saved)
    }

    /// Slack pressed Approve/Deny — relay into the agent.
    pub async fn handle_permission(&self, turn_id: Uuid, permission_id: String, approved: bool) {
        let tasks = self.tasks.lock().await;
        if let Some(task) = tasks.get(&turn_id) {
            let mut t = task.lock().await;
            if let Some((request_id, allow_id, reject_id)) =
                t.pending_permissions.remove(&permission_id)
            {
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

    fn finish(
        &self,
        turn_id: Uuid,
        status: TurnStatus,
        session_id: Option<String>,
        error: Option<String>,
    ) {
        self.cloud.send(&CloudMessage::TurnResult(TurnResult {
            turn_id,
            status,
            session_id,
            error,
        }));
    }

    /// Graceful shutdown: kill all agent processes.
    pub async fn shutdown(&self) {
        for (_, task) in self.tasks.lock().await.drain() {
            task.lock().await.client.shutdown().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::auto_allowed;

    /// Payloads observed from claude-agent-acp 0.65 (`toolCall.kind` is
    /// `other` for MCP calls, so the server name is what identifies memory).
    #[test]
    fn memory_calls_never_reach_slack() {
        assert!(auto_allowed("mcp__team-memory__find", "other"));
        assert!(auto_allowed("mcp__team-memory__read", "other"));
        assert!(auto_allowed("team-memory_find", "other")); // other adapters
    }

    #[test]
    fn reading_is_quiet_but_changing_things_is_not() {
        assert!(auto_allowed("Read(src/main.rs)", "read"));
        assert!(auto_allowed("Grep(fn main)", "search"));
        assert!(!auto_allowed("Write(src/main.rs)", "edit"));
        assert!(!auto_allowed("Bash(rm -rf build)", "execute"));
        assert!(!auto_allowed("Delete(secrets.env)", "delete"));
        assert!(!auto_allowed("some new tool", ""));
    }

    /// A command that merely mentions the memory server is still a command.
    #[test]
    fn mentioning_the_server_is_not_calling_it() {
        assert!(!auto_allowed("Bash(curl team-memory internal)", "execute"));
    }
}
