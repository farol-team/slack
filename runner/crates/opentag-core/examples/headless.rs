//! Headless runner without the Tauri UI: for dev debugging and tests.
//!
//! Config is the standard `RunnerConfig::load()` (config.json in the platform config dir),
//! the token comes from the `OPENTAG_RUNNER_TOKEN` env var (falling back to the OS keychain).
//! With no token at all, the "Connect with Slack" flow runs instead: it prints an
//! approval URL, waits for the browser approval, and stores the issued token.
//!
//! ```bash
//! OPENTAG_RUNNER_TOKEN=frl_... cargo run -p opentag-core --example headless
//! ```

use opentag_core::cloud::{run_connection_loop, CloudSender};
use opentag_core::connect::{self, PollOutcome};
use opentag_core::protocol::{CloudMessage, Hello};
use opentag_core::{RunnerConfig, SessionManager};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let mut cfg = RunnerConfig::load()?;
    // OPENTAG_ALLOWED_CWDS (colon-separated) adds folders beyond the root; the
    // root itself (~/OpenTag by default) is always allowed.
    if let Ok(list) = std::env::var("OPENTAG_ALLOWED_CWDS") {
        cfg.allowed_cwds = std::env::split_paths(&list).collect();
    }
    // No fallback to the home directory: an allowlist that quietly includes
    // everything a person owns is not one. Work lands under the root instead,
    // in a directory the runner creates for the channel it came from.
    let token = match std::env::var("OPENTAG_RUNNER_TOKEN")
        .ok()
        .or_else(|| RunnerConfig::token().ok().flatten())
    {
        Some(t) => t,
        None => connect_flow(&cfg).await?,
    };

    // Announce only what can actually be spawned — a turn routed to an adapter
    // that is not on this machine would fail at spawn time in the thread.
    let installed = cfg.installed_agent_names(None);
    if installed.is_empty() {
        tracing::warn!(
            "no ACP adapter found on this machine — install one, e.g. \
             `npm install -g @agentclientprotocol/claude-agent-acp`"
        );
    }
    let hello = CloudMessage::Hello(Hello {
        token,
        runner_version: concat!(env!("CARGO_PKG_VERSION"), "-headless").into(),
        agents: installed.clone(),
        os: std::env::consts::OS.into(),
    });

    info!("cloud_url={} agents={:?} root={:?} extra_cwds={:?}",
          cfg.cloud_url, installed, cfg.root_dir, cfg.allowed_cwds);

    // The message handler needs the SessionManager, but it depends on the CloudSender,
    // which only exists after run_connection_loop — break the cycle with a slot.
    let sm_slot = Arc::new(Mutex::new(None::<Arc<SessionManager>>));
    let slot = sm_slot.clone();
    let cloud: CloudSender = run_connection_loop(cfg.cloud_url.clone(), hello, move |msg| {
        let slot = slot.clone();
        async move {
            let sm = slot.lock().await.clone();
            let Some(sm) = sm else { return };
            match msg {
                CloudMessage::AssignTurn(task) => {
                    tokio::spawn(async move { sm.handle_assign(task).await });
                }
                CloudMessage::PermissionDecision(d) => {
                    sm.handle_permission(d.turn_id, d.permission_id, d.approved).await;
                }
                CloudMessage::CancelTurn { turn_id } => {
                    sm.handle_cancel(turn_id).await;
                }
                CloudMessage::Error { code, message } => {
                    error!("cloud error: {code}: {message}");
                }
                _ => {}
            }
        }
    })
    .await;

    *sm_slot.lock().await = Some(Arc::new(SessionManager::new(cfg, cloud)));
    info!("session manager ready, waiting for tasks from the cloud");

    tokio::signal::ctrl_c().await?;
    Ok(())
}

/// "Connect with Slack" without a UI: print the approval URL, wait for the
/// browser approval, then store the issued token and workspace in config.
async fn connect_flow(cfg: &RunnerConfig) -> anyhow::Result<String> {
    let session = connect::start(&cfg.saas_url, None).await?;
    println!("Open this URL to authorize the runner:\n  {}", session.url);
    match connect::wait_for_approval(
        &cfg.saas_url,
        session.code,
        connect::DEFAULT_POLL_INTERVAL,
        connect::DEFAULT_POLL_TIMEOUT,
    )
    .await?
    {
        PollOutcome::Approved {
            token,
            workspace_id,
        } => {
            RunnerConfig::set_token(&token)?;
            let mut cfg = RunnerConfig::load()?;
            cfg.workspace_id = Some(workspace_id.clone());
            cfg.save()?;
            info!(%workspace_id, "runner authorized, token stored in the keychain");
            Ok(token)
        }
        PollOutcome::Expired => anyhow::bail!("connect code expired — run again"),
        PollOutcome::Pending => unreachable!("wait_for_approval never returns Pending"),
    }
}
