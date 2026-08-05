//! The ACP adapters this runner knows about: what each is called, what it
//! runs, and what having it would take. Data plus two decisions — nothing
//! here reaches the machine, and nothing here installs anything.

use std::path::{Path, PathBuf};

/// An adapter this project has pinned. A person may still name any command
/// they like in config.json; a profile is what lets the app say something
/// truthful about one without being told.
#[derive(Debug, Clone)]
pub struct AgentProfile {
    pub name: &'static str,
    pub label: &'static str,
    pub command: &'static str,
    pub args: &'static [&'static str],
    /// What to fetch. The runner carries no agent, so every profile has one.
    pub package: &'static str,
    pub docs_url: &'static str,
}

/// The three, in the order they are shown. Claude leads because it is what a
/// mention runs when nobody has said otherwise — not because it is more
/// present than the others. None of them ships with the runner.
///
/// Commands and packages match the WorkRoom baseline (verified against the
/// registry 2026-08-01): the command is the one `npm view <package> bin`
/// reports, which is what ends up on the machine.
pub const BASELINE: &[AgentProfile] = &[
    AgentProfile {
        name: "claude",
        label: "Claude Code",
        command: "claude-agent-acp",
        args: &[],
        package: "@agentclientprotocol/claude-agent-acp",
        docs_url: "https://docs.claude.com/en/docs/claude-code/overview",
    },
    AgentProfile {
        name: "codex",
        label: "Codex",
        command: "codex-acp",
        args: &[],
        package: "@agentclientprotocol/codex-acp",
        docs_url: "https://developers.openai.com/codex/cli/",
    },
    AgentProfile {
        name: "opencode",
        label: "OpenCode",
        command: "opencode",
        args: &["acp"],
        package: "opencode-ai",
        docs_url: "https://opencode.ai/docs/acp/",
    },
];

/// The profile for a name, when this project pinned one. An agent nobody
/// pinned is not an error — it is somebody's own, and belongs beside these.
pub fn profile_for(name: &str) -> Option<&'static AgentProfile> {
    let name = name.to_lowercase();
    BASELINE.iter().find(|p| p.name == name)
}

/// Where the machine says the command is — the runner's own prefix first, then
/// PATH — or None for nowhere. One question, asked of the machine: an adapter
/// this project pinned is in exactly the state one it never heard of would be.
pub fn resolve(command: &str, prefix: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = prefix {
        let candidate = p.join("bin").join(command);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(command))
        .find(|c| c.is_file())
}

/// Whether a configured agent can actually be spawned right now. A command
/// with a path in it is checked where it points — that is what `install`
/// writes into config.json; a bare name is looked up as `resolve` does.
pub fn is_installed(command: &str, prefix: Option<&Path>) -> bool {
    let p = Path::new(command);
    if p.components().count() > 1 {
        return p.is_file();
    }
    resolve(command, prefix).is_some()
}

/// The one command installing this adapter would run.
///
/// Into a prefix the runner owns, never the person's own node installation:
/// what Farol fetches, Farol keeps to itself. The prefix is quoted because the
/// app data directory on macOS has a space in it, and an unquoted one reads as
/// another package to install.
pub fn install_command(profile: &AgentProfile, prefix: &Path) -> String {
    format!(
        "npm install -g --prefix \"{}\" {}",
        prefix.display(),
        profile.package
    )
}
