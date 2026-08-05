# Spike — who else is an agent in Slack

**Date:** 2026-08-05 · **Method:** 25 products surveyed. Prices marked **✓**
were read off the vendor's own page today; **~** comes from third-party
write-ups and is indicative only; **?** means not published or not checked.
Star counts and licences for open-source entries come from the GitHub API.

The question behind it: we describe ourselves as a coding agent driven from
Slack. Who else is on that shelf, what do they charge, and is the shelf worth
standing on?

## The field

| # | Product | What it is | Where work runs | Slack's role | Open source | Price |
|---|---|---|---|---|---|---|
| 1 | Claude Code in Slack / Claude Tag | coding agent | session on claude.ai/code, GitHub repos | @mention in channels (not DMs); View Session / Create PR / Change Repo buttons | — | in Pro/Max/Team/Ent ✓ |
| 2 | OpenAI Codex | coding agent | OpenAI cloud | Slack Marketplace app | — | with ChatGPT plan ? |
| 3 | Cursor | coding agent | Cloud Agents | `@cursor` with `repo=`/`branch=`, per-channel routing rules, PRs in thread | — | usage-based ✓ |
| 4 | GitHub Copilot | coding agent | GitHub Actions | issue → agent → draft PR | — | $0 / $10 / $39 / $100, credits $15/$70/$200 ✓ |
| 5 | Devin (Cognition) | coding agent | their cloud | Slack and Teams listed | — | Pro $20, Max $200, Teams $80 + $40/dev seat ✓ |
| 6 | Factory (Droids) | coding agent | cloud + local background agents | not mentioned on the pricing page ✓ | — | $20 / $100 / $200 ✓ |
| 7 | Multica | agent task board | local daemon **and** cloud runtimes | one channel among several; mention becomes an issue | Multica License (Apache + no hosted service) ✓ | self-host free ✓ |
| 8 | OpenHands | coding agent | cloud or your own machine | Slack on every tier ✓ | MIT, 83k★ ✓ | OSS free; LLM "at cost, no markup" ✓ |
| 9 | Viktor | AI employee | their AWS sandbox | Slack/Teams is the product | — | credits $50/20k … $5,000/2M ✓ |
| 10 | Dust | agents over company data | their cloud | agents in channels and DMs | — | ? (page does not render) |
| 11 | Glean | enterprise search + assistant | their cloud | assistant inside Slack ✓ | — | not published ✓ |
| 12 | Moveworks | IT/HR agent | their cloud | Slack is the main channel | — | ? |
| 13 | Zapier Agents | agents over 8,000 apps | their cloud | Slack as trigger and action | — | Free 400 activities/mo, Pro 1,500 ✓ |
| 14 | Lindy | AI assistants | their cloud | Slack among 100+ integrations | — | $49.99 / $99.99 / $199.99 ✓ |
| 15 | Slack AI / Slackbot | native assistant | Salesforce | Slack itself | — | Pro €8.25, Business+ €18/user ✓ |
| 16 | Agentforce | Salesforce agent platform | Salesforce | Slack as a surface | — | Flex Credits ? (page 403) |
| 17 | Momentum | **sales**: deal rooms | their cloud | **Slack-native** — a channel is a deal, two-way Salesforce | — | $69 / $99 per user + CI $30 ✓ |
| 18 | Rox | **sales**: an agent per account | their cloud | Slack among integrations | — | Free 2,000 actions, Core from $50, Ent custom ✓ |
| 19 | Qualified (Piper) | **sales**: AI SDR | their cloud | Slack alerts | — | $40–100k/year ~ |
| 20 | 11x (Alice) | **sales**: AI SDR | their cloud | Slack alerts | — | Growth $3,750/mo ~ |
| 21 | Artisan (Ava) | **sales**: AI SDR | their cloud | Slack alerts | — | from ~$999/mo ~ |
| 22 | Onyx (ex-Danswer) | RAG assistant | self-host or cloud | Slack bot from Business up | custom licence, 31k★ ✓ | $20/user ✓ |
| 23 | Dify | LLM app builder | self-host or cloud | bot assembled by hand | custom licence, 151k★ ✓ | Pro $590/yr, Team $1,590/yr ✓ |
| 24 | n8n | automation + AI agents | self-host or cloud | Slack triggers and nodes | fair-code, 199k★ ✓ | €20 / €50 / €667 ✓ |
| 25 | Khoj | personal AI assistant | self-host | Slack among its channels | AGPL-3.0, 36k★ ✓ | OSS free |

Deliberately left out as builders rather than products — Slack has to be wired
by hand: Botpress (MIT, 14.8k★), LibreChat (MIT, 41.7k★), Flowise (55k★),
Activepieces (23.6k★).

One entry died during the survey: **Codegen** was acquired by ClickUp in
December 2025 and the standalone product was switched off on 2026-01-16.

## What the table says

**The coding-agent-in-Slack niche is occupied by the model vendors
themselves.** Anthropic, OpenAI, Cursor and GitHub are all in the Slack
Marketplace, and Slack advertises them in its own developer blog. All four
execute in *their* cloud against a connected GitHub repo — nobody but us and
Multica touches a real machine. Claude Tag additionally covers the corporate
case: @Claude as the organisation's shared identity with admin-configured
access, replacing the per-user version on Team and Enterprise plans.

**Open source in this niche is free and genuinely good.** OpenHands is MIT with
83k stars, ships a Slack integration on every tier, and resells models at cost.
Multica reached 44k stars in seven months. Whatever we charge for has to be
something neither of them gives away.

**Sales pays an order of magnitude more.** $69–99 per user per month at
Momentum against $20 per seat at Onyx; AI SDR deals run into tens of thousands
a year. And the Slack-native seat in that segment is taken: Momentum sells
exactly "a Slack channel is a deal room" with execution, retention and coaching
agents on top of two-way Salesforce sync.

## So what — the fork

Standing on the coding shelf means competing with the people who make the
models and with a free MIT project at the same time. Moving off it is
defensible. But the move has a price tag that should be named before it is
made, not after.

**A sales agent does not need a runner.** Our moat — execution on the
developer's machine, with their access and no source leaving it — is worth
nothing in sales, where the agent needs CRM, enrichment and to be awake at
03:00 rather than a laptop that closed at 19:00. In that direction `runner/`
(ACP, the directory allowlist, keychain, Tauri, signed releases) stops being an
asset and becomes maintenance. Most of [runner gaps](2026-08-05-runner-gaps.md)
becomes moot with it.

**What transfers intact:** the Slack plumbing (install, OAuth, threads,
streaming, buttons) and — the valuable part — channel memory in OpenViking with
gateway-enforced scope. That is worth *more* in sales than in code: Slack
Connect channels with customers hold conversation no CRM has, and Momentum
charges $69/user/month for essentially that.

**What is missing for sales:** two-way CRM. Momentum advertises coverage of 98%
of Salesforce field types. Without writing back, we are a smart channel
summariser — a feature, not a product.

So the decision to make is not "code or sales" but **where the work executes**:

- *If sales* — take the runner off the critical path (keep it optional for
  teams with local data), and bet on customer-channel memory plus CRM writes.
- *If the runner stays the moat* — the better pivot is not sales but the teams
  whose work still needs a machine and its credentials: DevOps/SRE, data
  engineering, internal tools behind a perimeter. Cloud agents from Anthropic
  and Cursor cannot reach in there, and Multica has to be operated yourself.

## Sources

Vendor pages read on 2026-08-05: [Slack — coding
agents](https://slack.com/blog/developers/coding-agents-in-slack),
[Claude Code in Slack](https://code.claude.com/docs/en/slack),
[Cursor](https://cursor.com/docs/integrations/slack),
[Copilot](https://github.com/features/copilot/plans),
[Devin](https://devin.ai/pricing), [Factory](https://www.factory.ai/pricing),
[OpenHands](https://www.openhands.dev/pricing),
[Onyx](https://www.onyx.app/pricing), [Dify](https://dify.ai/pricing),
[n8n](https://n8n.io/pricing/), [Zapier](https://zapier.com/pricing),
[Lindy](https://www.lindy.ai/pricing), [Slack](https://slack.com/pricing),
[Momentum](https://www.momentum.io/pricing), [Rox](https://rox.com/pricing),
[ClickUp × Codegen](https://clickup.com/blog/clickup-codegen-acquisition/).
Third-party (marked ~): [AI SDR pricing
index](https://altitudebiz.dev/notes/ai-sdr-pricing-index),
[Qualified pricing](https://www.knock-ai.com/blog/qualified-pricing).
