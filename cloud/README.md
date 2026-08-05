# Farol Cloud — cloud side (Task Router + Slack + OpenViking)

Server side of the "Farol" service. Companion project to
[`runner`](../runner) — the thin Rust + Tauri client.
The exchange protocol mirrors `runner/crates/farol-core/src/protocol.rs`.

## Components

```
app/
├── protocol.py      # pydantic models, 1-to-1 with the Rust serde (tagged union, snake_case)
├── chat_router.py   # ChatRouter: chats (thread = conversation), turns, runner registry
├── slack_app.py     # Slack Bolt: mentions, follow-up turns, buttons, ingestion buffer
├── gateway.py       # /memory/mcp — channel-scoped proxy of OpenViking MCP
├── memory.py        # OpenViking HTTP client (trusted mode)
└── main.py          # FastAPI: /runner/v1 (WS), /slack/events, /memory/mcp, /healthz
```

## Data flows

**Turn from Slack → local agent:**
```
@app_mention in a thread (opens a Chat; replies are follow-up turns)
  → ChatRouter.start_turn() → AssignTurn (WS) → the author's own runner (BYOA)
  → runner spawns `agent --acp` (cwd checked against the allowlist on the client)
  → TurnEvents stream back:
      agent_message_chunk → chat_update of a single message (≤1 edit/sec, rate-limit safe)
      tool_call / plan    → status replies in the thread
      permission_request  → Block Kit Approve / Deny / Stop buttons
  → buttons → PermissionDecision / CancelTurn (WS) → runner → agent
  → TurnResult → final status; the ACP session folds into the Chat, a plain
    reply by the owner resumes it
```

**Memory (channel-scoped, via the gateway):**
- All channel messages → `IngestionBuffer` (batches of 50 msgs / 5 min) →
  OpenViking `viking://resources/slack/{channel_id}/{date}.md` (account = workspace);
  L0/L1 are generated automatically. The historical import uses the same layout.
- OpenViking runs in **trusted mode**: only this service talks to it, injecting
  `X-OpenViking-Account` / `X-OpenViking-User` headers (root key authorizes us as the
  identity-injecting upstream). Configure `ov.conf` with `auth_mode: "trusted"` and
  `root_api_key` = `OPENVIKING_ROOT_KEY`.
- Agents never see OpenViking directly. `AssignTurn.memory` carries our
  **memory gateway** (`/memory/mcp`, see `app/gateway.py`) plus a signed task token
  scoped to the mention's channel: the gateway proxies native OpenViking MCP tools
  and rejects any call whose target URI leaves `viking://resources/slack/{channel}/`.
  Audience rule: a reply is visible to the whole channel, so the agent must not read
  what that channel's members can't.
- The OV account is provisioned on install: SaaS OAuth callback → `/internal/provision`.

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
- `FAROL_CLOUD_PUBLIC_URL` — public base URL of this service; agents reach the
  memory gateway at `…/memory/mcp` (point it at your tunnel in dev).

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
