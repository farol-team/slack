# Spike: a safe container for client agents — measured, and cross-checked against incidents

**Date:** 2026-08-06. **Question:** we want to run coding agents on our own
machines for clients — multi-tenant, untrusted code by definition. What
isolation is defensible, and what does it cost?

**How to read this.** §1 is ours: gVisor installed on this machine and
benchmarked against runc on agent-shaped workloads. §2 is a delegated evidence
review that this round was told to ground in **incident records and independent
papers**, not vendor marketing; every claim there carries a source and a kind
tag. The two agree, which is the point of doing both.

## 1. gVisor vs runc, measured here

Installed `runsc release-20260727.0`, registered it as a Docker runtime, and ran
the same probe image (`node:20-slim` + git + the ACP adapter) under both, three
runs each, medians below. Every number includes container start, so the fixed
cost is double-counted in the short tests — the honest figure is `npm install`,
which is dominated by real work.

| Workload | runc | runsc (systrap) | gVisor overhead |
|---|---|---|---|
| container start → ACP `initialize` | 1098 ms | 1861 ms | **+69 %** |
| node fib(32) (start-dominated) | 571 ms | 835 ms | +46 % |
| `git clone` + `git status` (small repo) | 571 ms | 912 ms | +60 % |
| recursive grep + find over a tree | 534 ms | 967 ms | **+81 %** |
| `npm install` (5 deps, ~real work) | 22.0 s | 35.0 s | **+59 %** |

**Read:** gVisor is real and it is not free. The file- and syscall-heavy work an
agent actually does — installing packages, walking trees — runs **~60–80 %
slower**. But look at what that means in context: a `npm install` goes from 22 s
to 35 s once, when a channel's workspace is first prepared. The per-turn hit,
after the workspace exists, is the syscalls of a single agent session, and the
agent then spends far longer thinking than the sandbox adds. **The overhead lands
on setup, which is amortised, not on every turn.** That reframes +60 % from
alarming to acceptable — for our workload specifically.

Nothing broke: every workload ran unmodified under `runsc`, `uname` inside
reports `4.19.0-gvisor` (its own kernel, not the host's `6.8.0`), which is the
whole point.

## 2. The evidence that decides it — incidents, not benchmarks

The strongest argument for gVisor is not speed, it is the escape record.

**runc shares the host kernel, and it shows.** A runc-specific host breakout
lands roughly once a year — CVE-2019-5736 (overwrite the host runc binary),
CVE-2024-21626 ("Leaky Vessels"), and the Nov-2025 procfs/symlink trio
(CVE-2025-31133 / -52565 / -52881). `[INCIDENT]` But that undercounts the
exposure: because the guest calls the host kernel directly, **every userspace
kernel privilege-escalation is also a container escape** — Dirty Pipe and its
kin, dozens a year across the kernel. The independent study
(arXiv:2606.08433) `[INDEP]` measured it bluntly: under runc the guest `uname` is
the host kernel string verbatim and the init thread carries **no seccomp filter
at all**.

**gVisor has no modern host-escape CVE.** The only full escape on record is
CVE-2018-16359, pre-1.0. Everything since is info-leak or internal-only, never
host takeover, because the Sentry answers syscalls in userspace and only ~84
host syscalls are reachable behind it `[INDEP]`. `[INCIDENT]`

**microVMs (Firecracker/Kata) have no recorded hypervisor escape** — but are the
least-fuzzed class, so the clean record is partly less scrutiny `[INDEP]`. And
they need `/dev/kvm`, which we do not have.

**Who runs untrusted multi-tenant code on what** `[VENDOR-DOC]`: Google Cloud Run
gen1, GKE Sandbox and Modal use gVisor; Cloud Run gen2, AWS Lambda, Fly.io and
E2B use Firecracker microVMs; GitHub-hosted Actions runners use a **fresh VM per
job, destroyed after**. The pattern is unanimous: everyone serious about
untrusted code uses **gVisor or a microVM** — nobody treats hardened runc as the
sole boundary. Anthropic's own `sandbox-runtime` (bubblewrap) says outright it
"does not provide meaningful protection against kernel exploits" and is scoped to
a trusted host, not multi-tenancy.

Two constraints worth stating plainly:

- **Kata/Firecracker are unavailable without KVM.** Every Kata backend is
  KVM-based; the Go→Rust runtime-rs rewrite changed the shim language, not the
  KVM requirement `[VENDOR-DOC]`. On stock cloud VMs, microVM isolation is simply
  off the table until we have bare metal or nested virt.
- **The independent study is single-tenant-scoped and refuses an overall
  ranking** `[INDEP]`. It explicitly puts tenant-A-vs-tenant-B isolation out of
  scope — which is exactly our case. So gVisor's evidence base supports "a real
  kernel boundary without KVM", not "certified safe between hostile tenants".

## 3. The decision

| | Hardened runc / Sysbox | **gVisor (runsc + systrap)** | microVM (Firecracker/Kata) |
|---|---|---|---|
| Boundary | shared host kernel | userspace kernel (Sentry) | hardware virt, separate kernel |
| Stops kernel-LPE escapes | **no** | yes | yes |
| Works without `/dev/kvm` | yes | **yes** | no |
| Shipped for untrusted code by | nobody, as sole boundary | Cloud Run gen1, GKE Sandbox, Modal | Cloud Run gen2, Lambda, Fly, E2B |
| Our measured overhead | ~native | +60–80 % on file/syscall work | not measurable here (no KVM) |

**For us, today, on ordinary cloud VMs: gVisor is the answer.** It is the only
substrate that gives a real kernel boundary without hardware virtualisation; it
is the one with no modern host-escape CVE; it is proven in production for exactly
this; and the overhead we measured lands on amortised setup, not per turn. Stack
the cheap Tier-1 hardening *inside* it — user namespaces, dropped capabilities,
read-only root, seccomp, cgroups — as defence in depth, not as the boundary.

**One rule matters more than the tier:** sandboxes must be **single-use and
ephemeral**, never reused across clients or tasks, behind an egress proxy that
default-denies. That — plus gVisor — is what made GitHub's untrusted-PR runners
safe, and it does more in practice than any runc-vs-gVisor nuance.

**Move up to a microVM when** any of these becomes true: we can get KVM (bare
metal, `.metal` SKUs, or by offloading execution to E2B/Fly/Modal); a client
contractually demands hardware isolation between tenants (gVisor's evidence base
does not cover that); a gVisor Sentry escape actually lands; or a workload needs
kernel features gVisor doesn't emulate (the reason Google itself moved Cloud Run
gen2 off gVisor).

## 4. The other boundary — the agent's own OS sandbox

Everything above is one boundary: a container around the agent, protecting **our
host from the agent**. There is a second, orthogonal one — the agent's **own OS
sandbox**, protecting **the machine it runs on from the agent** — and it answers
a different threat with a different mechanism. Naming both keeps the design
honest.

The mechanism is OS-level: seccomp + Landlock on Linux, Seatbelt
(`sandbox-exec`) on macOS. Codex ships it as `--sandbox` modes (read-only /
workspace-write / danger-full-access); Claude Code exposes a `sandbox` block in
settings (network allowlist, filesystem allow/deny, seccomp); Anthropic
open-sourced the underlying `sandbox-runtime` (bubblewrap / Seatbelt) in
Nov 2025.

**Why it is worth having, in one sentence:** today "everything is allowed inside
a turn" rests on *our* code — `auto_allowed` in `session.rs` waves read-only and
memory tools through, and the Slack Approve/Deny buttons gate the rest. That is
an assertion we make. Run the adapter under its own OS sandbox and the same
claim becomes one the **harness enforces in the kernel** — a policy someone
other than us checks, that the model cannot talk its way past. It also buys
autonomy: the point of Codex's `workspace-write` is that the agent runs commands
*without asking*, because the sandbox, not a human, is what stops damage. Fewer
buttons for the developer, and a stronger guarantee behind them.

**Where it fits — and where it does not.** An OS sandbox is the **same kernel**.
It confines files and network; it does **not** defend against a kernel exploit —
Anthropic's own `sandbox-runtime` README says bubblewrap/Seatbelt "do not
provide meaningful protection against kernel exploits". So:

- **BYOA, on the developer's laptop** — this is the right tool, and it *replaces*
  our coarse buttons with fine-grained, enforced policy. The code there is
  semi-trusted (their repo, their machine); the threat is "the agent did
  something dumb or was prompt-injected", which is exactly what seccomp/Seatbelt
  stop. No container is available or wanted on someone's laptop; the agent's own
  sandbox is the whole boundary.
- **Hosted client agents** — here it is a layer *inside* the container, not the
  boundary. The code is hostile by definition and the threat includes kernel
  escape, which only gVisor/microVM stop. The OS sandbox *composes* with them:
  agent under its `--sandbox` (what the agent may touch) inside gVisor (what the
  container may reach the kernel for) behind an egress proxy (what leaves the
  box). Three layers, each catching a different class of miss.

**So the tiers in §3 are not the whole picture — they are the outer boundary.**
The agent's OS sandbox is a second, cheaper boundary that is the *primary* one in
BYOA and a *reinforcing* one when hosted. For BYOA specifically the right first
step is not a container at all: it is to stop relying solely on `auto_allowed`
and run the adapter under its native sandbox mode, passing it our policy (the
allowed directory, the egress allowlist). Whether `claude-agent-acp` can enable
that mode and accept our policy through ACP is the open question — not yet
checked.

## 5. What to do next

1. **Benchmark the real agent, not a probe.** These numbers are proxies; run an
   actual multi-file task under runsc and confirm the per-turn (not setup) hit is
   what this predicts.
2. **Keep the image thin and pre-pulled** — the 269 MB adapter dominates cold
   start regardless of runtime.
3. **Design the egress proxy now**, not later: for hostile code it is as
   load-bearing as the kernel boundary, and gVisor does not provide it.

## Sources

Incidents: runc GHSA-9493-h29p-rfm2; Sysdig and CNCF runc-escape write-ups;
gvisor.dev/security. Independent: arXiv:2606.08433 (2026); USENIX HotCloud'19
"The True Cost of Containing" (ptrace-era, now stale); Springer Cluster
Computing 2022. Vendor docs: GCP Cloud Run execution environments; Kata
installation/hypervisors docs; gVisor systrap and directfs posts; Anthropic
sandbox-runtime README. Our own measurements: this machine, `runsc
release-20260727.0` vs runc, 2026-08-06.
