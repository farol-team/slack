# Spikes — the overview

Ten spikes were written on 2026-08-05 and 2026-08-06. This document is the map
through them: what each looked at, what the sum of them says, and where they
disagree. The individual spikes hold the evidence and the dates; this one holds
the argument. When they conflict with the code, the code is right and the spike
is a photograph of an earlier day — every spike says so itself.

The evidence discipline of the set is worth keeping while reading: observed
facts are separated from inferences, competitor claims say how they were learned
(page read, repo cloned, file named), and numbers carry a source. Two spikes
(`idea-challenge`, `open-tag`) are mostly argument and mark every load-bearing
fact `[v]`/`[o]`/`[a]`; the sandbox pair carries our own measurements next to
labelled vendor claims. Treat the market prices as photographs — competitors
ship.

## The ten, in four clusters

**Where we stand in the market**
- [Slack agent market](2026-08-05-slack-agent-market.md) — 25 products on the
  "agent in Slack" shelf, with prices and where each runs the work.
- [Viktor](2026-08-05-viktor.md) — a hosted "AI employee", the SaaS-sandbox
  opposite of our model.
- [Multica](2026-08-05-multica.md) — an open-source agent task board, 44k★, the
  closest architectural overlap, read from source.
- [qm](2026-08-05-qm.md) — a 76k-line multiplayer Slack agent harness; the
  richest single codebase to steal from.

**Whether the thesis holds**
- [Idea challenge](2026-08-06-idea-challenge.md) — an adversarial reading of
  "Slack + agent + memory" that tries to kill it.
- [Open Tag](2026-08-06-open-tag.md) — positioning Farol as the open, BYOA
  answer to Anthropic's Claude Tag.

**What our own product is missing**
- [Runner gaps](2026-08-05-runner-gaps.md) — failures observed in a day of live
  debugging, ordered by what a user feels first.
- [Roles](2026-08-06-roles.md) — how a "virtual employee" is actually stored and
  run in shipped products, and why qm has no role object.

**Where hosted agents would run**
- [Agent sandboxes](2026-08-06-agent-sandboxes.md) — our own cold-start and
  warm-start measurements; the landscape as labelled claims.
- [Secure sandbox](2026-08-06-secure-sandbox.md) — gVisor benchmarked here
  against runc, cross-checked against the container-escape record; and the
  agent's own OS sandbox as a second, orthogonal boundary.

## What the set says, taken together

### 1. One structural advantage, and it is the whole strategy

Across the market, everyone runs the work in **their** cloud — Viktor on AWS,
Devin and Cursor and Codex on their own infrastructure, Claude Tag in an
ephemeral sandbox on Anthropic's. Two open-source stacks (OpenHands, Multica)
run their **own** agent or runtime. **Nobody else is BYOA** — nobody runs *your*
agent on *your* machine with *your* checkout, credentials and VPN, sending only
text to the cloud (`viktor`, `slack-agent-market`, `open-tag`).

That is the one claim a hosted competitor cannot copy by shipping a feature: a
hosted employee has no machine inside your private network, so it cannot enter a
repo behind a VPN; we can, and the source never leaves the laptop (`viktor`).
Claude Tag makes the point for us — it is Team/Enterprise-only, hosted-only,
Claude-only, and its egress proxy is HTTP/HTTPS only, so SSH and native database
wire protocols cannot cross it (`open-tag`, from Anthropic's own docs). "Claude
Tag, but open — any agent, your infrastructure" is a positioning the market has
left vacant, and Anthropic is teaching the category at its own expense.

### 2. …undercut by the honest counter-argument

The idea-challenge spike is the necessary discomfort: we are the integration of
three layers each being absorbed by its owner — Slack AI ships channel
search/recaps in Business+, Claude Tag ships an org-wide @Claude, Glean and Onyx
sell memory over company data. Integrations get eaten; Codegen took two years to
build a Slack coding agent and dissolved into ClickUp in Dec 2025 (`idea-challenge`,
`[v]`).

Its conclusion is the most useful sentence in the set, and it reframes the
product: not "Slack + agent + memory" but **"a Slack thread is where an agent's
action gets a human's approval and leaves a trail."** The agent is commodity
labour, memory is fuel, and the defensible product is *accountability* — who
allowed it, on what basis, what changed. That is the one part nobody is taking:
model vendors don't care about a customer's access policy, Slack doesn't reach
into their systems, and the open-source stacks run agents with permissions
bypassed (`--yolo`). This should be read against the market spike's warning that
"memory" is squeezed from above by Slack AI and below by Glean/Onyx.

### 3. Our own product does not yet earn the advantage

The runner-gaps spike is the reality check, all of it observed in production:
routing binds work to the *first* matching machine, not the team (a laptop is a
single point of failure, and two of one owner's runners race silently);
**revoking a runner token does not disconnect the machine already holding a
connection** — a security claim we currently cannot make honestly; and there are
no scheduled turns, the feature both Viktor and Multica lead with. Its ordering
stands: fallback runner + visible routing first, revocation-actually-disconnects
second, scheduled turns third. (Some of these moved after the spike was written
— check the code before acting.)

### 4. "Roles" are cheaper than they look, if we resist the obvious build

The roles spike, read from qm's source, delivers the counter-intuitive result:
**qm has no role object — the role is the scope.** One bot; what changes between
a channel and a DM is the resolved configuration (its SOUL instruction, policy,
model, memory, skills). Nobody routes by name; the model selects skills from an
index of descriptions. The expensive path — named colleagues, `@analyst`
autocompleting — costs a second Slack app, install and token set per role, which
is the wall qm hit and stopped at.

For us the cheap path is nearly free: we already route per channel, derive a
folder per channel and scope memory per channel, and the adapter reads
`CLAUDE.md`/`SKILL.md`/`.claude/agents` from the workspace — so materialising
role files before the session starts makes roles work with no protocol change.
The one hard rule the spike extracts: **roles must not own sessions** — the
thread owns the ACP session, a role is prompt+policy applied to a turn — because
under BYOA ten session-holding roles are ten agent processes on one laptop.

### 5. If agents ever move off laptops, the substrate question is answered

The two sandbox spikes exist because §3's fallback runner and any hosted tier
raise it. The measured conclusion is firm: **cold vs warm dominates everything.**
A fresh VM answers in ~2.5 min (86 s create + 64 s image pull); the same host
warm answers in ~1 s — invisible next to model thinking (`agent-sandboxes`).
Design a warm pool, not per-turn provisioning; the isolation technology is
secondary to that.

For *client* agents (multi-tenant, untrusted), the secure-sandbox spike settles
the technology with our own numbers plus the escape record: **gVisor is the
answer today.** It is the only substrate giving a real kernel boundary without
`/dev/kvm` (which our cloud lacks, ruling out Firecracker/Kata); it has no modern
host-escape CVE where runc takes a host breakout roughly yearly *plus* the whole
kernel-LPE surface; and it is proven for exactly this (Cloud Run gen1, GKE
Sandbox, Modal). We measured its cost here: **+60–80 % on file/syscall work**,
but landing on amortised setup (`npm install` 22 s → 35 s once per workspace),
not per turn. The rule that matters more than the tier: **single-use, ephemeral,
egress-default-deny** — what made GitHub's untrusted-PR runners safe.

And the boundary the set names last is orthogonal to all of that: the agent's
**own** OS sandbox (Codex `--sandbox`, Claude Code's `sandbox` block, Anthropic's
bubblewrap/Seatbelt runtime). It turns "everything allowed inside a turn" from
*our* assertion (`auto_allowed` + Slack buttons) into a claim the harness
enforces in the kernel. It is the *primary* boundary in BYOA — where no container
exists — and a reinforcing layer inside gVisor when hosted. Same kernel, so no
defence against kernel exploits; that is why it composes with, rather than
replaces, the container tier.

## The one-line synthesis

The market has left BYOA-over-open-agents vacant and Anthropic is teaching the
category (`open-tag`); the defensible core inside it is **accountability, not
memory** (`idea-challenge`); our runner must first stop losing work to a closed
laptop and honour revocation (`runner-gaps`); roles are a per-scope prompt+policy
construct, not named bots (`roles`); and when agents move to our machines,
**gVisor per client, ephemeral, behind an egress proxy, warm-pooled** is the
defensible substrate, with the agent's own OS sandbox as the inner and — for
BYOA — the primary boundary (`secure-sandbox`, `agent-sandboxes`).

## Open questions the set leaves

- Does channel memory carry knowledge worth paying for, on a *real* team's
  channel rather than our test one (`idea-challenge`, `[a]`)?
- Can `claude-agent-acp` enable its OS sandbox mode and accept our policy through
  ACP (`secure-sandbox`, not yet checked)?
- What is the *per-turn* (not setup) gVisor cost on a real multi-file agent task,
  vs the probe proxies we measured (`secure-sandbox`)?
- Does the runner need a one-shot turn mode to fit request-driven hosting
  (`agent-sandboxes`)?
