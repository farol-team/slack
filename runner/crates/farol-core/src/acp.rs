//! Minimal ACP (Agent Client Protocol) client: JSON-RPC 2.0 over stdio.
//! Spawns the agent as a child process and speaks the protocol:
//! initialize -> session/new -> session/prompt, with
//! session/update notifications streamed out and
//! session/request_permission handled via a callback.

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tracing::{debug, warn};

/// Events the ACP agent pushes to us mid-turn.
#[derive(Debug, Clone)]
pub enum AcpEvent {
    MessageChunk(String),
    ToolCall { title: String },
    ToolCallUpdate { title: String },
    Plan(String),
    /// Agent asks for permission; the outer layer decides whether it is
    /// worth a human's attention and answers via
    /// `respond_permission(request_id, option_id)`.
    PermissionRequest {
        request_id: u64,
        description: String,
        /// ACP ToolKind of the call — `read`, `edit`, `execute`, `search`,
        /// `other`, … Empty when the agent sent none.
        tool_kind: String,
        /// optionId из предложенных агентом options: куда маппятся approve/deny.
        allow_id: String,
        reject_id: String,
    },
}

pub struct AcpClient {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    /// Raised while `session/load` is in flight. ACP requires the agent to
    /// replay the entire conversation as ordinary `session/update`
    /// notifications, so without this every resumed turn would repeat the
    /// whole thread back into Slack before answering.
    replaying: Arc<AtomicBool>,
}

impl AcpClient {
    /// Spawn `cmd args...` and start the read loop.
    pub async fn spawn(
        cmd: &str,
        args: &[String],
        cwd: &std::path::Path,
        env: &[(String, String)],
        events: mpsc::Sender<AcpEvent>,
    ) -> Result<Self> {
        let mut command = Command::new(cmd);
        command
            .args(args)
            .current_dir(cwd)
            .envs(env.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);

        let mut child = command.spawn().context(format!("spawn {cmd}"))?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_reader = pending.clone();
        let replaying = Arc::new(AtomicBool::new(false));
        let replaying_reader = replaying.clone();

        // Read loop: dispatch responses by id, forward notifications as events.
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    warn!("acp: non-JSON line: {line}");
                    continue;
                };
                debug!("acp <- {line}");

                if let Some(id) = msg.get("id").and_then(Value::as_u64) {
                    if msg.get("method").is_some() {
                        // Server-initiated request: session/request_permission
                        Self::handle_server_request(id, msg, &events).await;
                    } else {
                        // Response to our request
                        let result = if let Some(err) = msg.get("error") {
                            Err(err.to_string())
                        } else {
                            Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                        };
                        if let Some(tx) = pending_reader.lock().await.remove(&id) {
                            let _ = tx.send(result);
                        }
                    }
                } else if msg.get("method").and_then(Value::as_str) == Some("session/update") {
                    // History being replayed for session/load is not news:
                    // the thread already shows it.
                    if replaying_reader.load(Ordering::SeqCst) {
                        continue;
                    }
                    let params = msg.get("params").cloned().unwrap_or(Value::Null);
                    if let Some(ev) = map_session_update(&params) {
                        let _ = events.send(ev).await;
                    }
                }
            }
        });

        Ok(Self {
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(stdin)),
            next_id: AtomicU64::new(1),
            pending,
            replaying,
        })
    }

    async fn handle_server_request(
        id: u64,
        msg: Value,
        events: &mpsc::Sender<AcpEvent>,
    ) {
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        if method == "session/request_permission" {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let description = params
                .get("toolCall")
                .and_then(|t| t.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("action")
                .to_string();
            let tool_kind = params
                .get("toolCall")
                .and_then(|t| t.get("kind"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            // optionId — произвольные строки агента (у kimi: approve_once/reject),
            // kind'ы вида allow_once/reject_once — НЕ валидные optionId.
            let options = params.get("options").and_then(Value::as_array);
            let pick = |prefix: &str, fallback: &str| -> String {
                options
                    .and_then(|opts| {
                        opts.iter().find(|o| {
                            o.get("kind").and_then(Value::as_str)
                                .is_some_and(|k| k.starts_with(prefix))
                        })
                    })
                    .and_then(|o| o.get("optionId"))
                    .and_then(Value::as_str)
                    .unwrap_or(fallback)
                    .to_string()
            };
            let _ = events
                .send(AcpEvent::PermissionRequest {
                    request_id: id,
                    description,
                    tool_kind,
                    allow_id: pick("allow", "approve_once"),
                    reject_id: pick("reject", "reject"),
                })
                .await;
        }
        // Other server-initiated requests (fs/terminal) are rejected by
        // outer policy if needed — the thin client keeps agent sandboxed
        // to its own cwd by default.
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let mut line = serde_json::to_string(&req)?;
        line.push('\n');
        debug!("acp -> {}", line.trim());
        {
            // Мьютекс только на запись: пока ждём ответ (rx.await), другие
            // вызовы (respond_permission, cancel) должны иметь доступ к stdin.
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await?;
        }

        rx.await
            .context("agent dropped the connection")?
            .map_err(|e| anyhow!("{method} failed: {e}"))
    }

    /// The handshake, on a leash. An adapter that starts but never answers —
    /// a wrong flag, a wrapper waiting to download itself — used to leave the
    /// turn silent in Slack forever; now it fails, and says so.
    pub async fn initialize(&self) -> Result<()> {
        tokio::time::timeout(std::time::Duration::from_secs(30), self.initialize_inner())
            .await
            .map_err(|_| anyhow!("the agent did not answer the ACP handshake in 30s"))?
    }

    async fn initialize_inner(&self) -> Result<()> {
        self.call(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } },
                "clientInfo": { "name": "farol-runner", "version": env!("CARGO_PKG_VERSION") }
            }),
        )
        .await?;
        Ok(())
    }

    pub async fn new_session(&self, cwd: &str, mcp_servers: Value) -> Result<String> {
        let res = self
            .call(
                "session/new",
                json!({ "cwd": cwd, "mcpServers": mcp_servers }),
            )
            .await?;
        res.get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| anyhow!("no sessionId in response"))
    }

    /// Resume a session the agent already has. Everything it says while this
    /// call is in flight is the replay ACP mandates, not an answer — the flag
    /// keeps that history out of the Slack thread it came from.
    pub async fn load_session(&self, session_id: &str, cwd: &str, mcp_servers: Value) -> Result<()> {
        self.replaying.store(true, Ordering::SeqCst);
        let res = self
            .call(
                "session/load",
                json!({ "sessionId": session_id, "cwd": cwd, "mcpServers": mcp_servers }),
            )
            .await;
        self.replaying.store(false, Ordering::SeqCst);
        res?;
        Ok(())
    }

    pub async fn prompt(&self, session_id: &str, text: &str) -> Result<()> {
        self.call(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": text }]
            }),
        )
        .await?;
        Ok(())
    }

    pub async fn cancel(&self, session_id: &str) -> Result<()> {
        let notif = json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": session_id }
        });
        let mut line = serde_json::to_string(&notif)?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    /// Answer a pending session/request_permission from the agent.
    /// `option_id` — один из optionId, предложенных агентом в options.
    pub async fn respond_permission(&self, request_id: u64, option_id: &str) -> Result<()> {
        let response = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": { "outcome": { "outcome": "selected", "optionId": option_id } }
        });
        let mut line = serde_json::to_string(&response)?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    /// Kill the agent process.
    pub async fn shutdown(&self) {
        let _ = self.child.lock().await.kill().await;
    }
}

fn map_session_update(params: &Value) -> Option<AcpEvent> {
    let update = params.get("update")?;
    let kind = update.get("sessionUpdate")?.as_str()?;
    match kind {
        "agent_message_chunk" => update
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(Value::as_str)
            .map(|t| AcpEvent::MessageChunk(t.to_string())),
        "tool_call" => Some(AcpEvent::ToolCall {
            title: update.get("title").and_then(Value::as_str).unwrap_or("tool").into(),
        }),
        "tool_call_update" => Some(AcpEvent::ToolCallUpdate {
            title: update.get("title").and_then(Value::as_str).unwrap_or("tool").into(),
        }),
        "plan" => Some(AcpEvent::Plan(
            update.get("entries").map(|e| e.to_string()).unwrap_or_default(),
        )),
        _ => None,
    }
}
