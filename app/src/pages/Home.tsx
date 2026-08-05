import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Brain, Slack, TerminalSquare, ShieldCheck, Database, Zap,
  ArrowRight, Check, CircleCheck, CircleSlash, Hash,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";

const agentFeatures = [
  {
    icon: TerminalSquare,
    title: "Coding agents in threads",
    text: "Mention the bot and the task lands on a real coding agent over ACP. Progress streams back into the thread while it works.",
  },
  {
    icon: Slack,
    title: "Approvals, not anxiety",
    text: "Destructive actions pause on Approve / Deny buttons right in Slack. The agent waits. You keep your afternoon.",
  },
  {
    icon: ShieldCheck,
    title: "Zero open ports",
    text: "The runner is a thin client on your machine with a single outbound connection. Runner tokens are stored as hashes; task directories are an allowlist.",
  },
];

const memoryFeatures = [
  {
    icon: Database,
    title: "Built on OpenViking",
    text: "An open context database with real research behind it (VLDB 2026): 80–83% recall versus 24–57% for native agent memory.",
  },
  {
    icon: Zap,
    title: "Up to 91% fewer tokens",
    text: "Hierarchical context loading: the agent reads exactly as much as the answer needs — and pays only for that.",
  },
  {
    icon: Brain,
    title: "One MCP endpoint",
    text: "Claude Code, Cursor, Codex, Gemini CLI connect with a single line in mcp.json. Read access to team memory, no code required.",
  },
];

const steps = [
  {
    n: "1",
    title: "Add to Slack",
    text: "OAuth install, pick your channels — ingestion starts immediately, history included.",
  },
  {
    n: "2",
    title: "Install a runner",
    text: "A thin client on your machine. Outbound connection only, token in the OS keychain.",
  },
  {
    n: "3",
    title: "Mention the bot",
    text: "The task goes to your agent, the answer streams back into the thread. Done.",
  },
];

const stats = [
  { value: "0", label: "Open ports on your machine" },
  { value: "1", label: "MCP endpoint for every agent" },
  { value: "91%", label: "Fewer tokens, hierarchical recall" },
  { value: "83%", label: "Memory recall accuracy (VLDB 2026)" },
];

const plans = [
  {
    name: "Free", price: "$0", tagline: "to kick the tires",
    items: ["1 channel", "30 days of history", "MCP access to memory", "1 runner"],
    cta: "Start free", featured: false,
  },
  {
    name: "Team", price: "$12", tagline: "per user / month",
    items: ["Unlimited channels", "Full history & team memory", "Runners for the whole team", "Priority support"],
    cta: "Choose Team", featured: true,
  },
  {
    name: "Enterprise", price: "Custom", tagline: "for organizations",
    items: ["Dedicated memory instance", "BYOK — your own LLM keys", "SSO, audit, retention", "On-prem / BYOC"],
    cta: "Talk to us", featured: false,
  },
];

function Glow({ className }: { className: string }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute rounded-full blur-3xl ${className}`}
    />
  );
}

function SlackMock() {
  return (
    <div className="relative mx-auto mt-16 max-w-2xl text-left">
      <Glow className="-inset-10 bg-violet-600/20" />
      <div className="relative rounded-2xl border border-white/10 bg-[#151029]/90 shadow-2xl shadow-violet-950/50 backdrop-blur">
        <div className="flex items-center gap-2 border-b border-white/10 px-5 py-3 text-sm text-violet-200/60">
          <Hash className="h-4 w-4" /> eng-platform
          <span className="ml-auto text-xs">thread · 2 replies</span>
        </div>
        <div className="space-y-5 px-5 py-5 font-mono text-[13px] leading-relaxed">
          <div>
            <div className="mb-1 flex items-baseline gap-2">
              <span className="font-semibold text-sky-300">ana</span>
              <span className="text-[11px] text-white/30">14:02</span>
            </div>
            <p className="text-white/80">
              <span className="rounded bg-violet-500/20 px-1 text-violet-300">@farol</span>{" "}
              why did checkout latency spike after the 13:40 deploy?
            </p>
          </div>
          <div className="border-l-2 border-violet-500/40 pl-4">
            <div className="mb-1 flex items-baseline gap-2">
              <span className="font-semibold text-violet-300">farol</span>
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-300">agent</span>
              <span className="text-[11px] text-white/30">14:02</span>
            </div>
            <p className="text-white/70">
              Traced it to #4182 — the new inventory check runs N+1 queries on
              Postgres. It matches what Priya flagged in #eng-alerts last week.
              Patch drafted on your runner.
            </p>
            <div className="mt-3 flex gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-emerald-300">
                <CircleCheck className="h-3.5 w-3.5" /> Approve
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-white/50">
                <CircleSlash className="h-3.5 w-3.5" /> Deny
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function FeatureCard({
  icon: Icon, title, text,
}: {
  icon: typeof Brain; title: string; text: string;
}) {
  return (
    <div className="group relative rounded-2xl border border-white/10 bg-white/[0.03] p-6 transition-colors hover:border-violet-400/40 hover:bg-violet-500/[0.06]">
      <Icon className="mb-4 h-6 w-6 text-violet-300" />
      <h3 className="mb-2 font-semibold text-white">{title}</h3>
      <p className="text-sm leading-relaxed text-violet-100/60">{text}</p>
    </div>
  );
}

export default function Home() {
  const { isAuthenticated } = useAuth();
  const ctaTo = isAuthenticated ? "/dashboard" : "/login";

  return (
    <div className="min-h-screen bg-[#0d0a1a] font-sans text-white antialiased selection:bg-violet-500/40">
      {/* Nav */}
      <header className="sticky top-0 z-20 border-b border-white/5 bg-[#0d0a1a]/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-2 font-semibold tracking-tight">
            <Brain className="h-5 w-5 text-violet-400" /> Farol
          </div>
          <nav className="flex items-center gap-6">
            <a href="#how" className="hidden text-sm text-violet-100/60 transition-colors hover:text-white sm:block">
              How it works
            </a>
            <a href="#pricing" className="hidden text-sm text-violet-100/60 transition-colors hover:text-white sm:block">
              Pricing
            </a>
            <Button
              asChild
              size="sm"
              className="bg-violet-500 text-white hover:bg-violet-400"
            >
              <Link to={ctaTo}>{isAuthenticated ? "Dashboard" : "Sign in"}</Link>
            </Button>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <Glow className="left-1/2 top-[-20rem] h-[42rem] w-[72rem] -translate-x-1/2 bg-violet-700/25" />
        <Glow className="right-[-10rem] top-40 h-96 w-96 bg-sky-500/10" />
        <div className="relative mx-auto max-w-6xl px-6 pb-24 pt-24 text-center">
          <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-violet-400/30 bg-violet-500/10 px-4 py-1.5 text-sm text-violet-200">
            <span className="h-1.5 w-1.5 rounded-full bg-violet-300" />
            Built on OpenViking · VLDB 2026
          </div>
          <h1 className="mx-auto max-w-3xl text-5xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
            Your AI agents
            <br />
            <span className="bg-gradient-to-r from-violet-300 via-fuchsia-300 to-sky-300 bg-clip-text text-transparent">
              in Slack.
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-violet-100/70">
            Memory for Slack. Bring your own agents. Mention the bot in any
            thread — a coding agent on your own machine picks up the task,
            remembers everything your team ever said, and streams the answer
            back.
          </p>
          <div className="mt-10 flex justify-center gap-4">
            <Button
              asChild
              size="lg"
              className="bg-violet-500 px-6 text-white shadow-lg shadow-violet-600/30 hover:bg-violet-400"
            >
              <Link to={ctaTo}>
                Add to Slack <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="border-white/15 bg-white/5 px-6 text-white hover:bg-white/10 hover:text-white"
            >
              <a href="#how">How it works</a>
            </Button>
          </div>
          <SlackMock />
        </div>
      </section>

      {/* Bring your own agents */}
      <section className="relative border-t border-white/5">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Bring your own agents
          </h2>
          <p className="mt-4 max-w-2xl text-lg text-violet-100/60">
            Claude, Codex, Gemini — whatever your flavour. The runner lives on
            your hardware, so your code and your credentials never leave it.
          </p>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {agentFeatures.map((f) => (
              <FeatureCard key={f.title} {...f} />
            ))}
          </div>
        </div>
      </section>

      {/* Memory for Slack */}
      <section className="relative overflow-hidden border-t border-white/5">
        <Glow className="left-[-12rem] top-20 h-96 w-96 bg-fuchsia-600/10" />
        <div className="relative mx-auto max-w-6xl px-6 py-24">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Threads fade.{" "}
            <span className="bg-gradient-to-r from-violet-300 to-sky-300 bg-clip-text text-transparent">
              Memory doesn't.
            </span>
          </h2>
          <p className="mt-4 max-w-2xl text-lg text-violet-100/60">
            Every message is distilled into a layered context graph — abstracts,
            overviews, details. Six months later the agent still knows why the
            decision was made, and who made it.
          </p>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {memoryFeatures.map((f) => (
              <FeatureCard key={f.title} {...f} />
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="border-t border-white/5 bg-white/[0.02]">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
            Three steps to a living memory
          </h2>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {steps.map((s) => (
              <div
                key={s.n}
                className="rounded-2xl border border-white/10 bg-[#120e22] p-6"
              >
                <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-violet-400 to-fuchsia-500 font-bold text-white shadow-lg shadow-violet-600/30">
                  {s.n}
                </div>
                <h3 className="mb-2 font-semibold text-white">{s.title}</h3>
                <p className="text-sm leading-relaxed text-violet-100/60">{s.text}</p>
              </div>
            ))}
          </div>

          {/* Stats */}
          <div className="mt-20 grid grid-cols-2 gap-8 border-t border-white/10 pt-12 md:grid-cols-4">
            {stats.map((s) => (
              <div key={s.label}>
                <div className="bg-gradient-to-r from-violet-300 to-sky-300 bg-clip-text text-4xl font-bold text-transparent">
                  {s.value}
                </div>
                <div className="mt-2 text-sm text-violet-100/50">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="relative overflow-hidden border-t border-white/5">
        <Glow className="bottom-[-14rem] left-1/2 h-[30rem] w-[50rem] -translate-x-1/2 bg-violet-700/15" />
        <div className="relative mx-auto max-w-6xl px-6 py-24">
          <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
            Pricing
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-center text-violet-100/60">
            Start free. Grow without drama — the memory you build on day one is
            the memory you keep.
          </p>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {plans.map((p) => (
              <div
                key={p.name}
                className={`relative rounded-2xl border p-6 ${
                  p.featured
                    ? "border-violet-400/50 bg-violet-500/[0.08] shadow-2xl shadow-violet-900/40"
                    : "border-white/10 bg-white/[0.03]"
                }`}
              >
                {p.featured && (
                  <span className="absolute -top-3 left-6 rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-500 px-3 py-0.5 text-xs font-semibold text-white">
                    Most popular
                  </span>
                )}
                <h3 className="font-semibold text-white">{p.name}</h3>
                <div className="mt-3 text-3xl font-bold text-white">{p.price}</div>
                <div className="mt-1 text-sm text-violet-100/50">{p.tagline}</div>
                <ul className="mb-8 mt-6 space-y-2.5">
                  {p.items.map((i) => (
                    <li key={i} className="flex gap-2 text-sm text-violet-100/70">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" /> {i}
                    </li>
                  ))}
                </ul>
                <Button
                  asChild
                  className={
                    p.featured
                      ? "w-full bg-violet-500 text-white hover:bg-violet-400"
                      : "w-full border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white"
                  }
                  variant={p.featured ? "default" : "outline"}
                >
                  <Link to={isAuthenticated ? "/dashboard/settings" : "/login"}>
                    {p.cta}
                  </Link>
                </Button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="relative overflow-hidden border-t border-white/5">
        <Glow className="left-1/2 top-[-10rem] h-[26rem] w-[46rem] -translate-x-1/2 bg-violet-600/20" />
        <div className="relative mx-auto max-w-6xl px-6 py-24 text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Give your team a memory.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-violet-100/60">
            Your agents are already smart. Now they can be there — in every
            thread, with every bit of context your team ever shared.
          </p>
          <Button
            asChild
            size="lg"
            className="mt-8 bg-violet-500 px-8 text-white shadow-lg shadow-violet-600/30 hover:bg-violet-400"
          >
            <Link to={ctaTo}>
              Add to Slack <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>

      <footer className="border-t border-white/5">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-8 text-sm text-violet-100/40 sm:flex-row sm:justify-between">
          <span>Farol — Slack Memory Layer for AI Agents</span>
          <span>OpenViking · ACP · MCP</span>
        </div>
      </footer>
    </div>
  );
}
