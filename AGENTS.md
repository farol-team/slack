# AGENTS.md — Farol

## Project overview

Monorepo of three components that together form the "Farol"
service: mentioning the bot in Slack turns into a task executed by a local coding
agent on a developer's machine, while team memory is stored in OpenViking.

```
 Slack ──Events API──► cloud (Python/FastAPI) ──wss──► runner (Rust/Tauri)
      ◄──render to thread──     ▲                            │ spawn
                                │ tRPC (x-internal-secret)   ▼
                          app/ (SaaS panel,           local agent
                          React + Hono + PostgreSQL)       claude/gemini --acp (stdio)
```

- **`app/`** — SaaS control plane: web UI on React 19 + Vite, backend on
  Hono + tRPC, PostgreSQL via Drizzle ORM, authentication via Sign in with
  Slack (OIDC), runner onboarding via runner-connect (browser handoff).
  Stores workspaces, runners, channels, tasks, and Slack installations (bot tokens).
- **`cloud/`** — cloud service (data plane) on Python/FastAPI: receives Slack
  Events (Slack Bolt), holds the `/runner/v1` WebSocket for runners, routes tasks
  (`TaskRouter`), streams events back to Slack, writes channel messages to OpenViking.
  The bot token is resolved per-team via `app/`'s tRPC API (`slack.installationByTeam`,
  `x-internal-secret` header); it does not store tokens itself.
- **`runner/`** — thin Rust client: Cargo workspace with the `crates/farol-core`
  core and a Tauri 2 desktop app in `apps/desktop`. Lives in the tray, holds an
  **outbound** wss connection to the cloud (zero open ports), executes tasks on a
  local agent via ACP (JSON-RPC 2.0 over stdio).

Memory model: Slack workspace = OpenViking account (tenant boundary); channel
messages are written in batches (50 msgs / 5 min) to
`/{workspace}/resources/slack/{channel}/{date}.md`; the agent receives the
OpenViking MCP endpoint via `AssignTurn.memory`.

## Code structure

### app/ (TypeScript, Node 20, ESM)
- `api/` — server side: `boot.ts` (Hono entry point), `router.ts` (root tRPC
  router: `auth`, `workspace`, `runner`, `memory`, `billing`, `slack`),
  `middleware.ts` (`publicQuery`/`authedQuery`/`adminQuery` procedures),
  `saas-router.ts` (SaaS domain logic), `slack-oauth.ts` (OAuth v2 "Add to Slack"),
  `identity/` (Slack OIDC sign-in + session), `queries/` (DB access), `lib/` (env, cookies, vite integration).
- `contracts/` — types/constants shared between client and server (re-exports types from `db/schema`).
- `db/` — Drizzle ORM: `schema.ts`, `relations.ts`, `seed.ts`, `migrations/` (PostgreSQL).
- `src/` — frontend: `main.tsx`, `App.tsx` (react-router: `/`, `/login`,
  `/dashboard/{runners,memory,settings}`), `pages/`, `components/ui/` (shadcn, 40+
  components), `hooks/`, `providers/trpc.tsx`.
- Path aliases (vite + tsconfig): `@/* → src/*`, `@contracts/* → contracts/*`,
  `@db/* → db/*`.

### cloud/ (Python 3.12)
- `app/protocol.py` — pydantic protocol models, mirror of `protocol.rs`.
- `app/chat_router.py` — ChatRouter: chats (thread = conversation), turns, runner registry (in-memory).
- `app/slack_app.py` — Slack Bolt: mentions, Approve/Deny/Stop buttons, IngestionBuffer.
- `app/memory.py` — OpenViking HTTP client (trusted mode: identity via
  `X-OpenViking-*` headers). `app/importer.py` — channel history import.
- `app/gateway.py` — agent-facing memory gateway: `/memory/mcp` proxies native
  OpenViking MCP with signed task tokens scoped to the mention's channel.
- `app/main.py` — FastAPI: `/runner/v1` (WS), `/slack/events`, `/memory/mcp`,
  `/internal/provision`, `/internal/import/*` (protected by `x-internal-secret`),
  `/healthz`.

### runner/ (Rust, edition 2021)
- `crates/farol-core/src/` — `protocol.rs` (message contract, serde tagged union),
  `acp.rs` (ACP client), `cloud.rs` (WS loop with reconnect/backoff), `session.rs`
  (SessionManager), `config.rs` (config + OS keychain for the token).
- `crates/farol-core/examples/headless.rs` — headless runner without the Tauri UI
  (dev debugging and E2E tests).
- `apps/desktop/` — Tauri 2: `ui/index.html` (no bundler, withGlobalTauri),
  `src-tauri/` (tray, IPC commands, autostart).

## Build and test commands

### app/ (npm)
```bash
npm run dev           # Vite dev server on :3000 (Hono via @hono/vite-dev-server)
npm run build         # vite build + esbuild api/boot.ts → dist/boot.js
npm start             # NODE_ENV=production node dist/boot.js (PORT or 3000)
npm run check         # tsc -b (type check, tsconfig.app/node/server)
npm run lint          # eslint .
npm run format        # prettier --write .
npm test              # vitest run (api/**/*.test.ts|spec.ts only)
npm run db:generate   # drizzle-kit generate (needs DATABASE_URL)
npm run db:migrate    # drizzle-kit migrate
npm run db:push       # drizzle-kit push
```

### cloud/ (Python)
```bash
cp .env.example .env
docker compose up --build   # brings up the service on :8000 + OpenViking on :1933
# locally: pip install -r requirements.txt && uvicorn app.main:app --port 8000
```

### runner/ (Rust)
```bash
cargo check                        # check the core (from runner/ root)
cd apps/desktop && npm install
npm run dev                        # cargo tauri dev
npm run build                      # cargo tauri build (.app/.msi/.deb)

# headless runner without the Tauri UI (for dev/E2E):
FAROL_RUNNER_TOKEN=frl_... cargo run -p farol-core --example headless
```
The headless-mode token is taken from the `FAROL_RUNNER_TOKEN` env var, otherwise from
the OS keychain; config is the standard `RunnerConfig::load()`.

Requirements: Rust stable, Node 18+, Tauri 2 system dependencies.

## Code conventions

- **Documentation/comment language:** English everywhere. (Legacy comments in
  `cloud/` and `runner/` may still be in Russian — translate opportunistically
  when touching them.)
- **app/**: Prettier (double quotes, semi, trailing comma es5, width 80), ESLint flat
  config (tseslint recommended + react-hooks + react-refresh). tRPC procedures go
  through `publicQuery` / `authedQuery` / `adminQuery` from `api/middleware.ts`;
  transformer — superjson. UI — shadcn components from `@/components/ui`.
- **DB schema** (`app/db/schema.ts`): PostgreSQL (drizzle pg-core). PKs are `serial()`;
  FKs referencing serial PKs use `integer("col")`. Enums — `pgEnum`, declared at the
  top of the file.
- **Cloud ↔ runner protocol is a double mirror**: `runner/crates/farol-core/src/protocol.rs`
  (serde, `#[serde(tag = "type", rename_all = "snake_case")]`) and
  `cloud/app/protocol.py` (pydantic) must change in lockstep; snake_case tags and
  field names match 1-to-1. The contract is verified by round-trip serialization.
- Protocol messages: `hello`, `assign_turn`, `turn_event`, `permission_decision`,
  `cancel_turn`, `turn_result`, `ping`/`pong`, `error`.

## Testing

- Vitest is configured in `app/` (`vitest.config.ts`, `node` environment, includes
  `api/**/*.test.ts` / `*.spec.ts`) — **no tests yet**; place new tests next to the
  code in `api/` matching these patterns.
- No tests in `cloud/` or `runner/`; for the runner, a mock ACP agent and a
  mock cloud speaking the protocol are planned (see `runner/README.md`).
- Minimal pre-submit check: `npm run check` + `npm run lint` (app),
  `cargo check` (runner), uvicorn import/startup (cloud).

## Development workflow (agent-flow)

- Tasks are GitHub Issues in this repo; pipeline states are `flow:*` labels
  (backlog → plan-proposed → ready → in-progress → review/done), priorities
  are `P0`/`P1`/`P2` labels. Migrated from the former Trello board
  "Slack Agent Bridge — MVP" (2026-08).
- The [farol-team/agent-flow](https://github.com/farol-team/agent-flow) kit
  drives the pipeline: `/flow-check` triages backlog issues into PLANs, a
  human approves by swapping the label to `flow:ready`, `/flow-run` executes
  in an isolated worktree under `.gilb/worktrees/` (gitignored).
- Kit files (`.claude/{commands,prompts,hooks,bin,providers}`) are synced
  from the canonical repo via `bin/workflow-kit-sync` and pinned by
  `.claude/KIT_REVISION` — never edit them in this repo; CI
  (`.github/workflows/kit.yml`) fails the PR if they drift.
- Project-owned config: `.claude/tracker.json` (targets app/cloud/runner,
  card prefix FRL), `.claude/constitution.md` (non-negotiables incl. the
  protocol double-mirror rule), `.claude/project-context.md` (what workers
  read before touching code).

## Security

- Secrets only via env: `app/.env.example`, `cloud/.env.example` are templates;
  do not commit real `.env` files (covered by `.gitignore`).
- Runner tokens (random `frl_*`, issued by `runner.createToken`, validated via
  `runner.validate` — no offline/legacy format): the DB stores only the SHA-256 hash
  (`runners.tokenHash`); on the client the token lives in the OS keychain, not in a file.
- Slack bot tokens are stored in `slack_installations` (note in code: encrypt via KMS
  in production). Internal SaaS ↔ cloud calls are protected by the
  `x-internal-secret` header (`INTERNAL_API_SECRET`).
- On the runner, `allowed_cwds` is a hard allowlist of task directories; destructive
  agent actions are confirmed via Approve/Deny buttons in Slack.
- Slack OAuth state — one-time tokens in `slack_oauth_states` (CSRF protection).

## Deployment and environment

- **cloud**: `docker compose up --build` (Dockerfile on `python:3.12-slim`, uvicorn
  on :8000) + `volcengine/openviking:latest` sidecar on :1933 (volume `ov-data`).
- **app**: `npm run build && npm start`; static files from `dist/public`, server — `dist/boot.js`.
- **runner**: Tauri bundles (`npm run build` in `apps/desktop`); signing and
  auto-updates (`tauri-plugin-updater`) are planned.
- Slack app: Request URL → `https://<host>/slack/events` (cloud), Redirect URL →
  `https://<saas-host>/api/slack/callback` (app); scopes and events are listed in
  `cloud/README.md`. A dev Slack app can be created from the
  `cloud/slack-app-manifest.yaml` manifest (replace `request_url` with your tunnel).

## Known MVP limitations (from cloud/README.md)

Task state is in-memory (`TaskRouter`) (production: Postgres + Redis); routing picks
the first runner in a workspace; Slack streaming is 1 edit/sec (production:
`chat.startStream`); a single OpenViking server with account isolation.
