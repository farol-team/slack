# User Stories — Slack ↔ Local Agent + Shared Farol

Product framing:

- **Bring Your Own Agent (BYOA)**: every developer connects their own machine with their
  own coding agent (Claude Code, Codex, OpenCode, …). A mention runs on the mentioner's runner,
  under the mentioner's identity.
- **Shared Slack memory with Slack-shaped access**: the team's Slack history is the shared
  memory. A user's agent can read exactly the memory of the channels that user can read in
  Slack — no more, no less.

Status legend: ✅ works today · 🟡 partially works · ❌ not implemented.

---

## Epic A — Workspace onboarding (role: admin)

**A1. Add to Slack** — ✅
As a workspace admin, I click "Add to Slack" in the dashboard, approve OAuth, and the bot
appears in my Slack; channels the bot is in are synced to the dashboard.
*Code: `slack.connectUrl` + `handleSlackCallback` (app/api/slack-oauth.ts).*

**A2. Instant history import** — ✅
As an admin, after installing I want the bot to import existing channel history, so the
team memory is useful from day one; I can watch import progress in the dashboard.
*Code: `ImportManager` (cloud/app/importer.py), `slack.importStatus`.*

**A3. Memory tenant auto-provisioning** — ❌ (P0)
As an admin, I don't want to configure OpenViking manually: installing the Slack app must
create the OV account for the workspace and register users, so agent memory keys actually
work.
*Gap: `create_account`/`register_user` (cloud/app/memory.py) are never called;
`ovAccountId`/`ovUserKey` are random strings unknown to OpenViking.*

---

## Epic B — Bring Your Own Agent (role: developer)

**B1. Install the runner** — 🟡
As a developer, I download a signed desktop app that lives in the tray.
*Code: signed and notarized .dmg from `runner-release.yml`. Missing: auto-update
(`tauri-plugin-updater`), start-on-login, and Windows/Linux builds.*

**B2. Connect the runner to the workspace** — ✅
As a developer, I press "Connect to Slack" in the runner, approve it in the browser, and
it connects outbound — zero open ports; the token lives in the OS keychain.
*Code: browser handoff in `connect.rs` + `runner-connect.ts`, `runner.connectApprove`,
`runner.validate`. A dashboard token stays available for headless machines.*

**B3. Agent auto-detection** — ✅
As a developer, the runner finds the adapters I have and installs one on a press, so I
never hand-edit config.json.
*Code: pinned catalog in `agents.rs`, `is_installed` resolution through the login-shell
PATH, `install_agent` IPC; only installed adapters are announced in `hello`.*

**B4. Allowed project folders** — ✅
As a developer, I choose which local directories agents may work in; anything else is
rejected by my machine, not by the cloud.
*Code: `is_cwd_allowed` gate in config.rs, called from session.rs before spawn.*

**B5. My mention → my runner → my agent** — ✅
As a developer, when **I** mention the bot, the task runs on **my** runner with **my**
agent. If I have no runner connected, the bot tells me how to set one up — it must never
run my task on a teammate's machine.
*Code: `pick_runner(workspace, user_key=…)`; the Slack author resolves to a member via
the stored `slackUserId` link or by email (`slack.memberByTeamUser`), and runners
register under that member's key.*

---

## Epic C — Tasks from Slack (role: any member with a runner)

**C1. Start a task by mention** — 🟡
As a user, I mention the bot in a thread with a request; my agent starts working and the
thread becomes the task's home.
*Works modulo the B5 routing fix.*

**C2. Live streaming into the thread** — ✅
As a user, I see the agent's answer streaming as one continuously edited message, plus
tool-call/plan status replies — without flooding the channel.
*Code: SlackRenderer (≤1 edit/sec), task_router.on_task_event.*

**C3. Approve dangerous actions from Slack** — ✅
As a user, when my agent wants to do something destructive, I get Approve/Deny buttons in
the thread; my click resolves the agent's pending permission request on my machine.

**C4. Stop a task** — ✅
As a user, I press Stop and the task ends **and the agent process on my machine dies**.
*Code: `handle_cancel` sends `session/cancel`, shuts the ACP client down and drops the
task entry.*

**C5. Resume a session** — ✅
As a user, I continue a finished task by replying in the same thread; the agent resumes
with full context (`session/load` with the stored session_id).
*Done via the Chat model: a thread is a Chat owning the ACP session; a plain reply by
the chat owner starts a new turn with `resume_session`. Only the owner drives their runner.*

**C6. Pick the project** — 🟡
As a user, work from a channel lands in a folder I recognise, and I can point a channel
at a repository I already have.
*Done: the runner derives `~/Farol/<workspace>/<channel>` and creates it; the cloud sends
names, not paths. Gap: `bindings` (channel → existing folder) has no UI yet, and a
mention cannot override the folder.*

**C7. Pick the agent** — 🟡
As a user with several agents (claude-agent-acp, codex-acp, opencode acp), I choose which one handles a task;
default is per-runner.
*Protocol supports `agent`; no UX for choosing.*

---

## Epic D — Shared memory with Slack-shaped access (role: member / their agent)

**D1. Channels auto-archive into memory** — ✅
As a team, everything said in channels the bot is in becomes memory (batched 50 msgs /
5 min → `/{workspace}/resources/slack/{channel}/{date}.md`), plus the historical import.

**D2. Memory access mirrors Slack access** — ❌ (P0, core of "shared memory")
As a user, my agent can read the memory of exactly the channels I'm a member of in Slack.
Private channels stay private: if I'm not in #secret-project, neither is my agent.
*Requires: per-Slack-user OV identity (link Slack user ↔ SaaS member ↔ `ovUserKey`),
channel-membership sync into OV ACLs (on install + `member_joined_channel`/left events),
and per-channel resource scoping. OpenViking does account-level ACL natively; the
channel-level mapping is ours to build.*

**D3. Agent reads memory via MCP** — ❌ (P0)
As a user, my agent transparently gets a "team-memory" MCP server with **my** key when a
task starts, and can search/read what I can read.
*Gap: `AssignTurn.memory` plumbing exists end-to-end, but no public MCP endpoint is
deployed (`MEMORY_MCP_URL` points at nothing); OV sits inside the docker network. Needs
an MCP proxy in cloud that enforces the user key.*

**D4. Threads become long-term memories** — ❌
As a team, finished task threads and discussions get committed as sessions so OV distills
long-term memories (decisions, preferences, patterns), not just raw logs.
*Code exists (`commit_session`) but is never called.*

**D5. Browse memory in the dashboard** — 🟡
As a member, I can search the team memory in the dashboard — scoped to **my** channels.
*Search works (`memory.search`) but queries with the root key: no per-user scoping —
today any member can search everything, violating D2's principle.*

---

## Epic E — Administration (role: admin)

**E1. Manage runners** — ✅
As an admin, I see the workspace's runners (label, agents, version, last seen) and can
revoke one; revoked tokens stop authenticating.
*Gap inside: `lastSeenAt` only updates on connect — needs the heartbeat (see NFRs).*

**E2. Control who can use the bot** — ❌
As an admin, I choose which Slack users/channels may trigger tasks, so a guest can't run
code on an employee's laptop.

**E3. Plans and limits** — 🟡
As an owner, I set a plan; free plan limits tasks/day.
*`billing.setPlan` stub exists; no enforcement.*

---

## Non-functional (make it not fall apart)

- **N1. Runner presence**: protocol-level ping every ~30s (documented, not implemented) +
  cloud-side timeout; notify the thread if the runner dies mid-task (today the task is
  silently orphaned).
- **N2. Task lifecycle hygiene**: kill agent process on cancel; remove finished tasks
  from `SessionManager.tasks` / `TaskRouter.tasks` (memory leaks today); final stream
  flush on runner disconnect.
- **N3. Task persistence**: write task create/finish into the existing `tasks` table via
  internal API (dashboard "Recent tasks" is empty today; cloud restart loses everything).
- **N4. Installation cache invalidation**: reinstalling the Slack app currently requires
  an cloud restart (unbounded per-team cache).
- **N5. Secrets**: encrypt bot tokens at rest (KMS note already in code), runner-token
  rotation.

---

## MVP cut

The smallest coherent product delivering the promise "bring your own agent + shared
Slack-shaped memory":

1. **B5 + C6** — my mention → my runner, in a folder I chose (includes the routing-id fix).
2. **A3 + D2 + D3** — real OV provisioning, per-user keys mirroring channel membership,
   public MCP endpoint.
3. **C4 + N1 + N2** — stop actually stops; dead runners are detected and reported.
4. Everything else (resume, agent picker, billing, signing, device-flow) is post-MVP.
