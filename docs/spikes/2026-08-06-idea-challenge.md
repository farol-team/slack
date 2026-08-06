# Spike — challenging "Slack + agent + memory"

**Date:** 2026-08-06 · **Method:** adversarial reading of our own thesis. Unlike
the other spikes this one is mostly *argument*, not observation — so every load-
bearing fact is marked: **[v]** verified today or in the market spike, **[o]**
observed in our own running system, **[a]** argument with no evidence yet.

The claim under test: *a bot in Slack, backed by an agent, made useful by the
team's channel memory, is a business.* Below are the ways that claim dies. It
is written to be uncomfortable; the counter-arguments belong in the replies to
it, not in it.

## 1. Every layer is owned by someone whose main business it is

Slack is Salesforce's, and Slack AI already ships channel search, summaries and
recaps inside the €18/user Business+ plan **[v]**. The agent belongs to
Anthropic or OpenAI, and Claude Tag already gives an organisation-wide @Claude
with admin-configured access **[v]**. Memory over company data is Glean's, and
Onyx sells the same shape at $20/seat with an open-source core **[v]**.

We are the integration of three things, each being absorbed by its owner.
Codegen took two years to build a Slack-connected coding agent and dissolved
into ClickUp in December 2025 **[v]**. Integrations get eaten.

## 2. Channel memory may be mostly noise

The uncomfortable data point is our own. What actually accumulated in
OpenViking for our test channels was:

```
hello · hello 2 · hello 3 · hello 5 … hello 10 · who are you?
```

**[o]** It is a test workspace, so the example proves nothing on its own — but
it points at the real risk. A team's durable knowledge tends to live in Notion,
Linear and PR descriptions; Slack carries coordination — "look at this", "ok",
"let's sync". The premise that conversation holds knowledge worth paying for is
**[a]**, and it has to be tested on someone else's real channel, not ours.

## 3. The moment of value may be rare

Memory pays off only when three things coincide: a question is asked, its
answer exists *only* in the channel history, and the answer changes an action.
How many times a week does that happen per team? **[a]** If the answer is
twice, nobody renews. Worse, whoever was in the channel answers faster than the
bot, and the newcomer who would benefit does not know what to ask.

## 4. Memory with no model of time will be confidently wrong

Channel history contains decisions that were later reversed. Our ingestion
batches messages into per-day files and searches them semantically; there is no
notion of recency weighting, authority, or "superseded by" **[o]**. So the
system will quote a reversed decision as current, in a thread visible to the
whole channel. One such answer costs more than ten good ones earn.

## 5. A bot reply is noise added to the place people already complain about

We add messages to Slack. Our competitor is not another bot — it is the
attention of the humans in the thread **[a]**. Everything the agent says that
turns out not to be needed argues against the product.

## 6. "A bot reads our channel" is a political problem, not a technical one

The audience rule — the agent must not read what the channel's members cannot —
answers the technical half. The objection is the other half: *a vendor's bot
sits in our customer channel and remembers things*. That conversation is with a
lawyer and a security officer, and it is longer than the sales cycle we are
assuming **[a]**.

## 7. BYOA cuts both ways

Running on the customer's own agent subscription means near-zero marginal cost
— and near-zero lock-in. The same vendor whose subscription we ride can fold an
equivalent capability into it for free. Claude Tag is that move, already made
**[v]**.

## 8. Platform risk

We are building inside someone else's chat product whose owner sells a
competing agent platform (Agentforce) and controls scopes, rate limits and
marketplace rules **[v for the competing product, a for the risk]**.

## What would have to be true

Falsifiable, in the order they would kill the idea:

1. There is a **recurring** question type whose answer exists only in the
   conversation.
2. That answer leads to an **action**, not to satisfied curiosity.
3. A human is willing to **press the button** that commits the action.
4. The team comes back to that thread **unprompted** the following week.

Fail 1–2 and the product is a summariser, which Slack AI undercuts by being
already paid for. Fail 3 and we are competing with Zapier on automation.

## The cheapest way to find out

Do not build connectors. Take one real, busy channel that is not ours —
ideally a customer channel with history — import it with the importer we
already have, and watch two numbers for a week:

- share of mentions whose answer **required** history;
- share of answers after which **something changed** outside Slack.

Everything else can wait until those two numbers are non-zero.

## So what — which third survives

- **The agent** is a commodity; no defensibility there.
- **Memory** is a strong feature and a weak product: squeezed by Slack AI from
  above and Glean/Onyx from below.
- **Slack** is the only durable piece — not as an interface, but as the place
  where an action gets approved.

The most defensible restatement of the thesis is therefore not "Slack + agent +
memory" but: **a Slack thread is where an agent's action gets a human's
approval and leaves a trail**. Memory is fuel, the agent is labour, and the
product is accountability — who allowed it, on what basis, what changed.

That is also the only part nobody in the market is taking: model vendors do not
care about a customer's access policy, Slack does not reach into their systems,
and the open-source stacks run agents with permissions bypassed
(`--yolo`) **[v, see the Multica spike]**.
