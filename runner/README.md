# Farol Runner — thin client (Rust + Tauri)

Thin client of the **Farol** service: lives in the system tray
on a developer's machine, holds an **outbound** WebSocket connection to the cloud,
and executes tasks from Slack on a local coding agent via **ACP (Agent Client Protocol)**.

## Architecture

```
 Slack                       Cloud (SaaS)                  This client
┌────────┐  Events API   ┌──────────────┐   wss (outbound) ┌──────────────────────┐
│ @bot   │──────────────►│ Task Router  │◄────────────────►│ Farol Runner (Tauri)    │
│ in     │               │ + OpenViking │                  │  ├─ cloud.rs   WS+   │
│ thread │               └──────┬───────┘                  │  │           reconnect│
└───▲────┘                      │ AssignTask               │  ├─ acp.rs   JSON-RPC│
    │  chat.postMessage         │                          │  │           over stdio
    └───────────────────────────┘                          │  ├─ session.rs      │
         (chunk streaming, Approve/Deny buttons, Stop)     │  └─ config.rs +     │
                                                           │     keychain        │
                                                           └─────────┬───────────┘
                                                                     │ spawn
                                                           ┌─────────▼───────────┐
                                                           │ claude --acp /      │
                                                           │ gemini --acp (local)│
                                                           └─────────────────────┘
```

Principles:
- **Zero open ports**: the client always initiates the connection itself (`cloud.rs`).
- **Agent as a subprocess**: JSON-RPC 2.0 over stdio (`acp.rs`), not tied to any
  specific agent — any ACP-compatible one works (Claude Code, Gemini CLI, Codex, Kimi CLI…).
- **Memory from the cloud**: `AssignTurn.memory` contains the OpenViking MCP endpoint;
  the client passes it to the agent on `session/new` — the agent gets the team's memory.
- **Security**: `allowed_cwds` is a hard allowlist of directories; the token lives in
  the OS keychain, not in a file; destructive actions are confirmed via buttons in Slack
  (`session/request_permission` → Slack → `PermissionDecision`).

## Structure

```
runner/
├── crates/farol-core/        # verified with cargo check ✅
│   ├── src/
│   │   ├── protocol.rs        # cloud ↔ runner message contract
│   │   ├── acp.rs             # ACP client (JSON-RPC stdio)
│   │   ├── cloud.rs           # WebSocket loop with reconnect/backoff
│   │   ├── session.rs         # SessionManager: task → ACP session
│   │   └── config.rs          # config + keychain (token)
│   └── examples/
│       └── headless.rs        # headless runner without the Tauri UI (dev/E2E)
└── apps/desktop/              # Tauri 2 application
    ├── ui/index.html          # status/login (no bundler, withGlobalTauri)
    └── src-tauri/
        ├── src/lib.rs         # tray, IPC commands, autostart
        ├── tauri.conf.json
        └── capabilities/default.json
```

## Build and run

Requirements: Rust stable, Node 18+, [Tauri system dependencies](https://v2.tauri.app/start/prerequisites/).

```bash
cd apps/desktop
npm install
npm run dev      # dev mode with a window
npm run build    # production bundles (.app/.msi/.deb)
```

The core can be checked on its own: `cargo check` in the workspace root.

Headless mode without the Tauri UI (for dev debugging and E2E tests):

```bash
FAROL_RUNNER_TOKEN=frl_... cargo run -p farol-core --example headless
```

The token is taken from the `FAROL_RUNNER_TOKEN` env var (falls back to the OS keychain);
config is the standard `RunnerConfig::load()`. With no token available, the runner
starts the **runner-connect** flow: it prints an authorization URL, the user signs
in with Slack and approves the runner, and the token is delivered automatically
(browser handoff with polling — Slack has no device flow). The desktop app exposes
the same flow via the "Connect with Slack" button; pasting a token remains as a
fallback.

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
3. Detect installed agents (`which claude`, `which gemini`) on startup.
4. Task queue and concurrency limits (currently: one task — one process).
5. Tests: a mock ACP agent + a mock cloud speaking the protocol.
