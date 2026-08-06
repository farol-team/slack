//! The ACP adapters this runner knows about: what each is called, what it
//! runs, and what having it would take. Data plus two decisions — nothing
//! here reaches the machine, and nothing here installs anything.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

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

/// The PATH a person's terminal would have. An app launched from Finder or the
/// dock inherits a bare one — no Homebrew, no nvm — so `npm`, and the `node`
/// an adapter's shebang resolves, are both invisible until the login shell is
/// asked. Answered once: starting a shell is not free.
pub fn login_path() -> Option<String> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE.get_or_init(ask_the_shell).clone()
}

/// Ask once, and give up after two seconds. An interactive shell is somebody
/// else's config: it can print a prompt, wait on a tty, or simply take its
/// time, and none of that may hold up a turn that Slack is waiting on.
fn ask_the_shell() -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let out = std::process::Command::new(shell)
            .args(["-ilc", "printf %s \"$PATH\""])
            .stdin(std::process::Stdio::null())
            .output();
        let _ = tx.send(out.ok().map(|o| {
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        }));
    });
    match rx.recv_timeout(std::time::Duration::from_secs(2)) {
        Ok(Some(path)) if !path.is_empty() => Some(path),
        _ => None,
    }
}

/// Where package managers put things when the shell cannot be asked. Not a
/// guess about this machine — a list of the places that exist on it.
fn common_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        dirs.push(home.join(".volta/bin"));
        dirs.push(home.join(".bun/bin"));
        // nvm keeps one directory per installed node version.
        if let Ok(versions) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            for v in versions.flatten() {
                dirs.push(v.path().join("bin"));
            }
        }
    }
    dirs.into_iter().filter(|d| d.is_dir()).collect()
}

/// PATH to hand a child process: the runner's own bin dir first, then whatever
/// the person's shell would have had, then this process's own.
pub fn spawn_path(prefix: Option<&Path>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(p) = prefix {
        parts.push(p.join("bin").display().to_string());
    }
    if let Some(p) = login_path() {
        parts.push(p);
    }
    if let Some(p) = std::env::var_os("PATH").and_then(|p| p.into_string().ok()) {
        parts.push(p);
    }
    for dir in common_bin_dirs() {
        parts.push(dir.display().to_string());
    }
    parts.join(":")
}

/// Where the machine says the command is — the runner's own prefix first, then
/// the shell's PATH — or None for nowhere. One question, asked of the machine:
/// an adapter this project pinned is in exactly the state one it never heard
/// of would be.
pub fn resolve(command: &str, prefix: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = prefix {
        let candidate = p.join("bin").join(command);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    std::env::split_paths(&spawn_path(prefix))
        .map(|dir| dir.join(command))
        .find(|c| c.is_file())
}

/// Package runners: finding one of these on the machine says nothing about
/// whether the adapter behind it is there. `npx -y <pkg>` resolves, announces
/// itself as ready, and then spends a minute fetching — or fails — inside a
/// turn somebody is waiting on in Slack.
const PROXIES: &[&str] = &["npx", "npm", "pnpm", "pnpx", "yarn", "bunx", "uvx"];

/// Whether a configured agent can actually be spawned right now. A command
/// with a path in it is checked where it points — that is what `install`
/// writes into config.json; a bare name is looked up as `resolve` does.
pub fn is_installed(command: &str, prefix: Option<&Path>) -> bool {
    let p = Path::new(command);
    let leaf = p.file_name().and_then(|n| n.to_str()).unwrap_or(command);
    if PROXIES.contains(&leaf) {
        return false;
    }
    if p.components().count() > 1 {
        return p.is_file();
    }
    resolve(command, prefix).is_some()
}

