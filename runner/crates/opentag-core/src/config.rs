//! Runner configuration: stored in the platform config dir,
//! secrets (tokens) in the OS keychain.

use anyhow::{Context, Result};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const KEYRING_SERVICE: &str = "team.farol.opentag";
const KEYRING_USER: &str = "cloud-token";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnerConfig {
    /// Cloud endpoint, e.g. "wss://opentag-hooks.farol.team/runner/v1".
    pub cloud_url: String,
    /// SaaS control plane URL ("Connect with Slack" flow). A different service
    /// from cloud_url — do not conflate the two.
    #[serde(default = "default_saas_url")]
    pub saas_url: String,
    /// Workspace this runner is bound to (set after login).
    pub workspace_id: Option<String>,
    /// Default agent command, e.g. ["claude", "--acp"] or ["gemini", "--acp"].
    pub agents: Vec<AgentEntry>,
    /// Where derived working directories live: <root>/<workspace>/<channel>.
    /// Everything under it is allowed — the runner made those paths itself.
    #[serde(default = "crate::workspace::default_root")]
    pub root_dir: PathBuf,
    /// Channels bound to a directory the person already had, by Slack channel
    /// id. A binding wins over the derived path: it is the explicit answer to
    /// "where does this channel work".
    #[serde(default)]
    pub bindings: std::collections::HashMap<String, PathBuf>,
    /// Extra paths the agent may work in, beyond the root and the bindings
    /// (security boundary!).
    #[serde(default)]
    pub allowed_cwds: Vec<PathBuf>,
}

fn default_saas_url() -> String {
    "https://opentag.farol.team".into()
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
            cloud_url: "wss://opentag-hooks.farol.team/runner/v1".into(),
            saas_url: default_saas_url(),
            workspace_id: None,
            // The pinned ACP adapters; none of them ships with the runner, so
            // an entry here is an offer, not a promise that it is installed.
            agents: crate::agents::BASELINE
                .iter()
                .map(|p| AgentEntry {
                    name: p.name.into(),
                    command: p.command.into(),
                    args: p.args.iter().map(|a| (*a).to_string()).collect(),
                })
                .collect(),
            root_dir: crate::workspace::default_root(),
            bindings: std::collections::HashMap::new(),
            allowed_cwds: vec![],
        }
    }
}

impl RunnerConfig {
    fn config_path() -> Result<PathBuf> {
        let dirs = ProjectDirs::from("team", "farol", "opentag-runner")
            .context("cannot resolve config dir")?;
        Ok(dirs.config_dir().join("config.json"))
    }

    pub fn load() -> Result<Self> {
        let path = Self::config_path()?;
        match std::fs::read_to_string(&path) {
            Ok(s) => {
                let mut cfg: Self = serde_json::from_str(&s)?;
                if cfg.retire_legacy_agents() {
                    let _ = cfg.save();
                }
                Ok(cfg)
            }
            Err(_) => Ok(Self::default()),
        }
    }

    /// Names earlier builds wrote, pointing at commands that never worked:
    /// `claude --acp` (no such flag) and an npx-fetched adapter. A config
    /// written months ago must not decide what runs today — and it did: the
    /// cloud routes to the first agent announced, so one stale entry at the
    /// front of the list swallowed every turn.
    fn retire_legacy_agents(&mut self) -> bool {
        // Unconditionally: `claude --acp` resolves (the CLI is there, the flag
        // is not), so "is it installed" cannot tell a working entry from a
        // broken one. The catalog covers both names; a person who wants their
        // own command can add it under a name we do not own.
        const RETIRED: &[&str] = &["claude-code", "gemini"];
        let before = self.agents.len();
        self.agents.retain(|a| !RETIRED.contains(&a.name.as_str()));
        // Whatever the catalog offers should be listed, even if absent: the
        // panel shows it as installable and `installed_agent_names` filters.
        for profile in crate::agents::BASELINE {
            if !self.agents.iter().any(|a| a.name == profile.name) {
                self.agents.push(AgentEntry {
                    name: profile.name.into(),
                    command: profile.command.into(),
                    args: profile.args.iter().map(|a| (*a).to_string()).collect(),
                });
            }
        }
        self.agents.len() != before
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

    /// The agents this machine can actually run — what the runner advertises
    /// to the cloud, so a turn is never routed to an adapter that is not here.
    /// `prefix` is the runner's own install dir, when it has one.
    pub fn installed_agent_names(&self, prefix: Option<&std::path::Path>) -> Vec<String> {
        self.agents
            .iter()
            .filter(|a| crate::agents::is_installed(&a.command, prefix))
            .map(|a| a.name.clone())
            .collect()
    }

    /// Security gate: reject any cwd the person has not opened up. Three ways
    /// in — under the root the runner owns, a folder bound to a channel, or an
    /// extra folder added by hand. Everything else is refused before a process
    /// is spawned.
    pub fn is_cwd_allowed(&self, cwd: &std::path::Path) -> bool {
        cwd.starts_with(&self.root_dir)
            || self.bindings.values().any(|base| cwd.starts_with(base))
            || self.allowed_cwds.iter().any(|base| cwd.starts_with(base))
    }

    /// Where a turn from this channel works: the binding if there is one, else
    /// the derived path under the root. The directory is created if missing —
    /// a first mention should not fail because nobody made a folder.
    pub fn workspace_for(
        &self,
        channel_id: &str,
        workspace_name: &str,
        channel_name: &str,
    ) -> std::io::Result<PathBuf> {
        if let Some(bound) = self.bindings.get(channel_id) {
            return Ok(bound.clone());
        }
        let workspace = if workspace_name.is_empty() {
            self.workspace_id.clone().unwrap_or_else(|| "workspace".into())
        } else {
            workspace_name.to_string()
        };
        let channel = if channel_name.is_empty() { channel_id } else { channel_name };
        let dir = crate::workspace::derive_path(&self.root_dir, &workspace, channel);
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }
}
