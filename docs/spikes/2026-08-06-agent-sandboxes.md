# Spike: containerising the agent — what we measured, and what we only read

**Date:** 2026-08-06. **Question:** if agents stop running on developers'
laptops and start running on machines we operate, what runs them?

**How to read this.** The measurements in §1 are ours: taken on this machine and
on a throwaway Yandex Cloud VM created and destroyed for the purpose. The
landscape in §3 is **vendor claims only** — a delegated search returned no
independent benchmark, and its own author flagged that it had earlier fabricated
a reference to a report that did not exist. Every number there is therefore
labelled with its source and treated as advertising until someone measures it.
The one third-party claim that mattered most (§2) was re-fetched and verified
directly.

## 1. What we measured

A probe image — `node:20-slim` + git + `@agentclientprotocol/claude-agent-acp`,
663 MB, of which 269 MB is the adapter — and a minimal ACP client that spawns
the adapter, sends `initialize` and times the reply.

| Measurement | Result | Where |
|---|---|---|
| `docker run` on a warm host | 0.50 – 0.69 s | this machine |
| Spawn → ACP `initialize` reply | 514 ms | this machine, in-container |
| Idle container, adapter running | < 1 MB RSS, 0% CPU | this machine |
| VM create → SSH answering | **86 s** | YC, preemptible, 2 cores @ 20%, COI image |
| Cold image pull (663 MB, same region) | **64 s** | YC VM ← `cr.yandex` |
| First container run after pull | 5.5 s | YC VM |
| Warm run → initialized agent | **~1.0 s** (1010 / 1097 / 993 ms) | YC VM |

**The headline is not the isolation technology.** A brand-new machine answers in
about two and a half minutes; the same machine with the image already pulled
answers in a second — and a second is invisible next to the time the model then
spends thinking. The design question is *whether a host is warm*, not whether it
is a container or a microVM. Anything that follows must be argued against that.

**Second finding: Firecracker is off the table where we currently stand.** The
production VM has no `/dev/kvm` and exposes no `vmx`/`svm` flags — hardware
virtualisation is not passed to the guest. Firecracker is a KVM-based VMM
(`firecracker-microvm.github.io`: KVM, "64-bit Intel, AMD and Arm CPUs with
support for hardware virtualization"), so on Yandex Cloud compute it cannot run
at all. Its advertised 125 ms boot and <5 MiB overhead are irrelevant to us
until we are on bare metal or a substrate that offers microVMs natively.

**Third: the substrate need not live where the control plane lives.** The runner
has no listening socket — outbound only. A sandbox host needs egress to our
cloud, the model API and (optionally) a package registry; no ingress, no load
balancer, no public address. So the choice of provider for sandboxes is
independent of where the SaaS runs, which is a freedom most products in this
space do not have.

## 2. gVisor — the one option that works where we already are (verified)

Re-fetched from `gvisor.dev/docs/architecture_guide/platforms/`:

- **systrap** — needs only `seccomp` with `SECCOMP_RET_TRAP`; **does not require
  `/dev/kvm`**; the default since mid-2023 and the preferred platform inside VMs.
- **ptrace** — "can run anywhere that `ptrace` works (even VMs without nested
  virtualization)"; deprecated.
- **KVM** — needs the virtualisation extensions; best on bare metal. Inside a
  nested VM "the `systrap` platform will often provide better performance…, due
  to the overhead of nested virtualization".

So a stronger boundary than a shared kernel *is* available on ordinary cloud
VMs. What is not established is the price. gVisor's own performance guide is
written qualitatively: CPU-bound work is stated to carry no runtime cost, while
"high costs of VFS operations can manifest in benchmarks that execute many such
operations", and network overhead is acknowledged for services doing little work
per request. **A coding agent is the bad case, not the good one** — it spawns
processes, walks directories, reads and writes many small files.

**This is the measurement to take before any decision:** `npm install` and a
`cargo check` under `runc` versus `runsc --platform=systrap`, on the image
above. Nobody's marketing answers it.

## 3. The landscape (vendor claims, unverified)

| Substrate | Claim | Source | Kind |
|---|---|---|---|
| Firecracker | boot "as little as 125 ms"; <5 MiB overhead; 150 microVMs/s/host | firecracker-microvm.github.io | project claim |
| Fly Machines | stopped → started "well under a second"; first create "low double digit seconds" | fly.io/docs/machines/overview | vendor claim |
| Daytona | "sub 90ms sandbox creation" | daytona.io/pricing | marketing |
| E2B, Modal, Cloudflare | no start-latency figure obtained | — | — |

The Fly distinction is the operationally useful part: **resume-from-stopped and
cold-create are different numbers**, and a vendor quoting one rarely says which.
Assume every sub-100 ms claim describes a warm pool.

Pricing shape, as gathered:

| Provider | Rate | Idle |
|---|---|---|
| E2B | $0.000014/vCPU-s (2 vCPU ≈ $0.10/hr) + RAM | paused-sandbox billing **not stated** |
| Modal | sandboxes $0.00003942/core-s, $0.00000667/GiB-s | zero — "never pay for idle" |
| Fly | shared-cpu-1x/256 MB $0.0028/hr; performance-1x/2 GB $0.0447/hr | storage only (~$0.15/GB per 30 days stopped) |
| Cloudflare | $0.000020/vCPU-s, $0.0000025/GiB-s + egress | zero; billed on request |
| Daytona | Windows $0.0858/vCPU-hr; Linux rates not on the page | not stated |

Modal, Fly and Cloudflare all charge ~nothing at rest, which suits a
mention-driven workload. Fly's stopped-machine model maps most closely onto our
per-channel directory: a machine per workspace that resumes in under a second.

**Not established:** whether E2B, Daytona or Modal are genuinely self-hostable;
Hetzner's bare-metal monthly prices (the page renders them client-side); the
operational burden of running Firecracker ourselves; the jurisdiction question
(OpenAI does not list Russia among supported countries; EU Regulation 833/2014
Art. 5n was not retrieved).

## 4. What this changes

1. **Design for a warm pool, not for per-turn provisioning.** Everything else is
   a rounding error next to 86 s + 64 s of cold start. A small always-on host
   with the image pre-pulled answers as fast as anything on the market.
2. **Measure gVisor before believing it.** It is the only way to strengthen
   isolation without leaving our current substrate, and its documented weak spot
   is exactly our workload.
3. **Keep the image thin and pre-pulled.** 269 MB of the 663 MB is the adapter;
   the pull is the single largest cold-start term, and it is the one we control.
4. **The protocol assumes a persistent client.** Our runner dials out and waits;
   serverless substrates want request/response. Yandex Serverless Containers
   would otherwise fit (up to 1 h execution, 8 GB, 10 GB image), so a one-shot
   turn mode for the runner is what would unlock request-driven hosting —
   `handle_assign` is already self-contained.
5. **Isolation is a product question, not only a technical one.** A container is
   enough for agents running our own code on our own hosts; a per-tenant kernel
   is what a customer with someone else's source code will ask about. The answer
   decides the provider, not the other way round.
