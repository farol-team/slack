# Constitution

Non-negotiable engineering articles for this repo. Every PLAN is validated
against these articles BEFORE work starts (`## Constitution gate` — one
verdict per article: `pass` / `n/a` / `violates — <justification>`), and
the acceptance check re-validates the actual DIFF after.

Enforcement touchpoints:
1. `/flow-check` (card-eval) — every code PLAN must contain a
   `## Constitution gate` section; a `violates` without justification
   fails self-check.
2. Worker — the gate section is part of the PLAN contract.
3. Acceptance check — re-verifies the DIFF against each article;
   violations are Critical gaps.

Amendment procedure: articles are added/changed by PR only, each with a
one-line rationale citing the incident or decision that motivated it.
Articles are numbered and never renumbered — retired articles are marked
`(retired)`, not deleted.

---

## Universal articles (any project using this kit)

### Article I — Test-First
No production code before a failing test that demands it. The RED phase
counts only when the test fails **for the right reason** (the feature is
missing) — not a typo, not a broken setup. Tests are committed separately
and before the implementation. Tests assert BEHAVIOR, not implementation
details. A test that would still pass if the feature body were replaced
with `return nil` is not a test.

### Article II — Evidence Before Claims
No completion claims without fresh verification evidence. "Done", "fixed",
"passing" require the actual command output from THIS session. Banned as
substitutes: "should work", "probably", "I'm confident", "seems to". When
delegating to a subagent, verify its result independently.

### Article III — Simplicity & Anti-Abstraction
Use the framework directly; do not wrap it. No abstraction until the
second concrete use exists. The minimal diff that satisfies the plan wins.
Do not add error handling for scenarios that cannot happen.

### Article IV — Scope Discipline
Only the files in the PLAN's `## Files`; `## Out of scope` is inviolable.
If reality contradicts the plan mid-work — BLOCKED, not improvisation.

### Article V — Integration-First Testing
Prefer realistic environments: the real database over mocks, the actual
queue adapter over stubs. Mock only at true process boundaries (external
HTTP APIs, paid services, clock).

---

## Project articles (all targets)

### Article P1 — The Protocol Is a Double Mirror
*(Rationale: the cloud↔runner wire contract is defined twice — serde and
pydantic — and drift between them fails only at runtime, on a user's
machine.)*
Any change to `runner/crates/farol-core/src/protocol.rs` MUST land in the
same diff as the matching change to `cloud/app/protocol.py`, and vice
versa. Tags and field names match 1-to-1 in snake_case. A diff touching
one file without the other requires an explicit `n/a` justification
(e.g. a comment-only change).

### Article P2 — Secrets Never Rest in Plaintext We Control
*(Rationale: runner tokens grant shell-adjacent access to a developer's
machine; the DB already stores only SHA-256 hashes of `frl_*` tokens and
clients keep them in the OS keychain.)*
Secrets enter only via env (`.env` gitignored, `.env.example` is the
template). Never log a token, write one to disk, or add a DB column
holding a raw credential. Runner tokens: hash-only in DB, keychain-only
on the client.

### Article P3 — English Everywhere in Code
*(Rationale: standing repo convention; legacy Russian comments in
`cloud/` and `runner/` are being translated opportunistically.)*
New code comments, docs, commit messages and identifiers are English.
When touching a line adjacent to a Russian comment, translate it.

## Project articles (app)

### Article A1 — tRPC Only Through the Middleware Gates
*(Rationale: auth and admin checks live in `api/middleware.ts`; a raw
procedure silently skips them.)*
Every tRPC procedure is built from `publicQuery` / `authedQuery` /
`adminQuery` (and their mutation counterparts) — never from bare
`t.procedure`. Schema changes follow `db/schema.ts` conventions:
`serial()` PKs, `integer()` FKs, `pgEnum` declared at the top.

## Project articles (cloud)

### Article C1 — The Tenant Boundary Is the Gateway
*(Rationale: OpenViking runs in trusted mode — cloud/ is the only
component allowed to talk to it; one leaked header pair crosses a
workspace boundary.)*
Agents reach memory ONLY through `/memory/mcp` (`gateway.py`) with a
signed task token scoped to the mention's channel. No code path may call
OV with account/user headers derived from anything but the authenticated
context. cloud/ never stores Slack bot tokens — always resolve per-team
via `slack.installationByTeam` with `x-internal-secret`.

## Project articles (runner)

### Article R1 — Outbound-Only, Allowlisted, Approved
*(Rationale: the runner executes agent actions on a developer's laptop;
the security model is zero open ports + hard cwd allowlist + human
approval for destructive actions.)*
Never add a listening socket to the runner. Task directories are checked
by `is_cwd_allowed` before spawn — the runner's own `root_dir`, a channel
binding, or an explicitly added folder, and nothing else. No bypass flag,
no "temporary" exception, and no fallback that quietly widens the set (the
old "empty allowlist means $HOME" was exactly that). Destructive agent
actions keep the Approve/Deny round-trip through Slack.
