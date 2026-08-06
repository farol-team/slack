import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The production manifest drifted from the code once already: the app had been
 * granted DMs, file reads, reactions and button interactivity by hand, while
 * the checked-in manifest still described the install of three months earlier.
 * Applying it would have silently revoked working features, because a manifest
 * replaces the whole app configuration.
 *
 * These tests read both files as text rather than importing the module — the
 * point is that the two artefacts agree, and importing `slack-oauth.ts` would
 * drag in env validation that has nothing to do with the question.
 */

const root = resolve(__dirname, "..", "..");
const manifest = readFileSync(
  resolve(root, "cloud/slack-app-manifest.prod.yaml"),
  "utf8",
);
const oauthSource = readFileSync(
  resolve(root, "app/api/slack-oauth.ts"),
  "utf8",
);

/** Scopes the SaaS asks for at install time. */
function requestedScopes(): string[] {
  const block = oauthSource.match(/SLACK_SCOPES = \[([\s\S]*?)\]\.join/);
  if (!block) throw new Error("SLACK_SCOPES not found in slack-oauth.ts");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Bot scopes the manifest declares (the `bot:` list under oauth_config). */
function manifestBotScopes(): string[] {
  const block = manifest.match(/\n {4}bot:\n([\s\S]*?)\nsettings:/);
  if (!block) throw new Error("bot scopes not found in the manifest");
  return [...block[1].matchAll(/^ {6}- (\S+)/gm)].map((m) => m[1]);
}

/** User scopes the manifest declares. Sign-in only by design. */
function manifestUserScopes(): string[] {
  const block = manifest.match(/\n {4}user:\n([\s\S]*?)\n {4}bot:/);
  if (!block) throw new Error("user scopes not found in the manifest");
  return [...block[1].matchAll(/^ {6}- (\S+)/gm)].map((m) => m[1]);
}

describe("production Slack manifest", () => {
  it("declares exactly the scopes the install flow requests", () => {
    expect([...manifestBotScopes()].sort()).toEqual(
      [...requestedScopes()].sort(),
    );
  });

  it("asks a human for sign-in and nothing else", () => {
    // A user token can act as the person who granted it, which is the one
    // thing this product must never do: the point of the thread is that an
    // agent's action is visibly an agent's. Sign-in scopes carry no such
    // power, and the install flow must not ask for a user grant at all.
    expect([...manifestUserScopes()].sort()).toEqual([
      "email",
      "openid",
      "profile",
    ]);
    expect(oauthSource).not.toContain("user_scope=");
  });

  it("keeps interactivity on — Approve/Deny/Stop are buttons", () => {
    expect(manifest).toMatch(/interactivity:\n {4}is_enabled: true/);
  });

  it("subscribes to every event the cloud handles", () => {
    // cloud/app/slack_app.py registers app_mention, message and file_deleted;
    // `message` reaches us as the three channel-type events below.
    for (const event of [
      "app_mention",
      "message.channels",
      "message.groups",
      "message.im",
      "message.mpim",
      "file_deleted",
    ]) {
      expect(manifest).toContain(`- ${event}`);
    }
  });

  it("[S2] points events at the cloud, not at the SaaS gateway", () => {
    // The API Gateway strips Slack's signature headers, so events must go
    // straight to the VM behind Caddy.
    const urls = [...manifest.matchAll(/request_url: (\S+)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toBe("https://hooks.opentag.farol.team/slack/events");
    }
  });

  it("[S2] keeps both redirect URLs — sign-in and bot install", () => {
    expect(manifest).toContain("https://opentag.farol.team/api/oauth/callback");
    expect(manifest).toContain("https://opentag.farol.team/api/slack/callback");
  });
});

/**
 * The rename to OpenTag is one change across four toolchains, and the two
 * attempts before it failed the same way: a name was updated at the producer
 * and left behind at the consumer. So most of what follows compares two
 * artefacts rather than asserting a literal — the header the runner sends
 * against the header the cloud reads, the asset the release workflow stages
 * against the asset the dashboard links to. The guarded grep runs here too,
 * so a stray old name fails the suite instead of waiting for a human's eye.
 *
 * This file is read by its own grep, so it may only spell the old name in the
 * two forms the rename keeps; where a pattern has to match the old name, it is
 * written so that it does not contain it (the `grep [f]oo` idiom).
 */

function read(relative: string): string {
  const path = resolve(root, relative);
  expect(existsSync(path), `${relative} must exist`).toBe(true);
  return readFileSync(path, "utf8");
}

/** Everything the rename keeps: the org path and the parent domain. One
 *  pattern covers both — and strips itself out of this file. */
const KEPT = /farol.team/gi;

/** The grep from the plan's `## Tests`, minus history and the synced kit. */
const GUARDED_GREP = [
  "grep",
  "-in",
  "f[a]rol",
  "--",
  ".",
  ":(exclude)docs/spikes",
  ":(exclude)docs/claude-tag-comparison.md",
  ":(exclude).flow",
  ":(exclude).claude/KIT_REVISION",
  ":(exclude).github/workflows/kit.yml",
  ":(exclude)bin/workflow-kit-sync",
];

function guardedGrep(): string[] {
  let out: string;
  try {
    out = execFileSync("git", GUARDED_GREP, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    // git grep exits 1 on "no matches", which is a result, not a failure.
    const err = e as { status?: number; stdout?: string };
    if (err.status !== 1) throw e;
    out = err.stdout ?? "";
  }
  return out.split("\n").filter(Boolean);
}

describe("the OpenTag rename", () => {
  it("[S1] leaves only the farol-team org path and the farol.team domain", () => {
    // The env-var family lives or dies here: a half-swept OPENTAG_* rename
    // leaves the old variable name in a file this grep reads.
    const hits = guardedGrep();
    // A grep that matched nothing at all would pass the filter below for the
    // wrong reason — the kept forms are still in the tree by design.
    expect(hits.length).toBeGreaterThan(0);
    const survivors = hits.filter((line) => /f[a]rol/i.test(line.replace(KEPT, "")));
    expect(survivors).toEqual([]);
  });

  it("[S3] builds one crate named opentag-core, and every use site names it", () => {
    // `cargo check --workspace` is the plan's gate; these are the artefact
    // facts that make it pass, and they fail here without a Rust toolchain.
    const workspace = read("runner/Cargo.toml");
    const members = (workspace.match(/members = \[([^\]]*)\]/)?.[1] ?? "")
      .split(",")
      .map((m) => m.trim().replace(/"/g, ""))
      .filter(Boolean);
    expect(members).toContain("crates/opentag-core");
    for (const member of members) {
      expect(existsSync(resolve(root, "runner", member)), member).toBe(true);
    }

    expect(read("runner/crates/opentag-core/Cargo.toml")).toMatch(
      /^name = "opentag-core"$/m,
    );

    const desktopToml = read("runner/apps/desktop/src-tauri/Cargo.toml");
    expect(desktopToml).toMatch(/^name = "opentag-runner-desktop"$/m);
    const dep = desktopToml.match(/^opentag-core = \{ path = "([^"]+)"/m);
    expect(dep, "src-tauri must depend on opentag-core").not.toBeNull();
    expect(
      existsSync(resolve(root, "runner/apps/desktop/src-tauri", dep![1])),
    ).toBe(true);

    // Whatever the desktop app imports must be the crate the workspace builds.
    const lib = read("runner/apps/desktop/src-tauri/src/lib.rs");
    const imported = [...lib.matchAll(/^use (\w+_core)::/gm)].map((m) => m[1]);
    expect(imported.length).toBeGreaterThan(0);
    expect([...new Set(imported)]).toEqual(["opentag_core"]);
    expect(read("runner/apps/desktop/src-tauri/src/main.rs")).toContain(
      "opentag_runner_desktop::run()",
    );
  });

  it("[S5] announces x-opentag-runner-* and the cloud reads those same names", () => {
    const cloudRs = read("runner/crates/opentag-core/src/cloud.rs");
    const runnerApi = read("cloud/app/runner_api.py");
    const sent = [
      ...cloudRs.matchAll(/"(x-[a-z0-9-]+-runner-[a-z]+)"/g),
    ].map((m) => m[1]);
    const received = [
      ...runnerApi.matchAll(/headers\.get\("(x-[a-z0-9-]+-runner-[a-z]+)"/g),
    ].map((m) => m[1]);
    expect([...sent].sort()).toEqual([
      "x-opentag-runner-os",
      "x-opentag-runner-version",
    ]);
    // The double mirror: neither side may be renamed without the other.
    expect([...received].sort()).toEqual([...sent].sort());
  });

  it("[S6] publishes, updates from and offers for download the same assets", () => {
    const workflow = read(".github/workflows/runner-release.yml");
    const runners = read("app/src/pages/dashboard/Runners.tsx");
    const tauri = JSON.parse(read("runner/apps/desktop/src-tauri/tauri.conf.json"));
    const tracker = JSON.parse(read(".claude/tracker.json"));

    expect(workflow).toContain(
      "cargo build --release -p opentag-core --example headless",
    );
    expect([...workflow.matchAll(/asset: (\S+)/g)].map((m) => m[1])).toEqual([
      "opentag-runner-darwin-arm64",
      "opentag-runner-darwin-x64",
    ]);

    // The .dmg the dashboard links to has to be one the workflow stages.
    const dmg = runners.match(/\$\{RELEASE_BASE\}\/(\S+?)`/)?.[1];
    expect(dmg).toBe("opentag-runner-macos.dmg");
    expect(workflow).toContain(`cp "$dmg" ${dmg}`);
    expect(workflow).toContain("opentag-runner-macos.app.tar.gz");

    // ...and both point at the repository the tracker calls this project.
    const repo = tracker.tracker.repo;
    const base = `https://github.com/${repo}/releases/latest/download`;
    expect(tauri.plugins.updater.endpoints).toEqual([`${base}/latest.json`]);
    expect(runners).toContain(base);

    // The build stamp shown in the app footer is set by this workflow.
    const stamped = [...workflow.matchAll(/^ *(\w+_BUILD_SHA):/gm)].map(
      (m) => m[1],
    );
    expect(stamped).toEqual(["OPENTAG_BUILD_SHA"]);
    expect(read("runner/apps/desktop/src-tauri/src/lib.rs")).toContain(
      'option_env!("OPENTAG_BUILD_SHA")',
    );
  });

  it("[S7] leaves the farol-team/agent-flow kit references untouched", () => {
    // The kit is a different repository; renaming this product does not
    // rename it, and a sweep that catches these files has gone too far.
    for (const file of [
      ".claude/KIT_REVISION",
      ".github/workflows/kit.yml",
      "bin/workflow-kit-sync",
    ]) {
      expect(read(file)).toContain("farol-team/agent-flow");
    }
  });
});
