# OpenTag Runner — thin client (Rust + Tauri)

Thin client of the **OpenTag** service: lives in the system tray
on a developer's machine, holds an **outbound** WebSocket connection to the cloud,
and executes tasks from Slack on a local coding agent via **ACP (Agent Client Protocol)**.

## Architecture

```
 Slack                       Cloud (SaaS)                  This client
┌────────┐  Events API   ┌──────────────┐   wss (outbound) ┌──────────────────────┐
│ @bot   │──────────────►│ Task Router  │◄────────────────►│ OpenTag Runner (Tauri)  │
│ in     │               │ + OpenViking │                  │  ├─ cloud.rs   WS+   │
│ thread │               └──────┬───────┘                  │  │           reconnect│
└───▲────┘                      │ AssignTask               │  ├─ acp-client       │
    │  chat.postMessage         │                          │  │    JSON-RPC/stdio  │
    └───────────────────────────┘                          │  ├─ session.rs      │
         (chunk streaming, Approve/Deny buttons, Stop)     │  └─ config.rs +     │
                                                           │     keychain        │
                                                           └─────────┬───────────┘
                                                                     │ spawn
                                                           ┌─────────▼───────────┐
                                                           │ claude-agent-acp /  │
                                                           │ opencode acp (local)│
                                                           └─────────────────────┘
```

Principles:
- **Zero open ports**: the client always initiates the connection itself (`cloud.rs`).
- **Agent as a subprocess**: JSON-RPC 2.0 over stdio, not tied to any specific
  agent — any ACP-compatible one works. The client and the adapter catalogue
  (Claude Code, Codex, Cursor, OpenCode) come from the shared
  [`acp-agents`](https://github.com/farol-team/acp-agents) crates; the desktop
  app installs one on a press, and a hand-written command in `config.json`
  works just as well.
- **Memory from the cloud**: `AssignTurn.memory` contains the OpenViking MCP endpoint;
  the client passes it to the agent on `session/new` — the agent gets the team's memory.
- **Security**: the agent runs only inside directories the person opened up —
  everything under `root_dir` (`~/OpenTag`, where `<workspace>/<channel>` folders are
  derived), any channel `bindings`, and extra `allowed_cwds`; the token lives in
  the OS keychain, not in a file; destructive actions are confirmed via buttons in Slack
  (`session/request_permission` → Slack → `PermissionDecision`).

## Structure

```
runner/
├── crates/opentag-core/       # verified with cargo check ✅
│   ├── src/
│   │   ├── protocol.rs        # cloud ↔ runner message contract
│   │   ├── cloud.rs           # WebSocket loop with reconnect/backoff
│   │   ├── session.rs         # SessionManager: turn policy, memory, permissions
│   │   ├── workspace.rs       # ~/OpenTag/<workspace>/<channel> derivation
│   │   ├── connect.rs         # browser handoff: approve in the dashboard
│   │   └── config.rs          # config + keychain (token)
│   └── examples/
│       └── headless.rs        # headless runner without the Tauri UI (dev/E2E)
└── apps/desktop/              # Tauri 2 application
    ├── ui/index.html          # status/login (no bundler, withGlobalTauri)
    └── src-tauri/
        ├── src/lib.rs         # tray, IPC commands, adapter install
        ├── tauri.conf.json
        └── capabilities/default.json
```

## Build and run

Requirements: Rust stable, Node 18+, [Tauri system dependencies](https://v2.tauri.app/start/prerequisites/).

```bash
cd apps/desktop
npm install
npm run dev      # dev mode with a window
npm run build    # production bundle (.app + .dmg; macOS only for now)
```

The core can be checked on its own: `cargo check` in the workspace root.

Headless mode without the Tauri UI (for dev debugging and E2E tests):

```bash
OPENTAG_RUNNER_TOKEN=frl_... cargo run -p opentag-core --example headless
```

The token is taken from the `OPENTAG_RUNNER_TOKEN` env var (falls back to the OS keychain);
config is the standard `RunnerConfig::load()`. With no token available, the runner
starts the **runner-connect** flow: it prints an authorization URL, the user signs
in with Slack and approves the runner, and the token is delivered automatically
(browser handoff with polling — Slack has no device flow). The desktop app exposes the same flow
via its single "Connect to Slack" button. Headless machines without a browser use
a token issued in the dashboard, passed as `OPENTAG_RUNNER_TOKEN`.

## Protocol (wss, JSON)

| Message | Direction | Purpose |
|---|---|---|
| `hello` | → | auth (token), versions, list of agents |
| `assign_turn` | ← | Slack mention: prompt, thread, cwd, agent, memory config |
| `turn_event` | → | stream: chunk / tool_call / plan / permission_request |
| `permission_decision` | ← | Approve/Deny from a Slack button |
| `cancel_turn` | ← | Stop |
| `turn_result` | → | final status + session_id (for resume) |

## What's next (production)

1. ~~Login via OAuth device flow~~ — done as **runner-connect** (browser handoff
   with polling): "Connect with Slack" in the desktop app, auto-fallback in headless.
2. Auto-updates (`tauri-plugin-updater`) + binary signing.
3. Bind a channel to a folder the person already has (`bindings` in
   `config.json` today, no UI yet).
4. Task queue and concurrency limits (currently: one task — one process).
5. Tests: a mock ACP agent + a mock cloud speaking the protocol.
