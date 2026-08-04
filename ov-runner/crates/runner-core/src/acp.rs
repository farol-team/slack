//! Minimal ACP (Agent Client Protocol) client: JSON-RPC 2.0 over stdio.
//! Spawns the agent as a child process and speaks the protocol:
//! initialize -> session/new -> session/prompt, with
//! session/update notifications streamed out and
//! session/request_permission handled via a callback.

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
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
    /// Agent asks for permission; the outer layer relays it to Slack
    /// and answers via `respond_permission(request_id, approved)`.
    PermissionRequest {
        request_id: u64,
        description: String,
    },
}

pub struct AcpClient {
    child: Child,
    stdin: ChildStdin,
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
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
                    let params = msg.get("params").cloned().unwrap_or(Value::Null);
                    if let Some(ev) = map_session_update(&params) {
                        let _ = events.send(ev).await;
                    }
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            next_id: AtomicU64::new(1),
            pending,
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
            let _ = events
                .send(AcpEvent::PermissionRequest {
                    request_id: id,
                    description,
                })
                .await;
        }
        // Other server-initiated requests (fs/terminal) are rejected by
        // outer policy if needed — the thin client keeps agent sandboxed
        // to its own cwd by default.
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let mut line = serde_json::to_string(&req)?;
        line.push('\n');
        debug!("acp -> {}", line.trim());
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.flush().await?;

        rx.await
            .context("agent dropped the connection")?
            .map_err(|e| anyhow!("{method} failed: {e}"))
    }

    pub async fn initialize(&mut self) -> Result<()> {
        self.call(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } },
                "clientInfo": { "name": "ov-runner", "version": env!("CARGO_PKG_VERSION") }
            }),
        )
        .await?;
        Ok(())
    }

    pub async fn new_session(&mut self, cwd: &str, mcp_servers: Value) -> Result<String> {
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

    pub async fn load_session(&mut self, session_id: &str, cwd: &str, mcp_servers: Value) -> Result<()> {
        self.call(
            "session/load",
            json!({ "sessionId": session_id, "cwd": cwd, "mcpServers": mcp_servers }),
        )
        .await?;
        Ok(())
    }

    pub async fn prompt(&mut self, session_id: &str, text: &str) -> Result<()> {
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

    pub async fn cancel(&mut self, session_id: &str) -> Result<()> {
        let notif = json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": session_id }
        });
        let mut line = serde_json::to_string(&notif)?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await?;
        Ok(())
    }

    /// Answer a pending session/request_permission from the agent.
    pub async fn respond_permission(&mut self, request_id: u64, approved: bool) -> Result<()> {
        let option = if approved { "allow_once" } else { "reject_once" };
        let response = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": { "outcome": { "outcome": "selected", "optionId": option } }
        });
        let mut line = serde_json::to_string(&response)?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.flush().await?;
        Ok(())
    }

    /// Kill the agent process.
    pub async fn shutdown(&mut self) {
        let _ = self.child.kill().await;
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
