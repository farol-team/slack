//! Where an agent works on this machine.
//!
//! The root is `~/Farol`: where an agent spends its days is work, and work
//! belongs in the open — visible in Finder, not buried in app-data like a
//! cache. It stays out of `~/Documents` on purpose too: iCloud evicts files
//! there, and an evicted file mid-turn is a corrupted working tree.

use std::path::{Path, PathBuf};

/// Path-safe form of a name a person chose: letters, digits and dashes.
/// Slack names travel with spaces, emoji and any alphabet at all, and a path
/// segment is not the place to find that out.
pub fn slugify(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "unnamed".into()
    } else {
        trimmed
    }
}

/// `<root>/<workspace>/<channel>`. A workspace and a channel each get their
/// own directory: two channels never share one, and everyone working in the
/// same channel shares it, because they are working on the same thing.
///
/// Ids stand in when Slack gave no name — a directory called `c09ab12` is
/// unlovely but honest, and it is stable.
pub fn derive_path(root: &Path, workspace: &str, channel: &str) -> PathBuf {
    root.join(slugify(workspace)).join(slugify(channel))
}

/// The default root, `~/Farol`, or a relative fallback when there is no home
/// directory to speak of (a container, a daemon with no HOME).
pub fn default_root() -> PathBuf {
    match std::env::var_os("HOME") {
        Some(home) if !home.is_empty() => PathBuf::from(home).join("Farol"),
        _ => PathBuf::from("Farol"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_workspace_and_channel_gets_its_own_directory() {
        let root = Path::new("/data");
        assert_eq!(derive_path(root, "OpenTag", "dev"), PathBuf::from("/data/opentag/dev"));
        assert_ne!(derive_path(root, "OpenTag", "dev"), derive_path(root, "OpenTag", "ops"));
        assert_ne!(derive_path(root, "OpenTag", "dev"), derive_path(root, "Acme", "dev"));
    }

    #[test]
    fn names_people_actually_use_become_paths() {
        assert_eq!(slugify("OpenTag Team"), "opentag-team");
        assert_eq!(slugify("#релизы 🚀"), "unnamed");
        assert_eq!(slugify("--Dev--Ops--"), "dev-ops");
        assert_eq!(slugify(""), "unnamed");
    }

    /// [S4] The work dir is under `~/OpenTag`, not under the old name.
    ///
    /// HOME is read, never set: the variable is process-wide and the tests
    /// run in parallel, so writing it here would race the others.
    #[test]
    fn s4_the_agent_works_under_opentag_in_the_home_directory() {
        let root = default_root();
        assert_eq!(root.file_name().unwrap().to_str().unwrap(), "OpenTag");
        match std::env::var_os("HOME") {
            Some(home) if !home.is_empty() => {
                assert_eq!(root, PathBuf::from(home).join("OpenTag"));
            }
            // No home to speak of: the fallback is still the product name.
            _ => assert_eq!(root, PathBuf::from("OpenTag")),
        }
    }

    /// [S4] ...and `<workspace>/<channel>` hangs off that root, so the path a
    /// person sees in Finder is `~/OpenTag/acme/dev`.
    #[test]
    fn s4_channel_directories_hang_off_the_opentag_root() {
        let root = default_root();
        let path = derive_path(&root, "Acme", "dev");
        assert!(root.ends_with("OpenTag"));
        assert_eq!(path.strip_prefix(&root).unwrap(), Path::new("acme/dev"));
    }
}
