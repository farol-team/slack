# Spike — what the runner is missing

**Date:** 2026-08-05 · **Method:** a day of live debugging against production
(cloud VM, two connected runners, real Slack turns) plus the two competitor
spikes. Every failure below was observed, not imagined; the evidence is quoted.

The two spikes ([Viktor](2026-08-05-viktor.md),
[Multica](2026-08-05-multica.md)) point at the same soft spot from opposite
directions: a hosted employee is always awake, and an open-source fleet claims
work from a queue. We route to one person's laptop and hope it is open. What
follows is that gap broken into pieces, ordered by what a user feels first.

## 1. Routing binds work to a machine, not to a team

`ChatRouter.pick_runner` (`cloud/app/chat_router.py`) returns the **first**
runner in the dict whose workspace and `user_key` match. Two consequences,
both seen today:

- With two runners of the same owner connected, the one that registered
  earlier wins every mention. A Linux headless runner registered at 22:07:51
  kept taking turns that were meant for the MacBook, and there was no way to
  choose or even to see which machine had answered.
- With none connected, the mention has nowhere to go — the author's laptop is
  the single point of failure for their own requests.

Multica's answer is a claim queue: any daemon watching the workspace can take
the task. Ours could stay BYOA by default (it is a real security property) and
add an explicit fallback runner for the team — a headless process on a server,
which we already ship as `examples/headless`.

## 2. Revoking a runner does not disconnect it

`ChatRouter.register` validates the token once, at `hello`, and then keeps the
`Runner` in `self.runners` forever. Nothing re-checks `revokedAt`.

Observed: runner #12 was revoked in the SaaS at 22:16:58 and went on serving
turns at 22:17:07 and 22:17:20, stopping only when the process was killed.
This is not merely confusing — it means revoking a leaked runner token does
not stop the machine already holding a connection.

Fix shape: have the SaaS notify the cloud on revoke, or re-validate on a
schedule (the runner already pings every 25s and `touch_runner` throttles a
SaaS call to once per 5 min — the same path can carry a "still valid" answer
and close the socket when it is no longer true).

## 3. One working directory per channel

`RunnerConfig::workspace_for` derives `~/Farol/<workspace>/<channel>`, so every
turn in a channel runs in the same tree. Today two threads in one channel
cannot collide only because a chat refuses a second concurrent turn ("A turn is
already running in this thread"), but that guard is per thread, not per
directory: two threads in the same channel would share one working copy.

Multica gives each task a `git worktree` off a shared bare clone and garbage-
collects with TTLs, distinguishing regenerable output (`node_modules`, `.next`)
from state the agent needs to resume. That is the right shape for parallel work
and for disk hygiene, and it is independent of everything else here.

## 4. Nothing happens unless a human types

Turns are born only from Slack events (`slack_app.py`). Both competitors
schedule: Viktor sells "works while you sleep", Multica has Autopilots with
cron, webhook and manual triggers.

We hold a persistent WS to every runner already, so a scheduled turn is mostly
plumbing: a trigger table, a tick, and an `assign_turn` with a synthetic
prompt into a chosen channel. The product difference is larger than the work.

## 5. Upgrading a runner is a manual ritual

Today's sequence — rebuild, download a `.dmg`, install, restart, then guess
whether the new binary is the one answering — is the whole problem. Multica
ships `auto_update.go` and `multica update`.

Half of the diagnosis is already fixed: since `a471c64` the WS handshake
carries `x-farol-runner-version` / `x-farol-runner-os` and the cloud logs them
before authentication, so "which build dialed in" is now answerable even for a
runner that fails to authenticate. The remaining half is the update itself.

## 6. Adapters are pinned, and only three

`agents.rs` pins Claude, Codex and OpenCode; Multica detects fifteen CLIs and
probes and self-heals their paths (`server/internal/daemon/agents_probe.go`
and its self-heal tests). Most of them speak ACP, which we already speak — so
this is breadth, not architecture.
Low priority on its own, but it is the cheapest "we support what you already
use" answer we have.

## Order of work, if it were up to this spike

1. **Fallback runner + visible routing** (#1) — removes the closed-laptop
   failure and the silent race. Biggest felt difference per unit of work.
2. **Revocation actually disconnects** (#2) — small, and it is a security
   claim we currently cannot make honestly.
3. **Scheduled turns** (#4) — the feature both competitors lead with.
4. **Worktree per task** (#3) — needed before anyone runs two threads of work
   in one channel.
5. **Runner auto-update** (#5), then **more adapters** (#6).
