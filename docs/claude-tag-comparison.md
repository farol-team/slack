# Claude Tag vs Farol

*Researched 2026-08-06. Sources at the bottom; Claude Tag is in beta, details may change.*

## What Claude Tag is

[Claude Tag](https://claude.com/product/tag) is Anthropic's "AI teammate" inside Slack, launched
in beta on 2026-06-23 for Claude **Enterprise and Team** plans. Mentioning `@Claude` in a thread
hands it a task; it reads the thread context, plans, executes asynchronously, and reports back in
the thread. The legacy "Claude in Slack" app is auto-migrated to Tag on 2026-08-03.

Key properties:

- **Shared identity per channel** — one Claude instance per channel, usable by every member;
  tasks can be handed off between people mid-flight ("multiplayer").
- **Persistent channel-level memory** — context accumulates against the channel, not a private
  session; identities are isolated per channel ("a legal Claude can't read engineering memories").
- **Hosted execution only** — sessions run in Anthropic-hosted ephemeral sandboxes, discarded when
  idle. No on-prem or local option.
- **Access Bundles** — only a Slack Primary Owner/Owner can provision the identity; admins
  explicitly grant each channel's Claude access to tools, repos, and data sources. Nothing is
  connected by default.
- **Ambient mode** (opt-in per channel) — proactive behavior: follows up on stalled threads,
  flags relevant updates, posts digests; supports standing instructions and scheduled tasks.
- **Governance** — org/channel token-spend caps (over-cap work is declined, not silently
  truncated) and a full audit log tying every action to the requesting user. No explicit
  human-in-the-loop approval flow is described; ambient mode acts autonomously.
- Channel work bills to the organization; DM work bills against the individual's seat limits.

## Side-by-side

The entry point is identical to ours — a bot mention in a Slack thread becomes an agent task and
the answer streams back into the thread. The architectures diverge almost mirror-like from there:

| Dimension | Claude Tag | Farol |
|---|---|---|
| Where code executes | Ephemeral sandbox in Anthropic's cloud | Developer's local machine (runner, outbound-only wss) |
| Code access | Admin-configured connectors/repos (Access Bundles) | The actual working copy on disk (`~/Farol/<workspace>/<channel>` + bindings) |
| Agent | Claude only | BYOA over ACP: claude-agent-acp, opencode, any ACP adapter |
| Routing | Shared instance per channel; anyone can continue a task | Mention runs only on the author's own runner (BYOA routing) |
| Memory | Built-in, channel-level, inside Anthropic | OpenViking: workspace = account, agent access only via gateway with a signed task token scoped to the mention's channel |
| Approvals | No HITL described; ambient mode acts autonomously | Explicit Approve/Deny/Stop buttons in Slack for destructive actions |
| Proactivity | Ambient mode, standing instructions, scheduled tasks | None — reactive to mentions and thread follow-ups only |
| Data locality | Code and context go to Anthropic's cloud | Code never leaves the developer's machine; only events/thread text in cloud |
| Availability | Enterprise/Team beta only | Own SaaS, no Anthropic plan dependency |
| Billing/governance | Org/channel spend caps, full audit log | No quotas or audit log yet |

## Implications

**Our defensible niche is local execution.** Tag is explicitly hosted-only — a hard constraint for
regulated industries and anyone unwilling to ship code into a third-party sandbox. Farol's
zero-open-ports runner with code staying on the developer's machine is the exact opposite
trade-off. Add BYOA (Tag = one agent, one vendor) and explicit HITL approvals (absent in Tag, and
already flagged externally as an open governance question for ambient mode).

**Where Tag is clearly ahead — worth tracking as roadmap candidates:**

1. **Shared instance per channel.** Our mention is hard-bound to the author's runner; a task
   cannot be handed to a colleague mid-flight. This is Tag's strongest product differentiator
   ("multiplayer"), and it is architecturally reachable for us — Chat already lives at the thread
   level, not the user level.
2. **Proactivity.** Ambient mode, standing instructions, scheduled tasks — we have none of this;
   we are purely reactive.
3. **Governance.** Spend caps and an audit log ("who asked → what the agent did") are table
   stakes for selling to teams; we don't have that layer yet.
4. **Memory as lock-in.** Months of accumulated channel context make Tag hard to leave. OpenViking
   is conceptually the same, but with an honest isolation model (gateway + scoped tokens) — worth
   highlighting in positioning.

Distribution risk: Tag ships "included" for Anthropic Enterprise/Team subscribers — zero adoption
friction for teams already on Claude. Our pitch must center on what Tag cannot offer: code stays
local, bring your own agent, explicit approval of destructive actions.

## Execution architecture

Anthropic documents Tag's execution model in the official docs and two engineering posts.

**Sandbox per Slack thread.** Each thread gets its own ephemeral sandbox on Anthropic's
infrastructure ("nothing installed in your network"). Two threads in one channel are two isolated
sessions with no shared state. Lifecycle: mention → sandbox builds → working loop (live checklist
edited in place) → result posts to the thread → on idle the sandbox is **discarded while the
thread persists**; a new reply rebuilds it. Files that existed only in the sandbox are lost —
docs advise asking Claude to push branches/drafts as it goes. Inside runs "the same engine that
powers Claude Code on the web": repos are cloned into the sandbox, changes pushed back as a
branch/PR authored by the Claude GitHub App.

**Brain decoupled from hands** ([Managed Agents](https://www.anthropic.com/engineering/managed-agents)):
the agent loop (Claude + harness) is a stateless process *outside* the container, reading events
from a durable session log and calling containers as tools (`execute(name, input) → string`).
Containers are cattle — if one dies the harness provisions a fresh one. This is what makes the
"quiet period" cheap: session state doesn't live in the sandbox. Reported effect: p50
time-to-first-token −60%.

**Credentials never enter the sandbox**
([agent identity](https://claude.com/docs/claude-tag/concepts/agent-identity.md)): all sandbox
egress crosses **Agent Proxy**, a network boundary that checks the destination against three
allow layers (connection's allowed websites → bundle's Domains list → environment's network
level) and injects the credential from the credential store *at the boundary*. The model and the
sandbox never see keys; once saved, a credential is never displayed again. Anything not allowed
is blocked, including `curl`/`fetch` from code Claude runs. Limitation: the proxy carries
**HTTP/HTTPS only** — no SSH, no native database wire protocols.

**Isolation technology**: not named for Tag specifically, but
[How we contain Claude](https://www.anthropic.com/engineering/how-we-contain-claude) describes the
family: claude.ai code execution runs in **gVisor** containers on isolated infrastructure; Claude
Code locally uses Seatbelt (macOS) / bubblewrap (Linux); Cowork uses a full VM. Tag, sharing the
Claude Code on the web engine, is almost certainly in the gVisor branch.

**Takeaways for Farol:**

1. Their Agent Proxy is our `gateway.py` pattern taken to the whole network: we proxy only memory
   (OV MCP + scoped tokens), they proxy all egress with credential injection at the boundary.
   Validates our "the agent never sees keys" choice.
2. gVisor is the same runtime we measured in `spikes/2026-08-06-secure-sandbox.md` (+60–80%
   overhead): Anthropic runs it in production at scale — an argument in favor in our isolation
   cost debate.
3. Our differentiator holds, with a caveat: HTTP-only proxy and no SSH/DB wire protocols are real
   Tag limitations vs our local runner with full machine access. But the Managed Agents post
   explicitly mentions VPC integration — "customers can provision their own hands." If that
   reaches Tag, "code never leaves your perimeter" stops being ours alone.

## Pricing

**Cost at a glance:**

1. **Subscription (entry ticket):** Team at $20–25/seat/month or Enterprise (custom pricing).
   Without one of these plans Tag is unavailable entirely.
2. **Usage on top:** channel work is metered against a prepaid organization balance; no published
   per-token or per-task rate — admins set a monthly spend cap and watch per-channel breakdown.
   DMs with Claude cost the org nothing (they draw from the sender's personal seat limits).
3. **During beta (until 2026-09-01):** channel usage is effectively free thanks to launch
   credits — $2,500 per Team org (min 10 paid seats), $25,000 per Enterprise org.

For a ~10-person team on Team plan: roughly $200–250/month for seats, Tag consumption currently
covered by credits, and an unknown usage bill after they expire (post-beta pricing unannounced).

Details, per official Anthropic docs ([overview](https://claude.com/docs/claude-tag/overview.md),
[spend limits](https://claude.com/docs/claude-tag/admins/set-spend-limit.md),
[launch promo](https://support.claude.com/en/articles/15575654-claude-tag-launch-promo-for-claude-team-and-enterprise)):

- **Included in Team and Enterprise plans** — no separate per-seat charge for Tag itself
  (Team is $20–25/seat/month, Enterprise is custom). Not available on Free/Pro/Max and there is
  no standalone subscription: a Team/Enterprise plan is the entry ticket.
- **Usage-based on top of the subscription**: channel/thread work draws tokens from a funded
  **organization usage balance**, with a monthly-resetting org spend limit (required on Team —
  Claude won't respond until a balance is funded and a limit set; recommended on Enterprise,
  otherwise usage bills to invoice uncapped). Optional per-channel limits. No published per-token
  or per-task rate — Anthropic suggests setting a cap and watching the per-channel breakdown.
- **Channel vs DM split**: channel work bills to the org balance and can't be attributed to
  individuals; **DMs with Claude bill against the sender's own seat limits** and bypass the org
  cap entirely.
- **Cap enforcement**: on hitting the spend limit Claude stops mid-task and tells the requester;
  no overage charges, no automatic retries. Separate throughput rate limits apply independently.
- **Beta launch credits** (expire 2026-09-01): $25,000 per Enterprise org, $2,500 per Team org
  (min 10 paid seats), covering shared-channel usage only.
- **Post-beta pricing: unannounced.** Docs explicitly warn features/behavior may change before GA.

So the answer to "is it in the Claude subscription?" is: the *capability* is bundled with
Team/Enterprise, but the *consumption* is metered separately from an org-funded usage balance —
effectively a subscription gate plus usage-based billing, softened during beta by launch credits.

## Sources

- https://claude.com/product/tag (official product page)
- https://claude.com/docs/claude-tag/concepts/how-it-works.md (session/sandbox lifecycle)
- https://claude.com/docs/claude-tag/concepts/agent-identity.md (Agent Proxy, credential store)
- https://www.anthropic.com/engineering/managed-agents (brain/hands decoupling)
- https://www.anthropic.com/engineering/how-we-contain-claude (isolation tech per product)
- https://www.digitalapplied.com/blog/anthropic-claude-tag-slack-team-collaboration-2026
- https://ofox.ai/blog/claude-tag-slack-setup-guide-2026/
- https://fortune.com/2026/06/23/anthropic-claude-tag-virtual-employee-tool-slack/
