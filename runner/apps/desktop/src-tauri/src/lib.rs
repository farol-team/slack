//! Farol Runner desktop: Tauri shell around farol-core.
//! Tray-first UX: the app lives in the tray, window shows status/config.

use farol_core::cloud::run_connection_loop;
use farol_core::connect::{self, PollOutcome};
use farol_core::protocol::{CloudMessage, Hello};
use farol_core::{RunnerConfig, SessionManager};
use serde::Serialize;
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::RwLock;

struct AppState {
    status: RwLock<RunnerStatus>,
    session_manager: RwLock<Option<Arc<SessionManager>>>,
}

#[derive(Clone, Serialize)]
struct RunnerStatus {
    connected: bool,
    workspace_id: Option<String>,
    logged_in: bool,
    active_tasks: u32,
    agents: Vec<String>,
}

impl Default for RunnerStatus {
    fn default() -> Self {
        Self {
            connected: false,
            workspace_id: None,
            logged_in: RunnerConfig::token().ok().flatten().is_some(),
            active_tasks: 0,
            agents: vec![],
        }
    }
}

// ---------- IPC commands (called from the UI) ----------

#[tauri::command]
async fn get_status(state: State<'_, AppState>) -> Result<RunnerStatus, String> {
    let s = state.status.read().await.clone();
    tracing::info!("IPC get_status: logged_in={} connected={}", s.logged_in, s.connected);
    Ok(s)
}

/// Login flow: user pastes the token from the web dashboard.
/// Kept as a fallback; the primary flow is `connect_with_slack`.
#[tauri::command]
async fn login(app: AppHandle, token: String) -> Result<(), String> {
    tracing::info!("IPC login: token_len={}", token.len());
    match RunnerConfig::set_token(&token) {
        Ok(()) => tracing::info!("IPC login: keychain write OK"),
        Err(e) => {
            tracing::error!("IPC login: keychain write FAILED: {e}");
            return Err(e.to_string());
        }
    }
    // (Re)start the cloud connection with the new token.
    start_cloud(app).await;
    Ok(())
}

/// Machine name used as the runner label in the SaaS connect flow.
fn machine_label() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "unknown".into())
}

/// Primary login flow: "Connect with Slack". Creates a connect session on the
/// SaaS, opens the approval URL in the system browser, then polls in the
/// background. On approval the token is stored and the cloud starts; failures
/// surface in the UI via the "cloud-error" event.
#[tauri::command]
async fn connect_with_slack(app: AppHandle) -> Result<(), String> {
    let cfg = RunnerConfig::load().map_err(|e| e.to_string())?;
    let label = machine_label();
    tracing::info!("IPC connect_with_slack: saas_url={} label={label}", cfg.saas_url);
    let session = connect::start(&cfg.saas_url, Some(&label))
        .await
        .map_err(|e| e.to_string())?;
    app.opener()
        .open_url(&session.url, None::<&str>)
        .map_err(|e| e.to_string())?;

    let app2 = app.clone();
    let saas_url = cfg.saas_url.clone();
    tauri::async_runtime::spawn(async move {
        let result = connect::wait_for_approval(
            &saas_url,
            session.code,
            connect::DEFAULT_POLL_INTERVAL,
            connect::DEFAULT_POLL_TIMEOUT,
        )
        .await;
        match result {
            Ok(PollOutcome::Approved {
                token,
                workspace_id,
            }) => {
                if let Err(e) = RunnerConfig::set_token(&token) {
                    let _ = app2.emit("cloud-error", format!("keychain write failed: {e}"));
                    return;
                }
                match RunnerConfig::load() {
                    Ok(mut cfg) => {
                        cfg.workspace_id = Some(workspace_id);
                        if let Err(e) = cfg.save() {
                            tracing::error!("connect: config save failed: {e}");
                        }
                    }
                    Err(e) => tracing::error!("connect: config reload failed: {e}"),
                }
                start_cloud(app2.clone()).await;
                let _ = app2.emit("status-changed", ());
            }
            Ok(PollOutcome::Expired) => {
                let _ = app2.emit(
                    "cloud-error",
                    "Authorization expired — try Connect with Slack again".to_string(),
                );
            }
            Ok(PollOutcome::Pending) => unreachable!("wait_for_approval never returns Pending"),
            Err(e) => {
                let _ = app2.emit("cloud-error", e.to_string());
            }
        }
    });
    Ok(())
}

#[tauri::command]
async fn logout(app: AppHandle) -> Result<(), String> {
    RunnerConfig::clear_token().map_err(|e| e.to_string())?;
    if let Some(sm) = app.state::<AppState>().session_manager.write().await.take() {
        sm.shutdown().await;
    }
    app.state::<AppState>().status.write().await.logged_in = false;
    Ok(())
}

/// Pick a directory to add to the agent's allowed working dirs.
#[tauri::command]
async fn add_allowed_cwd(path: String) -> Result<(), String> {
    let mut cfg = RunnerConfig::load().map_err(|e| e.to_string())?;
    cfg.allowed_cwds.push(std::path::PathBuf::from(path));
    cfg.save().map_err(|e| e.to_string())
}

// ---------- Cloud wiring ----------

async fn start_cloud(app: AppHandle) {
    let cfg = match RunnerConfig::load() {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("start_cloud: config load failed: {e}");
            RunnerConfig::default()
        }
    };
    tracing::info!("start_cloud: cloud_url={}", cfg.cloud_url);
    // Workaround: keyring 3.6 на macOS теряет запись сразу после write —
    // в dev можно задать токен через FAROL_RUNNER_TOKEN.
    let token = match std::env::var("FAROL_RUNNER_TOKEN").ok()
        .or_else(|| RunnerConfig::token().ok().flatten())
    {
        Some(t) => t,
        None => {
            tracing::error!("start_cloud: токен не найден (env и keychain пусты) — ранний выход");
            return;
        }
    };
    tracing::info!("start_cloud: token прочитан, len={}", token.len());

    let hello = CloudMessage::Hello(Hello {
        token,
        runner_version: env!("CARGO_PKG_VERSION").into(),
        agents: cfg.agents.iter().map(|a| a.name.clone()).collect(),
        os: std::env::consts::OS.into(),
    });

    let app_handle = app.clone();
    let cloud = run_connection_loop(cfg.cloud_url.clone(), hello, move |msg| {
        let app = app_handle.clone();
        async move { handle_cloud_message(app, msg).await }
    })
    .await;

    let state = app.state::<AppState>();
    let sm = Arc::new(SessionManager::new(cfg.clone(), cloud));
    *state.session_manager.write().await = Some(sm);
    {
        let mut s = state.status.write().await;
        s.logged_in = true;
        s.connected = true;
        s.workspace_id = cfg.workspace_id.clone();
        s.agents = cfg.agents.iter().map(|a| a.name.clone()).collect();
    }
    let _ = app.emit("status-changed", ());
}

async fn handle_cloud_message(app: AppHandle, msg: CloudMessage) {
    let state = app.state::<AppState>();
    let sm = state.session_manager.read().await.clone();
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
            let _ = app.emit("cloud-error", format!("{code}: {message}"));
        }
        _ => {}
    }
}

// ---------- Tauri bootstrap ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            status: RwLock::new(RunnerStatus::default()),
            session_manager: RwLock::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_status, login, logout, add_allowed_cwd, connect_with_slack
        ])
        .setup(|app| {
            // Tray: Show / Quit
            let show = MenuItem::with_id(app, "show", "Open Farol Runner", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Farol Runner")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Auto-connect if credentials exist.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { start_cloud(handle).await });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running runner");
}
