//! Headless runner without the Tauri UI: for dev debugging and tests.
//!
//! Config is the standard `RunnerConfig::load()` (config.json in the platform config dir),
//! the token comes from the `FAROL_RUNNER_TOKEN` env var (falling back to the OS keychain).
//!
//! ```bash
//! FAROL_RUNNER_TOKEN=frl_... cargo run -p farol-core --example headless
//! ```

use farol_core::cloud::{run_connection_loop, CloudSender};
use farol_core::protocol::{CloudMessage, Hello};
use farol_core::{RunnerConfig, SessionManager};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let cfg = RunnerConfig::load()?;
    let token = std::env::var("FAROL_RUNNER_TOKEN")
        .ok()
        .or_else(|| RunnerConfig::token().ok().flatten())
        .expect("token not found: set FAROL_RUNNER_TOKEN or add a keychain entry");

    let hello = CloudMessage::Hello(Hello {
        token,
        runner_version: concat!(env!("CARGO_PKG_VERSION"), "-headless").into(),
        agents: cfg.agents.iter().map(|a| a.name.clone()).collect(),
        os: std::env::consts::OS.into(),
    });

    info!("cloud_url={} agents={:?} allowed_cwds={:?}",
          cfg.cloud_url,
          cfg.agents.iter().map(|a| &a.name).collect::<Vec<_>>(),
          cfg.allowed_cwds);

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
