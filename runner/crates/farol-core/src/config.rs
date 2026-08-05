//! Runner configuration: stored in the platform config dir,
//! secrets (tokens) in the OS keychain.

use anyhow::{Context, Result};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const KEYRING_SERVICE: &str = "team.farol.runner";
const KEYRING_USER: &str = "cloud-token";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnerConfig {
    /// Cloud endpoint, e.g. "wss://api.farol.team/runner/v1".
    pub cloud_url: String,
    /// Workspace this runner is bound to (set after login).
    pub workspace_id: Option<String>,
    /// Default agent command, e.g. ["claude", "--acp"] or ["gemini", "--acp"].
    pub agents: Vec<AgentEntry>,
    /// Local paths the agent is allowed to work in (security boundary!).
    pub allowed_cwds: Vec<PathBuf>,
    /// Auto-start on login (Tauri side reads this).
    #[serde(default = "default_true")]
    pub autostart: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEntry {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
}

impl Default for RunnerConfig {
    fn default() -> Self {
        Self {
            cloud_url: "wss://api.farol.team/runner/v1".into(),
            workspace_id: None,
            agents: vec![
                AgentEntry {
                    name: "claude-code".into(),
                    command: "claude".into(),
                    args: vec!["--acp".into()],
                },
                AgentEntry {
                    name: "gemini".into(),
                    command: "gemini".into(),
                    args: vec!["--acp".into()],
                },
            ],
            allowed_cwds: vec![],
            autostart: true,
        }
    }
}

impl RunnerConfig {
    fn config_path() -> Result<PathBuf> {
        let dirs = ProjectDirs::from("team", "farol", "farol-runner")
            .context("cannot resolve config dir")?;
        Ok(dirs.config_dir().join("config.json"))
    }

    pub fn load() -> Result<Self> {
        let path = Self::config_path()?;
        match std::fs::read_to_string(&path) {
            Ok(s) => Ok(serde_json::from_str(&s)?),
            Err(_) => Ok(Self::default()),
        }
    }

    pub fn save(&self) -> Result<()> {
        let path = Self::config_path()?;
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }

    /// Token lives in the OS keychain, never in config.json.
    pub fn token() -> Result<Option<String>> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)?;
        match entry.get_password() {
            Ok(t) => Ok(Some(t)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn set_token(token: &str) -> Result<()> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)?.set_password(token)?;
        Ok(())
    }

    pub fn clear_token() -> Result<()> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)?;
        let _ = entry.delete_credential();
        Ok(())
    }

    /// Security gate: reject any cwd outside the allowlist.
    pub fn is_cwd_allowed(&self, cwd: &std::path::Path) -> bool {
        self.allowed_cwds.iter().any(|base| cwd.starts_with(base))
    }
}
