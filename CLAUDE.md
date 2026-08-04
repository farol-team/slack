# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A more detailed guide lives in `AGENTS.md` — keep the two in sync when architecture or conventions change.

## What this is

Monorepo for "Slack Memory / Agent Bridge": mentioning the bot in Slack creates a task that runs on a local coding agent on a developer's machine; team memory is stored in OpenViking.

```
Slack ──Events API──► ov-cloud (Python/FastAPI) ──wss──► ov-runner (Rust/Tauri)
     ◄──render to thread──      ▲                            │ spawn
                                │ tRPC (x-internal-secret)   ▼
                          app/ (SaaS panel,           local agent via ACP
                          React + Hono + MySQL)       (claude/gemini --acp, stdio)
```

- **`app/`** — SaaS control plane: React 19 + Vite frontend, Hono + tRPC backend, MySQL via Drizzle, Kimi OAuth. Stores workspaces, runners, channels, tasks, and Slack installations (bot tokens).
- **`ov-cloud/`** — data plane: receives Slack Events (Slack Bolt), holds the `/runner/v1` WebSocket for runners, routes tasks (`TaskRouter`, in-memory), streams events back to Slack threads, writes channel messages to OpenViking. Does **not** store bot tokens — resolves them per-team via `app/`'s tRPC `slack.installationByTeam` with the `x-internal-secret` header.
- **`ov-runner/`** — thin Rust client: Cargo workspace with `crates/runner-core` and a Tauri 2 tray app in `apps/desktop`. Outbound-only wss connection (zero open ports); runs tasks on a local agent over ACP (JSON-RPC 2.0 over stdio).

Memory model: Slack workspace = OpenViking account (tenant boundary). Channel messages are batched (50 msgs / 5 min) into `/{workspace}/resources/slack/{channel}/{date}.md`; the agent gets an OpenViking MCP endpoint via `AssignTask.memory`.

## The protocol is a double mirror — change both sides

`ov-runner/crates/runner-core/src/protocol.rs` (serde, `#[serde(tag = "type", rename_all = "snake_case")]`) and `ov-cloud/app/protocol.py` (pydantic) define the same cloud↔runner contract and must change in lockstep: tags and field names match 1-to-1 in snake_case. Messages: `hello`, `assign_task`, `task_event`, `permission_decision`, `cancel_task`, `task_result`, `ping`/`pong`, `error`.

## Commands

### app/ (npm, Node 20, ESM)
```bash
npm run dev           # Vite dev server on :3000 (Hono via @hono/vite-dev-server)
npm run build         # vite build + esbuild api/boot.ts → dist/boot.js
npm start             # NODE_ENV=production node dist/boot.js
npm run check         # tsc -b (type check)
npm run lint          # eslint .
npm run format        # prettier --write .
npm test              # vitest run (api/**/*.test.ts|spec.ts only)
npx vitest run api/foo.test.ts   # single test file
npm run db:generate | db:migrate | db:push   # drizzle-kit (needs DATABASE_URL)
```

### ov-cloud/ (Python 3.12)
```bash
cp .env.example .env
docker compose up --build      # service on :8000 + OpenViking sidecar on :1933
# or locally: pip install -r requirements.txt && uvicorn app.main:app --port 8000
```

### ov-runner/ (Rust stable)
```bash
cargo check                    # from ov-runner/ — checks the core
cd apps/desktop && npm install
npm run dev                    # cargo tauri dev
npm run build                  # cargo tauri build (.app/.msi/.deb)
# headless runner for E2E dev (no Tauri UI):
OV_RUNNER_TOKEN=ovr_... cargo run -p runner-core --example headless
```

Dev Slack app can be created from `ov-cloud/slack-app-manifest.yaml` (replace `request_url` with your tunnel).

Minimal pre-submit check: `npm run check` + `npm run lint` (app), `cargo check` (ov-runner), uvicorn import/startup (ov-cloud).

## Conventions

- **Doc/comment language:** English everywhere. Legacy comments in `ov-cloud/` and `ov-runner/` may still be in Russian — translate opportunistically when touching them.
- **app/**: path aliases `@/* → src/*`, `@contracts/* → contracts/*`, `@db/* → db/*`. tRPC procedures go through `publicQuery` / `authedQuery` / `adminQuery` from `api/middleware.ts`; transformer is superjson. UI uses shadcn components from `@/components/ui` (40+ available). Prettier: double quotes, semicolons, es5 trailing commas, width 80.
- **DB schema** (`app/db/schema.ts`): PKs are `serial()`; FKs referencing serial PKs must be `bigint("col", { mode: "number", unsigned: true })`. Enums via `mysqlEnum`.
- **Key server files** (`app/api/`): `boot.ts` (Hono entry), `router.ts` (root tRPC router: `auth`, `workspace`, `runner`, `memory`, `billing`, `slack`), `saas-router.ts` (domain logic), `slack-oauth.ts` ("Add to Slack" OAuth v2).
- **Key ov-cloud files** (`ov-cloud/app/`): `main.py` (FastAPI: `/runner/v1` WS, `/slack/events`, `/internal/import/*` behind `x-internal-secret`, `/healthz`), `slack_app.py` (mentions, Approve/Deny/Stop buttons, IngestionBuffer), `task_router.py`, `memory.py` (OpenViking HTTP client).
- **Key runner files** (`ov-runner/crates/runner-core/src/`): `protocol.rs`, `acp.rs` (ACP client), `cloud.rs` (WS loop with reconnect/backoff), `session.rs` (SessionManager), `config.rs` (config + OS keychain for token).

## Testing

Vitest is configured in `app/` (node environment, `api/**/*.test.ts|spec.ts`) but there are **no tests yet** — place new tests next to the code in `api/` matching those patterns. No tests in `ov-cloud/` or `ov-runner/`; a mock ACP agent and mock cloud are planned (see `ov-runner/README.md`).

## Security notes

- Secrets only via env; `.env.example` files are the templates, real `.env` files are gitignored.
- Runner tokens (`ovr_{workspace}_{userkey}`): DB stores only the SHA-256 hash (`runners.tokenHash`); client keeps the token in the OS keychain, not on disk.
- Runner enforces `allowed_cwds` — a hard allowlist of task directories; destructive agent actions require Approve/Deny buttons in Slack.
- Slack OAuth state uses one-time tokens in `slack_oauth_states` (CSRF protection).

## Known MVP limitations

Task state is in-memory (`TaskRouter`); routing picks the first runner in a workspace; Slack streaming is 1 edit/sec message updates; single OpenViking server with account isolation. Production targets for each are listed in `ov-cloud/README.md`.
