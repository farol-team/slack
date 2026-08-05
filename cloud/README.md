# Farol Cloud — cloud side (Task Router + Slack + OpenViking)

Server side of the "Farol" service. Companion project to
[`runner`](../runner) — the thin Rust + Tauri client.
The exchange protocol mirrors `runner/crates/farol-core/src/protocol.rs`.

## Components

```
app/
├── protocol.py      # pydantic models, 1-to-1 with the Rust serde (tagged union, snake_case)
├── task_router.py   # runner registry, task lifecycle, thread ↔ task ↔ session
├── slack_app.py     # Slack Bolt: mentions, Approve/Deny/Stop buttons, ingestion buffer
├── memory.py        # OpenViking HTTP client (accounts/users, resources, sessions)
└── main.py          # FastAPI: /runner/v1 (WS), /slack/events, /healthz
```

## Data flows

**Task from Slack → local agent:**
```
@app_mention in a thread
  → TaskRouter.assign() → AssignTask (WS) → runner
  → runner spawns `agent --acp` (cwd checked against the allowlist on the client)
  → TaskEvents stream back:
      agent_message_chunk → chat_update of a single message (≤1 edit/sec, rate-limit safe)
      tool_call / plan    → status replies in the thread
      permission_request  → Block Kit Approve / Deny / Stop buttons
  → buttons → PermissionDecision / CancelTask (WS) → runner → agent
  → TaskResult → final status + Resume button (session_id is stored)
```

**Memory (model C):**
- All channel messages → `IngestionBuffer` (batches of 50 msgs / 5 min) →
  `OpenViking /{workspace}/resources/slack/{channel}/{date}.md`; L0/L1 are generated automatically.
- On connect, the runner passes its OpenViking `user_key` — the cloud forwards it to
  the agent in `AssignTask.memory` as an MCP endpoint → the agent reads the team's memory.
- Multi-tenancy is native: workspace = OpenViking account, ACL is handled by OpenViking itself.

## Running

```bash
cp .env.example .env   # see variables below
docker compose up --build
```

## Slack integration (multi-tenant)

The "Add to Slack" flow lives in the SaaS panel (`app`):
the user clicks the button → OAuth v2 → the callback stores the bot token in
`slack_installations` and syncs the channels. This service **does not store tokens** —
on every Slack event it resolves the bot token by `team_id` via
`slack.installationByTeam` (tRPC, protected by the `x-internal-secret` header).

Variables:
- `FAROL_SAAS_URL` + `INTERNAL_API_SECRET` — link to the SaaS (required; there is
  no single-workspace fallback).

Slack app: scopes `app_mentions:read, channels:read, channels:history,
chat:write, groups:read, groups:history, users:read, users:read.email`
(the last two power BYOA routing: matching the mention author to a SaaS
member by email), Events: `app_mention`,
`message.channels`, Request URL → `https://<host>/slack/events`,
Redirect URL → `https://<saas-host>/api/slack/callback`.
A dev Slack app can be created from the [`slack-app-manifest.yaml`](slack-app-manifest.yaml)
manifest (replace `request_url` with your tunnel).

## MVP decisions and assumptions

| What | Now | Production |
|---|---|---|
| Runner auth | random `frl_*` token, SHA-256 hash in SaaS DB | OAuth device flow, key rotation |
| Task state | in-memory (`TaskRouter`) | Postgres + Redis streams |
| Routing | first runner in the workspace | Slack user → runner mapping |
| Slack streaming | edit 1×/sec | `chat.startStream` API |
| OpenViking | single server, account isolation | per-enterprise instances |

## Relationship with the runner

Full cycle: Slack mention → this service → `wss` → runner (Rust) →
`claude --acp` locally → events back → rendered in the thread. The contract is
verified by round-trip serialization on both sides.
