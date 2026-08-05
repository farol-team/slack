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
    /// Handle on the live cloud loop, so installing an adapter can end it and
    /// hand the cloud a fresh `hello` with the new agent in it.
    cloud: RwLock<Option<farol_core::cloud::CloudSender>>,
    /// The token this session is connected with. Held here because keyring on
    /// macOS can fail a read straight after a write, and a restart that lost
    /// the token would drop a working runner offline.
    token: RwLock<Option<String>>,
}

#[derive(Clone, Serialize)]
struct RunnerStatus {
    /// Shown in the window footer: which build is on this machine, so a bug
    /// report says what it is about. The commit is what actually distinguishes
    /// two builds — the release tag gets moved.
    version: String,
    /// Where channel directories are derived. Shown, not editable: the runner
    /// owns this path, and every channel gets its own folder inside it.
    root: String,
    connected: bool,
    workspace_id: Option<String>,
    logged_in: bool,
    agents: Vec<String>,
}

impl Default for RunnerStatus {
    fn default() -> Self {
        Self {
            root: RunnerConfig::load()
                .map(|c| c.root_dir.display().to_string())
                .unwrap_or_default(),
            version: match option_env!("FAROL_BUILD_SHA") {
                Some(sha) => format!("{} ({})", env!("CARGO_PKG_VERSION"), &sha[..7.min(sha.len())]),
                None => env!("CARGO_PKG_VERSION").to_string(),
            },
            connected: false,
            workspace_id: None,
            logged_in: RunnerConfig::token().ok().flatten().is_some(),
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

/// Machine name used as the runner label in the SaaS connect flow.
fn machine_label() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "unknown".into())
}

/// The way in: create a connect session on the SaaS, open its approval page in
/// the system browser, then poll in the background. The page is the dashboard,
/// not Slack — the person approves this machine while signed in there. On
/// approval the token is stored and the cloud starts; failures surface in the
/// UI via the "cloud-error" event.
#[tauri::command]
async fn authorize_in_browser(app: AppHandle) -> Result<(), String> {
    let cfg = RunnerConfig::load().map_err(|e| e.to_string())?;
    let label = machine_label();
    tracing::info!("IPC authorize_in_browser: saas_url={} label={label}", cfg.saas_url);
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
                    // Not fatal: the connection below uses the token we hold.
                    tracing::error!("connect: keychain write failed: {e}");
                    let _ = app2.emit(
                        "cloud-error",
                        format!("Connected, but saving the token failed: {e}"),
                    );
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
                start_cloud(app2.clone(), Some(token)).await;
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

/// What the panel says about one pinned adapter. Two states, because a third
/// would be a guess: either the command is on this machine or it is not.
#[derive(Clone, Serialize)]
struct AgentRow {
    name: String,
    label: String,
    package: String,
    docs_url: String,
    /// Where the command was found, or null for nowhere.
    resolved: Option<String>,
}

/// The prefix the runner installs adapters into — its own app data dir, never
/// the person's node installation.
fn agents_prefix(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("agents");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
async fn list_agents(app: AppHandle) -> Result<Vec<AgentRow>, String> {
    let prefix = agents_prefix(&app)?;
    Ok(farol_core::agents::BASELINE
        .iter()
        .map(|p| AgentRow {
            name: p.name.into(),
            label: p.label.into(),
            package: p.package.into(),
            docs_url: p.docs_url.into(),
            resolved: farol_core::agents::resolve(p.command, Some(&prefix))
                .map(|path| path.display().to_string()),
        })
        .collect())
}

/// Fetch one adapter into the runner's own prefix and point config.json at the
/// binary that lands there. Nothing is installed until this is pressed.
#[tauri::command]
async fn install_agent(app: AppHandle, name: String) -> Result<AgentRow, String> {
    let profile = farol_core::agents::profile_for(&name)
        .ok_or_else(|| format!("unknown agent: {name}"))?;
    let prefix = agents_prefix(&app)?;

    // A .app launched from Finder has a bare PATH — npm lives in Homebrew or
    // nvm, neither of which is in it. Ask the login shell where things are.
    let path = farol_core::agents::spawn_path(Some(&prefix));
    let npm = farol_core::agents::resolve("npm", None)
        .ok_or_else(|| "npm was not found on this machine — install Node.js first".to_string())?;
    let output = tokio::process::Command::new(&npm)
        .args(["install", "-g", "--prefix"])
        .arg(&prefix)
        .arg(profile.package)
        .env("PATH", &path)
        .output()
        .await
        .map_err(|e| format!("could not run {}: {e}", npm.display()))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr)
            .lines()
            .last()
            .unwrap_or("npm install failed")
            .to_string());
    }

    let resolved = farol_core::agents::resolve(profile.command, Some(&prefix))
        .ok_or_else(|| format!("{} installed but {} not found", profile.package, profile.command))?;

    // Record the absolute path: the runner spawns the adapter itself and its
    // PATH is the desktop session's, which need not contain our prefix.
    let mut cfg = RunnerConfig::load().map_err(|e| e.to_string())?;
    let command = resolved.display().to_string();
    let args: Vec<String> = profile.args.iter().map(|a| (*a).to_string()).collect();
    match cfg.agents.iter_mut().find(|a| a.name == profile.name) {
        Some(entry) => {
            entry.command = command.clone();
            entry.args = args;
        }
        None => cfg.agents.push(farol_core::config::AgentEntry {
            name: profile.name.into(),
            command: command.clone(),
            args,
        }),
    }
    cfg.save().map_err(|e| e.to_string())?;

    // The live connection announced the old list and the running SessionManager
    // holds the old config — replace both so the adapter is usable right away.
    restart_cloud(&app).await;
    let _ = app.emit("status-changed", ());

    Ok(AgentRow {
        name: profile.name.into(),
        label: profile.label.into(),
        package: profile.package.into(),
        docs_url: profile.docs_url.into(),
        resolved: Some(command),
    })
}

// ---------- Cloud wiring ----------

/// Tear down the current connection and dial again. Used when what `hello`
/// says has changed; `start_cloud` re-reads config.json on its way in.
async fn restart_cloud(app: &AppHandle) {
    let state = app.state::<AppState>();
    let token = state.token.read().await.clone();
    if let Some(cloud) = state.cloud.write().await.take() {
        cloud.stop();
    }
    if let Some(sm) = state.session_manager.write().await.take() {
        sm.shutdown().await;
    }
    start_cloud(app.clone(), token).await;
}

async fn start_cloud(app: AppHandle, token: Option<String>) {
    let cfg = match RunnerConfig::load() {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("start_cloud: config load failed: {e}");
            RunnerConfig::default()
        }
    };
    tracing::info!("start_cloud: cloud_url={}", cfg.cloud_url);
    // A token handed in by the flow that just obtained it wins: keyring 3.6 on
    // macOS can lose a write straight after it, and a silent early return here
    // is exactly what "I pressed connect and nothing happened" looks like.
    let token = match token
        .or_else(|| std::env::var("FAROL_RUNNER_TOKEN").ok())
        .or_else(|| RunnerConfig::token().ok().flatten())
    {
        Some(t) => t,
        None => {
            tracing::error!("start_cloud: no token (keychain and env are empty)");
            let _ = app.emit(
                "cloud-error",
                "Authorized, but the token could not be read back from the keychain \
                 — paste it under Advanced instead".to_string(),
            );
            let _ = app.emit("status-changed", ());
            return;
        }
    };
    tracing::info!("start_cloud: token len={}", token.len());
    let token_for_state = token.clone();

    // Announce only adapters that are actually on this machine: the cloud
    // routes a turn to a name from this list, and a name that is not here
    // would only fail later, at spawn time, in the Slack thread.
    let prefix = agents_prefix(&app).ok();
    let installed = cfg.installed_agent_names(prefix.as_deref());
    if installed.is_empty() {
        tracing::warn!("start_cloud: no ACP adapter installed — nothing to announce");
    }
    let hello = CloudMessage::Hello(Hello {
        token,
        runner_version: env!("CARGO_PKG_VERSION").into(),
        agents: installed.clone(),
        os: std::env::consts::OS.into(),
    });

    let app_handle = app.clone();
    let cloud = run_connection_loop(cfg.cloud_url.clone(), hello, move |msg| {
        let app = app_handle.clone();
        async move { handle_cloud_message(app, msg).await }
    })
    .await;

    let state = app.state::<AppState>();
    *state.token.write().await = Some(token_for_state);
    let sm = Arc::new(SessionManager::new(cfg.clone(), cloud.clone()));
    *state.session_manager.write().await = Some(sm);
    *state.cloud.write().await = Some(cloud);
    {
        let mut s = state.status.write().await;
        s.logged_in = true;
        s.connected = true;
        s.workspace_id = cfg.workspace_id.clone();
        s.agents = installed;
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

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            status: RwLock::new(RunnerStatus::default()),
            session_manager: RwLock::new(None),
            cloud: RwLock::new(None),
            token: RwLock::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            logout,
            authorize_in_browser,
            list_agents,
            install_agent
        ])
        .setup(|app| {
            // A bundled .app has nowhere to print: without a log on disk,
            // "I pressed connect and nothing happened" cannot be diagnosed.
            if let Ok(dir) = app.path().app_log_dir() {
                let _ = std::fs::create_dir_all(&dir);
                if let Ok(file) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(dir.join("farol-runner.log"))
                {
                    let _ = tracing_subscriber::fmt()
                        .with_ansi(false)
                        .with_writer(move || file.try_clone().expect("log handle"))
                        .try_init();
                    tracing::info!("log file: {}", dir.join("farol-runner.log").display());
                }
            }

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
            tauri::async_runtime::spawn(async move { start_cloud(handle, None).await });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running runner");
}
