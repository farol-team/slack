# Release — Farol Runner

How a build of the desktop app and the headless binaries reaches people, and
how installed copies replace themselves. The SaaS and the cloud data plane
deploy differently — see `deploy.md`.

Everything below is driven by `.github/workflows/runner-release.yml`, which
runs on tags matching `runner-v*`.

## What a release contains

| Asset | What it is |
|---|---|
| `farol-runner-macos.dmg` | the desktop app; signed, notarized, stapled |
| `farol-runner-macos.app.tar.gz` | the same app as the updater downloads it |
| `latest.json` | the update feed installed copies poll |
| `farol-runner-darwin-arm64` / `-x64` | headless runner for servers and CI |

The dashboard links to `releases/latest/download/farol-runner-macos.dmg`, and
the updater polls `releases/latest/download/latest.json` — both follow whatever
GitHub currently marks as the latest release, which is also how a rollback
works (see below).

## The one rule

**A tag is a version, and a version is used once.** CI parses `runner-vX.Y.Z`,
rejects anything else, and patches `tauri.conf.json` and `Cargo.toml` before
building. Reusing a tag is invisible to a person downloading the `.dmg` and
fatal to the updater: it compares versions, so a build that keeps calling
itself `0.1.0` can never replace itself.

## Cutting a release

```bash
git tag runner-v0.1.2          # next unused version
git push origin runner-v0.1.2
gh run watch $(gh run list --workflow runner-release --limit 1 --json databaseId --jq '.[0].databaseId')
```

That is the whole procedure. No version is edited by hand in the repo — the
values there are the development baseline, and CI overwrites them from the tag.

## What CI does

1. **Headless binaries** — builds `farol-core --example headless` for
   `aarch64-apple-darwin` and `x86_64-apple-darwin` (the x64 target
   cross-compiles on the arm64 runner: one Apple SDK covers both, and the
   `macos-13` Intel queue is measured in hours). Each binary is signed with
   hardened runtime and notarized. A bare Mach-O cannot be stapled, so
   Gatekeeper resolves those tickets online on first run.
2. **Desktop app** — patches the version from the tag, imports the Developer ID
   certificate into a throwaway keychain, and runs
   `tauri build --target universal-apple-darwin`. Tauri notarizes and staples
   the `.app`; the workflow then notarizes and staples the `.dmg` as well,
   because the `.dmg` is what Gatekeeper checks when someone double-clicks it.
3. **Update feed** — the bundler emits `*.app.tar.gz` and a `.sig` next to it
   (`bundle.createUpdaterArtifacts` in `tauri.conf.json`); the workflow writes
   `latest.json` carrying the version, the signature and the download URL.
4. **Publish** — `softprops/action-gh-release` attaches everything to the tag.

Bundles land in the Cargo **workspace** target dir
(`runner/target/universal-apple-darwin/release/bundle/...`), not under
`src-tauri/` — a wrong path here fails the notarization step with a confusing
"must be a zip archive" error.

## Secrets

| Secret | Used for | Absent → |
|---|---|---|
| `APPLE_CERTIFICATE` | base64 `.p12`, Developer ID Application | macOS builds succeed, unsigned |
| `APPLE_CERTIFICATE_PASSWORD` | password of that `.p12` | same |
| `APPLE_ID`, `APPLE_PASSWORD` | Apple ID + app-specific password | notarization skipped |
| `APPLE_TEAM_ID` | Developer Team ID (`83856566PM`) | notarization skipped |
| `TAURI_SIGNING_PRIVATE_KEY` | signs the updater artifact | **no `.sig`, the release step fails** |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password (empty here) | same |

The Apple secrets are account-level, not app-level: the same certificate signs
any number of products, and Apple allows only five Developer ID certificates
per team — do not mint one per project.

## How auto-update works

An installed app asks `latest.json` on every launch. If the version there is
newer, it downloads the tarball, verifies the signature against the public key
compiled into it, and installs beside the running copy; the window then says so
and the change takes effect on the next launch.

Consequences worth remembering:

- **The public key is part of the app.** Changing the key pair orphans every
  installed copy — they will reject the feed and never update again. Rotating
  it means asking everyone to reinstall by hand.
- **Losing the private key is the same thing** in slower motion: no future
  release can be signed for the installed copies.
- **Only the desktop app updates itself.** Headless binaries have no updater;
  on a server, updating means fetching the new binary or rolling a new
  container image.

## Verifying a release

```bash
# the feed is well formed and points at a real file
curl -sL https://github.com/farol-team/slack/releases/latest/download/latest.json | jq '.version, .platforms | keys'
curl -sIL https://github.com/farol-team/slack/releases/latest/download/farol-runner-macos.app.tar.gz | grep -E '^HTTP|content-length'

# the disk image is a real UDIF image carrying our identity
curl -sL -o /tmp/farol.dmg https://github.com/farol-team/slack/releases/latest/download/farol-runner-macos.dmg
python3 -c 'd=open("/tmp/farol.dmg","rb").read(); print("UDIF:", d[-512:-508]==b"koly", "signed:", b"83856566PM" in d)'

# Apple accepted it and the ticket is attached
gh run view <run-id> --json jobs --jq '.jobs[]|select(.name|startswith("desktop"))|.databaseId' \
  | xargs -I{} gh run view --job {} --log | grep -iE 'building version|status: Accepted|staple and validate'
```

On a Mac, `spctl -a -t open --context context:primary-signature -v farol-runner-macos.dmg`
is the direct check; from anywhere else the greps above are the practical
substitute.

## Rolling back

The updater and the dashboard both follow `releases/latest`, so a bad release
is undone by moving that marker rather than by deleting anything:

```bash
gh release edit runner-v0.1.1 -R farol-team/slack --latest   # the known-good one
```

Installed copies keep the newer version they already have — an updater only
moves forward — but nobody new downloads the bad build, and the next good
release (a higher version) supersedes it everywhere.

## Linux

The Linux headless build is parked: the matrix entry
(`ubuntu-22.04` / `x86_64-unknown-linux-gnu` → `farol-runner-linux-x64`) is
commented out in the workflow, and the dashboard shows "Linux — soon". Putting
the entry back is the whole change; nothing else in the pipeline is
macOS-specific except the signing steps, which are already guarded by
`runner.os == 'macOS'`.

A Linux runner takes its token from `FAROL_RUNNER_TOKEN`. Do not rely on the
browser-approval flow there: on Linux the keyring stores the token in kernel
keys, which do not survive a reboot, so a server would come back with no
credentials and no way to say so.
