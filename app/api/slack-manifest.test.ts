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
  "utf8"
);
const oauthSource = readFileSync(
  resolve(root, "app/api/slack-oauth.ts"),
  "utf8"
);

/** Scopes the SaaS asks for at install time. */
function requestedScopes(): string[] {
  const block = oauthSource.match(/SLACK_SCOPES = \[([\s\S]*?)\]\.join/);
  if (!block) throw new Error("SLACK_SCOPES not found in slack-oauth.ts");
  return [...block[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
}

/** Bot scopes the manifest declares (the `bot:` list under oauth_config). */
function manifestBotScopes(): string[] {
  const block = manifest.match(/\n {4}bot:\n([\s\S]*?)\nsettings:/);
  if (!block) throw new Error("bot scopes not found in the manifest");
  return [...block[1].matchAll(/^ {6}- (\S+)/gm)].map(m => m[1]);
}

/** User scopes the manifest declares. Sign-in only by design. */
function manifestUserScopes(): string[] {
  const block = manifest.match(/\n {4}user:\n([\s\S]*?)\n {4}bot:/);
  if (!block) throw new Error("user scopes not found in the manifest");
  return [...block[1].matchAll(/^ {6}- (\S+)/gm)].map(m => m[1]);
}

describe("production Slack manifest", () => {
  it("declares exactly the scopes the install flow requests", () => {
    expect([...manifestBotScopes()].sort()).toEqual(
      [...requestedScopes()].sort()
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
    const urls = [...manifest.matchAll(/request_url: (\S+)/g)].map(m => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toBe("https://opentag-hooks.farol.team/slack/events");
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
 * forms the rename keeps; where a pattern has to match the old name, it is
 * written so that it does not contain it (the `grep [f]oo` idiom).
 */

function read(relative: string): string {
  const path = resolve(root, relative);
  expect(existsSync(path), `${relative} must exist`).toBe(true);
  return readFileSync(path, "utf8");
}

/**
 * Hosts the rename is allowed to leave behind: the parent domain itself and
 * the two subdomains this product moves to. A host under the parent domain is
 * NOT blessed wholesale — `app.` and `hooks.` without `opentag.` are the dead
 * ones, and a rename that leaves them behind is the rename not happening.
 */
const KEPT_HOSTS = new Set([
  "farol.team",
  "opentag.farol.team",
  "opentag-hooks.farol.team",
]);

/**
 * The one reverse-DNS identifier the rename keeps, spelled out. A pattern
 * here — `team.<parent>.<anything>` — would bless the identifier this card
 * exists to change, since the OLD bundle id has exactly that shape; and a
 * `git grep` guard reports `path:line:text`, so the identifier in `config.rs`
 * stops being a survivor the moment its crate directory is renamed, whether
 * or not anyone touched the string. [S10] asserts both files directly for
 * that reason; this constant only keeps them out of the survivor list.
 */
const KEPT_IDENTIFIER = "team.farol.opentag";

/**
 * Names of live Yandex Cloud resources, spelled out one by one rather than
 * matched by shape. They survive only in the deploy runbook, and only because
 * the resources themselves are not renamed here — [S11] holds each of them to
 * the id documented beside it, so this list cannot quietly bless a leftover.
 */
const KEPT_INFRA_FILE = "docs/deploy.md";
const KEPT_INFRA = [
  /`f[a]rol`/g,
  /f[a]rol-app/g,
  /f[a]rol-cloud/g,
  /f[a]rol_production/g,
  /\/var\/lib\/f[a]rol\/ovdata/g,
];

/** Remove every form of the old name the rename keeps, so that whatever
 *  survives is a leftover. A grep hit is `path:line:text`, so the path the
 *  hit came from decides whether the infrastructure names apply. */
function stripKeptNames(line: string): string {
  const infra = line.startsWith(`${KEPT_INFRA_FILE}:`)
    ? KEPT_INFRA.reduce((acc, name) => acc.replace(name, ""), line)
    : line;
  return (
    infra
      // the GitHub org path, which is not moving
      .replace(/f[a]rol-team/gi, "")
      // the kept reverse-DNS identifier, and only it
      .replaceAll(KEPT_IDENTIFIER, "")
      // ...and the same identifier split into the qualifier, organization and
      // application that the directories crate asks for
      .replace(/"team",\s*"f[a]rol"/gi, "")
      // a host under the parent domain, kept only if it is one of ours
      .replace(/[a-z0-9.-]*f[a]rol\.team/gi, host =>
        KEPT_HOSTS.has(host.toLowerCase()) ? "" : host
      )
  );
}

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
  ":(exclude).claude/learnings.jsonl",
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
  it("[S1] leaves only the org path, the parent domain and its reverse DNS", () => {
    const hits = guardedGrep();
    // A grep that matched nothing at all would pass the filter below for the
    // wrong reason — the kept forms are still in the tree by design.
    expect(hits.length).toBeGreaterThan(0);
    const survivors = hits.filter(line =>
      /f[a]rol/i.test(stripKeptNames(line))
    );
    expect(survivors).toEqual([]);
  });

  // The grep above says no old name survives. It cannot say the new names
  // agree with each other, and an env var is renamed in two files or not at
  // all: the deploy is where a half-swept family surfaces, long after every
  // suite went green. So each family below is pinned at its declaration and
  // at the code that reads it, the way [S5] pins the handshake headers.
  // Nor can it say the new spelling is OpenTag rather than some third name —
  // [S9] and [S10] pin the identities the guard would otherwise wave through.

  it("[S8] reads in cloud/ exactly the env vars cloud/ declares", () => {
    const config = read("cloud/app/config.py");
    const example = read("cloud/.env.example");
    const compose = read("cloud/docker-compose.yml");

    // Required means no default: startup dies without it, so both the
    // template a person copies and the compose file must carry it.
    const required = [...config.matchAll(/os\.environ\["([A-Z0-9_]+)"\]/g)]
      .map(m => m[1])
      .sort();
    expect(required).toEqual([
      "INTERNAL_API_SECRET",
      "OPENTAG_CLOUD_PUBLIC_URL",
      "OPENTAG_SAAS_URL",
      "OPENVIKING_ROOT_KEY",
      "SLACK_SIGNING_SECRET",
    ]);

    const declared = new Set(
      [...example.matchAll(/^([A-Z0-9_]+)=/gm)].map(m => m[1])
    );
    const passedThrough = new Set(
      [...compose.matchAll(/^ {6}([A-Z0-9_]+): /gm)].map(m => m[1])
    );
    for (const name of required) {
      expect(
        declared.has(name),
        `${name} missing from cloud/.env.example`
      ).toBe(true);
      expect(
        passedThrough.has(name),
        `${name} missing from cloud/docker-compose.yml`
      ).toBe(true);
    }
  });

  it("[S8] reads in app/ exactly the env vars app/.env.example declares", () => {
    const envTs = read("app/api/lib/env.ts");
    const example = read("app/.env.example");

    // Matched on CLOUD_URL, not on position: env.ts has other fields of the
    // same `(process.env.X ?? "")` shape, and reordering the object must not
    // decide which one this assertion is talking about.
    const cloudUrl = [
      ...envTs.matchAll(/(\w+): \(process\.env\.(\w*CLOUD_URL) \?\? ""\)/g),
    ];
    expect(cloudUrl.length, "env.ts must expose the cloud service URL").toBe(1);
    expect(cloudUrl[0][1]).toBe("opentagCloudUrl");
    expect(cloudUrl[0][2]).toBe("OPENTAG_CLOUD_URL");

    const declared = new Set(
      [...example.matchAll(/^([A-Z0-9_]+)=/gm)].map(m => m[1])
    );
    const consumed = [
      ...[...envTs.matchAll(/required\("([A-Z0-9_]+)"\)/g)].map(m => m[1]),
      ...[...envTs.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map(m => m[1]),
    ]
      // NODE_ENV is the runtime's, not this app's; nothing declares it.
      .filter(name => name !== "NODE_ENV");
    expect(consumed.length).toBeGreaterThan(0);
    for (const name of new Set(consumed)) {
      expect(declared.has(name), `${name} missing from app/.env.example`).toBe(
        true
      );
    }
  });

  it("[S8] tells a person to export the env vars the runner reads", () => {
    const runners = read("app/src/pages/dashboard/Runners.tsx");
    const sources = [
      read("runner/crates/opentag-core/examples/headless.rs"),
      read("runner/apps/desktop/src-tauri/src/lib.rs"),
    ].join("\n");

    // Everything the runner reads from the environment that is its own —
    // SHELL, HOME, PATH and HOSTNAME belong to the OS.
    const os = new Set(["SHELL", "HOME", "PATH", "HOSTNAME"]);
    const reads = new Set(
      [
        ...[...sources.matchAll(/env::var(?:_os)?\("([A-Z0-9_]+)"\)/g)],
        ...[...sources.matchAll(/option_env!\("([A-Z0-9_]+)"\)/g)],
      ]
        .map(m => m[1])
        .filter(name => !os.has(name))
    );
    expect([...reads].sort()).toEqual([
      "OPENTAG_ALLOWED_CWDS",
      "OPENTAG_BUILD_SHA",
      "OPENTAG_RUNNER_TOKEN",
    ]);

    // The dashboard hands out a copy-paste snippet; every variable it exports
    // has to be one the runner actually looks at.
    const exported = [...runners.matchAll(/export ([A-Z0-9_]+)=/g)].map(
      m => m[1]
    );
    expect(exported.length).toBeGreaterThan(0);
    for (const name of new Set(exported)) {
      expect(reads.has(name), `the runner never reads ${name}`).toBe(true);
    }
  });

  it("[S3] builds one crate named opentag-core, and every use site names it", () => {
    // `cargo check --workspace` is the plan's gate; these are the artefact
    // facts that make it pass, and they fail here without a Rust toolchain.
    const workspace = read("runner/Cargo.toml");
    const members = (workspace.match(/members = \[([^\]]*)\]/)?.[1] ?? "")
      .split(",")
      .map(m => m.trim().replace(/"/g, ""))
      .filter(Boolean);
    expect(members).toContain("crates/opentag-core");
    for (const member of members) {
      expect(existsSync(resolve(root, "runner", member)), member).toBe(true);
    }

    expect(read("runner/crates/opentag-core/Cargo.toml")).toMatch(
      /^name = "opentag-core"$/m
    );

    const desktopToml = read("runner/apps/desktop/src-tauri/Cargo.toml");
    expect(desktopToml).toMatch(/^name = "opentag-runner-desktop"$/m);
    const dep = desktopToml.match(/^opentag-core = \{ path = "([^"]+)"/m);
    expect(dep, "src-tauri must depend on opentag-core").not.toBeNull();
    expect(
      existsSync(resolve(root, "runner/apps/desktop/src-tauri", dep![1]))
    ).toBe(true);

    // Whatever the desktop app imports must be the crate the workspace builds.
    const lib = read("runner/apps/desktop/src-tauri/src/lib.rs");
    const imported = [...lib.matchAll(/^use (\w+_core)::/gm)].map(m => m[1]);
    expect(imported.length).toBeGreaterThan(0);
    expect([...new Set(imported)]).toEqual(["opentag_core"]);
    expect(read("runner/apps/desktop/src-tauri/src/main.rs")).toContain(
      "opentag_runner_desktop::run()"
    );
  });

  it("[S5] announces x-opentag-runner-* and the cloud reads those same names", () => {
    const cloudRs = read("runner/crates/opentag-core/src/cloud.rs");
    const runnerApi = read("cloud/app/runner_api.py");
    // Deduplicated on both sides: this compares two vocabularies, and a
    // second mention of a header name (a doc comment, a retry path) is not a
    // third header.
    const sent = [
      ...new Set(
        [...cloudRs.matchAll(/"(x-[a-z0-9-]+-runner-[a-z]+)"/g)].map(m => m[1])
      ),
    ];
    const received = [
      ...new Set(
        [
          ...runnerApi.matchAll(
            /headers\.get\("(x-[a-z0-9-]+-runner-[a-z]+)"/g
          ),
        ].map(m => m[1])
      ),
    ];
    expect([...sent].sort()).toEqual([
      "x-opentag-runner-os",
      "x-opentag-runner-version",
    ]);
    // The double mirror: neither side may be renamed without the other.
    expect([...received].sort()).toEqual([...sent].sort());
  });

  it("[S5] dials the OpenTag hosts, and no host under the old name", () => {
    // The connection the runner opens is the one thing a rename can leave
    // pointing at a dead name and still compile, still type-check, still
    // pass every grep that blesses the parent domain.
    const configRs = read("runner/crates/opentag-core/src/config.rs");
    const hosts = [
      ...configRs.matchAll(/(?:wss|https):\/\/([a-z0-9.-]+)/g),
    ].map(m => m[1]);
    expect(hosts.length).toBeGreaterThan(0);
    expect([...new Set(hosts)].sort()).toEqual([
      "opentag-hooks.farol.team",
      "opentag.farol.team",
    ]);
    expect(configRs).toContain('"wss://opentag-hooks.farol.team/runner/v1"');

    // The SaaS the runner is sent to sign in at is the SaaS Slack redirects
    // to — one host, named in two repositories' worth of artefacts.
    expect(configRs).toContain('"https://opentag.farol.team"');
    expect(manifest).toContain("https://opentag.farol.team/api/oauth/callback");
  });

  it("[S6] publishes, updates from and offers for download the same assets", () => {
    const workflow = read(".github/workflows/runner-release.yml");
    const runners = read("app/src/pages/dashboard/Runners.tsx");
    const tauri = JSON.parse(
      read("runner/apps/desktop/src-tauri/tauri.conf.json")
    );
    const tracker = JSON.parse(read(".claude/tracker.json"));

    expect(workflow).toContain(
      "cargo build --release -p opentag-core --example headless"
    );
    expect([...workflow.matchAll(/asset: (\S+)/g)].map(m => m[1])).toEqual([
      "opentag-runner-darwin-arm64",
      "opentag-runner-darwin-x64",
    ]);

    // The .dmg the dashboard links to has to be one the workflow stages.
    const dmg = runners.match(/\$\{RELEASE_BASE\}\/(\S+?)`/)?.[1];
    expect(dmg).toBe("opentag-runner-macos.dmg");
    expect(workflow).toContain(`cp "$dmg" ${dmg}`);
    expect(workflow).toContain("opentag-runner-macos.app.tar.gz");

    // ...and both point at the repository this project becomes. Pinned as a
    // literal, not read back from the tracker: deriving the expectation from
    // a file in the same rename would bless leaving all three unrenamed.
    const repo = "farol-team/opentag";
    expect(tracker.tracker.repo).toBe(repo);
    const base = `https://github.com/${repo}/releases/latest/download`;
    expect(tauri.plugins.updater.endpoints).toEqual([`${base}/latest.json`]);
    expect(runners).toContain(base);

    // The build stamp shown in the app footer is set by this workflow.
    const stamped = [...workflow.matchAll(/^ *(\w+_BUILD_SHA):/gm)].map(
      m => m[1]
    );
    expect(stamped).toEqual(["OPENTAG_BUILD_SHA"]);
    expect(read("runner/apps/desktop/src-tauri/src/lib.rs")).toContain(
      'option_env!("OPENTAG_BUILD_SHA")'
    );
  });

  it("[S9] names the OV service users, the cookie and the attachments dir OpenTag", () => {
    // Outside the families pinned above, the guarded grep proves only that
    // the old name is gone — `ov-ingest`, `sid`, `.agent` would all pass it.
    // These are identities and paths that live on after the rename (an
    // OV tenant's history, a browser's cookie jar, a checkout on disk), so
    // each is pinned to the spelling positively.
    const memory = read("cloud/app/memory.py");
    const ingest = memory.match(/^INGEST_USER = "([a-z0-9-]+)"$/m);
    expect(
      ingest,
      "memory.py must name the ingest service user"
    ).not.toBeNull();
    expect(ingest![1]).toBe("opentag-ingest");

    const admin = memory.match(/admin_user_id: str = "([a-z0-9-]+)"/);
    expect(admin, "memory.py must name the admin service user").not.toBeNull();
    expect(admin![1]).toBe("opentag-admin");

    // The dashboard reads OV under one identity, in every call it makes.
    const dashboard = [
      ...read("cloud/app/internal_api.py").matchAll(
        /ov_client\.\w+\(\s*account,\s*"([a-z0-9-]+)"/g
      ),
    ].map(m => m[1]);
    expect(dashboard.length).toBeGreaterThan(0);
    expect([...new Set(dashboard)]).toEqual(["opentag-dashboard"]);

    const cookie = read("app/contracts/constants.ts").match(
      /cookieName: "([a-z0-9_]+)"/
    );
    expect(cookie, "constants.ts must name the session cookie").not.toBeNull();
    expect(cookie![1]).toBe("opentag_sid");

    // Written into whatever repository the agent is working in, so it is a
    // name other people read in `git status`.
    const attachments = read("runner/crates/opentag-core/src/session.rs").match(
      /cwd\.join\("(\.[a-z0-9-]+)"\)/
    );
    expect(attachments, "session.rs must name the dot dir").not.toBeNull();
    expect(attachments![1]).toBe(".opentag");
  });

  it("[S10] keeps exactly one reverse-DNS identifier, and it is the OpenTag one", () => {
    const configRs = read("runner/crates/opentag-core/src/config.rs");
    const tauri = JSON.parse(
      read("runner/apps/desktop/src-tauri/tauri.conf.json")
    );

    // Read off the two files rather than inferred from the survivor list:
    // the guard reports `path:line:text`, so once the crate directory is
    // renamed a stale identifier inside it stops being a survivor with
    // nobody having touched the string. The keychain entry a person already
    // granted and the bundle id macOS remembers are exactly the names that
    // must not be left half-renamed.
    const keyring = configRs.match(/const KEYRING_SERVICE: &str = "([^"]+)"/);
    expect(keyring, "config.rs must name the keychain service").not.toBeNull();
    expect(keyring![1]).toBe(KEPT_IDENTIFIER);
    expect(tauri.identifier).toBe(KEPT_IDENTIFIER);

    // ...and the same identifier in the split form the directories crate
    // asks for: qualifier, organization, application.
    expect(configRs).toContain(
      'ProjectDirs::from("team", "farol", "opentag-runner")'
    );
  });

  it("[S11] leaves the live Yandex Cloud resource names in the runbook", () => {
    // A brand sweep renames copy. These are not copy: they are the names of
    // resources that exist right now and that this change does not touch —
    // the ids beside them are unchanged, which is the proof. Renaming them in
    // the runbook makes it describe infrastructure that does not exist, and
    // an operator following it connects to a database that is not there. The
    // OpenViking bind is the sharp one: a redeploy against the wrong path
    // mounts an empty directory and drops every team's memory, the incident
    // the same file records as fixed on 2026-08-05.
    const deploy = read("docs/deploy.md");
    const lines = deploy.split("\n");
    const live: [string, RegExp][] = [
      ["d5dlva46uvlltllf4u4h", /`f[a]rol`/], // API Gateway
      ["bba36ne3gvlk1qu5qki2", /f[a]rol-app/], // Serverless Container
      ["crpvie6a47kkgl03v9fm", /`f[a]rol`/], // Container Registry
      ["c9qe8tqpdv4s5n4lmrvf", /f[a]rol_production/], // PostgreSQL database
      ["fhmg7l4iie50a930hs9m", /f[a]rol-cloud/], // cloud VM
    ];
    for (const [id, name] of live) {
      const documented = lines.filter(l => l.includes(id));
      expect(
        documented.length,
        `docs/deploy.md must document ${id}`
      ).toBeGreaterThan(0);
      expect(
        documented.some(l => name.test(l)),
        `${id} must be documented next to its real name ${name}`
      ).toBe(true);
    }

    // The image repositories the redeploy recipes push to and pull from.
    expect(deploy).toMatch(/crpvie6a47kkgl03v9fm\/f[a]rol-app:/);
    expect(deploy).toMatch(/crpvie6a47kkgl03v9fm\/f[a]rol-cloud:/);

    // The bind holding OpenViking's store on the VM, and no invented one.
    expect(deploy).toMatch(/\/var\/lib\/f[a]rol\/ovdata/);
    expect(deploy).not.toContain("/var/lib/opentag/ovdata");
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
