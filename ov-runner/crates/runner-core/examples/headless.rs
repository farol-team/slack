//! Headless-запуск runner'а без Tauri-UI: для dev-отладки и тестов.
//!
//! Конфиг — стандартный `RunnerConfig::load()` (config.json в platform config dir),
//! токен — из env `OV_RUNNER_TOKEN` (иначе из OS keychain).
//!
//! ```bash
//! OV_RUNNER_TOKEN=ovr_... cargo run -p runner-core --example headless
//! ```

use runner_core::cloud::{run_connection_loop, CloudSender};
use runner_core::protocol::{CloudMessage, Hello};
use runner_core::{RunnerConfig, SessionManager};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let cfg = RunnerConfig::load()?;
    let token = std::env::var("OV_RUNNER_TOKEN")
        .ok()
        .or_else(|| RunnerConfig::token().ok().flatten())
        .expect("токен не найден: задайте OV_RUNNER_TOKEN или запись в keychain");

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

    // SessionManager нужен обработчику сообщений, но зависит от CloudSender,
    // который появится только после run_connection_loop — разрываем цикл слотом.
    let sm_slot = Arc::new(Mutex::new(None::<Arc<SessionManager>>));
    let slot = sm_slot.clone();
    let cloud: CloudSender = run_connection_loop(cfg.cloud_url.clone(), hello, move |msg| {
        let slot = slot.clone();
        async move {
            let sm = slot.lock().await.clone();
            let Some(sm) = sm else { return };
            match msg {
                CloudMessage::AssignTask(task) => {
                    tokio::spawn(async move { sm.handle_assign(task).await });
                }
                CloudMessage::PermissionDecision(d) => {
                    sm.handle_permission(d.task_id, d.permission_id, d.approved).await;
                }
                CloudMessage::CancelTask { task_id } => {
                    sm.handle_cancel(task_id).await;
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
    info!("session manager ready, жду задачи из облака");

    tokio::signal::ctrl_c().await?;
    Ok(())
}
