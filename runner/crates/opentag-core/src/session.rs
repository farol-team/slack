//! SessionManager: executes cloud-assigned turns on local ACP agents.
//! One turn = one ACP session bound to a Slack thread.
//!
//! Speaking ACP is not this crate's job any more: the client, the agent
//! catalogue and the process-group bookkeeping live in `acp-client` /
//! `acp-agents`, shared with the other products that reach a local agent the
//! same way. What is here is OpenTag's own half — which directories a turn may
//! run in, which permission requests are worth a human's attention, how team
//! memory is handed to the agent, and how all of it renders into a thread.

use acp_client::{
    http_mcp_server_with_bearer, Agent, Config, Event, EventKind, PermissionPolicy,
    PermissionRequest, Session, SessionOpts,
};
use anyhow::Result;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::cloud::CloudSender;
use crate::config::RunnerConfig;
use crate::protocol::{AssignTurn, CloudMessage, TurnEvent, TurnEventKind, TurnResult, TurnStatus};

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

struct RunningTurn {
    /// Held for its lifetime: dropping it kills the agent and the whole
    /// wrapper chain behind it.
    agent: Arc<Agent>,
    session: Arc<Session>,
    /// Requests waiting on a button in Slack, by the id sent with the event.
    pending: HashMap<String, PermissionRequest>,
}

pub struct SessionManager {
    config: RunnerConfig,
    cloud: CloudSender,
    turns: Arc<Mutex<HashMap<Uuid, Arc<Mutex<RunningTurn>>>>>,
}

impl SessionManager {
    pub fn new(config: RunnerConfig, cloud: CloudSender) -> Self {
        // Agents a previous run left behind, before we start any of our own.
        // A crash or a kill -9 runs no destructor, and an adapter reached
        // through a package runner outlives the process we spawned.
        if let Some(registry) = RunnerConfig::agent_registry_path() {
            match acp_client::reap(&registry) {
                0 => {}
                n => info!("reaped {n} agent process group(s) left by a previous run"),
            }
        }
        Self {
            config,
            cloud,
            turns: Arc::new(Mutex::new(HashMap::new())),
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
                    .find(|a| acp_agents::installed(&a.command, None))
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

        let (ev_tx, ev_rx) = mpsc::channel::<Event>(64);

        // PATH is not decoration: an adapter's shebang resolves `node` through
        // it, and a desktop app's own PATH has neither Homebrew nor nvm in it.
        let mut config = Config::new(&agent.command)
            .args(agent.args.clone())
            .cwd(&cwd)
            .env(
                "PATH",
                acp_agents::spawn_path(None).to_string_lossy().to_string(),
            )
            .client("opentag-runner", env!("CARGO_PKG_VERSION"))
            // Destructive actions are a person's call, through the buttons in
            // the thread; what may be answered without one is `auto_allowed`.
            .permissions(PermissionPolicy::Ask);
        if let Some(registry) = RunnerConfig::agent_registry_path() {
            config = config.registry(registry);
        }

        let client = match Agent::launch(config, ev_tx).await {
            Ok(c) => c,
            Err(e) => {
                // The message already carries whatever the agent said on its
                // way down — a missing credential, a config it could not read
                // — which used to be inherited into the runner's own stderr
                // and never reached the thread.
                self.finish(task.turn_id, TurnStatus::Failed, None, Some(e.to_string()));
                return;
            }
        };

        // MCP servers for the agent: the team memory endpoint.
        let mut opts = SessionOpts::default().cwd(&cwd);
        if let Some(mem) = &task.memory {
            if !client.handshake().mounts_http_mcp() {
                // Not fatal — an adapter that says nothing about its
                // capabilities may still mount one — but it is the difference
                // between "the model was unhelpful" and "the agent never had
                // the memory we promised it".
                warn!(
                    "{} does not report that it can mount an HTTP MCP server; \
                     team memory may not reach it",
                    agent.command
                );
            }
            opts = opts.mcp(http_mcp_server_with_bearer(
                MEMORY_SERVER,
                &mem.mcp_url,
                &mem.user_key,
            ));
        }

        // A session that never opened cannot be prompted.
        let session = match &task.resume_session {
            Some(sid) => match client.load_session(sid, opts.clone()).await {
                Ok(session) => session,
                Err(e) => {
                    // A thread whose session the agent has forgotten starts a
                    // new one rather than failing: the history is lost, the
                    // answer is not.
                    warn!("session/load failed for {sid}: {e} — opening a new session");
                    match client.new_session(opts).await {
                        Ok(session) => session,
                        Err(e) => {
                            self.finish(
                                task.turn_id,
                                TurnStatus::Failed,
                                None,
                                Some(format!("session/new: {e}")),
                            );
                            return;
                        }
                    }
                }
            },
            None => match client.new_session(opts).await {
                Ok(session) => session,
                Err(e) => {
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

        let session_id = Some(session.id().to_string());
        let session = Arc::new(session);
        let running = Arc::new(Mutex::new(RunningTurn {
            agent: client,
            session: session.clone(),
            pending: HashMap::new(),
        }));
        self.turns
            .lock()
            .await
            .insert(task.turn_id, running.clone());

        // Forward what the agent says to the cloud, which renders it into the
        // thread.
        tokio::spawn(forward_events(
            ev_rx,
            running.clone(),
            self.cloud.clone(),
            task.turn_id,
        ));

        info!("turn {} started, session {:?}", task.turn_id, session_id);
        // The prompt waits for the agent's final answer — potentially minutes,
        // bounded by the client's idle and wall-clock deadlines. No lock is
        // held on it: answering a permission request and cancelling both write
        // to the same stdin through the client's own.
        let result = session.prompt(&prompt).await;

        // If the entry is gone, the turn was cancelled: the agent is already
        // dead and the Cancelled result already sent.
        let Some(entry) = self.turns.lock().await.remove(&task.turn_id) else {
            return;
        };
        // One turn = one process: reap the agent, the session lives on disk
        // and can be resumed by a fresh process via session/load.
        entry.lock().await.agent.stop();
        match result {
            Ok(_) => self.finish(task.turn_id, TurnStatus::Done, session_id, None),
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
    ) -> Result<Vec<PathBuf>> {
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
        let turns = self.turns.lock().await;
        let Some(turn) = turns.get(&turn_id) else {
            return;
        };
        let mut turn = turn.lock().await;
        let Some(request) = turn.pending.remove(&permission_id) else {
            return;
        };
        let answered = if approved {
            request.allow().await
        } else {
            request.deny().await
        };
        if let Err(e) = answered {
            // An agent offering neither an allow nor a reject option is still
            // blocked on this; cancelling is the answer the protocol has for
            // "nobody chose".
            warn!("permission {permission_id}: {e} — cancelling instead");
            let _ = request.cancel().await;
        }
    }

    /// Slack pressed Stop: cancel the session, then kill the agent
    /// process — Stop must actually stop work on the machine.
    pub async fn handle_cancel(&self, turn_id: Uuid) {
        let entry = self.turns.lock().await.remove(&turn_id);
        let Some(turn) = entry else { return };
        let (session, agent) = {
            let t = turn.lock().await;
            (t.session.clone(), t.agent.clone())
        };
        let session_id = Some(session.id().to_string());
        let _ = session.cancel().await;
        agent.stop();
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
        for (_, turn) in self.turns.lock().await.drain() {
            turn.lock().await.agent.stop();
        }
    }
}

/// Everything the agent says, in the vocabulary the thread renders.
///
/// Thoughts, usage and session options are dropped: a Slack thread is the
/// answer and the steps, not the agent's inner monologue.
async fn forward_events(
    mut events: mpsc::Receiver<Event>,
    turn: Arc<Mutex<RunningTurn>>,
    cloud: CloudSender,
    turn_id: Uuid,
) {
    while let Some(event) = events.recv().await {
        let (kind, text, permission_id) = match event.kind {
            EventKind::Text(text) => (TurnEventKind::AgentMessageChunk, text, None),
            EventKind::Tool {
                title,
                update: false,
                ..
            } => (TurnEventKind::ToolCall, title, None),
            EventKind::Tool {
                title,
                update: true,
                ..
            } => (TurnEventKind::ToolCallUpdate, title, None),
            EventKind::Plan(entries) => {
                let text = entries
                    .iter()
                    .map(|e| match &e.status {
                        Some(status) => format!("- {} ({status})", e.content),
                        None => format!("- {}", e.content),
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                (TurnEventKind::Plan, text, None)
            }
            EventKind::Permission(request) => {
                match handle_permission_request(request, &turn).await {
                    Some(announced) => announced,
                    None => continue,
                }
            }
            // The process is gone; the prompt this turn is waiting on fails on
            // its own, with the diagnostics attached.
            EventKind::Closed { diagnostics } if !diagnostics.is_empty() => {
                warn!(
                    "the agent stopped; it last said: {}",
                    diagnostics.join("\n")
                );
                continue;
            }
            _ => continue,
        };
        cloud.send(&CloudMessage::TurnEvent(TurnEvent {
            turn_id,
            kind,
            text,
            permission_id,
        }));
    }
}

/// Answer it ourselves where a button would teach nothing, or park it for a
/// human and announce it.
async fn handle_permission_request(
    request: PermissionRequest,
    turn: &Arc<Mutex<RunningTurn>>,
) -> Option<(TurnEventKind, String, Option<String>)> {
    let description = request.title.clone();
    if auto_allowed(&description, &request.tool_kind) {
        info!(
            "permission auto-allowed: {description} (kind {})",
            request.tool_kind
        );
        if let Err(e) = request.allow().await {
            error!("auto-allow for {description} failed: {e}");
            let _ = request.cancel().await;
        }
        return None;
    }

    let id = acp_client::wire::id_key(&request.id);
    turn.lock().await.pending.insert(id.clone(), request);

    // Nobody may answer — a misconfigured Slack app delivers the click
    // nowhere, and the agent would hold the thread forever. Silence becomes a
    // refusal, not a deadlock.
    let waiting = turn.clone();
    let timed_out = id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(PERMISSION_TIMEOUT).await;
        let request = waiting.lock().await.pending.remove(&timed_out);
        if let Some(request) = request {
            warn!(
                "permission {timed_out} unanswered for {}s — denying",
                PERMISSION_TIMEOUT.as_secs()
            );
            if request.deny().await.is_err() {
                let _ = request.cancel().await;
            }
        }
    });

    Some((TurnEventKind::PermissionRequest, description, Some(id)))
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
