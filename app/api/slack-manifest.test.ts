import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

  it("points events at the cloud, not at the SaaS gateway", () => {
    // The API Gateway strips Slack's signature headers, so events must go
    // straight to the VM behind Caddy.
    const urls = [...manifest.matchAll(/request_url: (\S+)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toBe("https://hooks.farol.team/slack/events");
    }
  });

  it("keeps both redirect URLs — sign-in and bot install", () => {
    expect(manifest).toContain("https://app.farol.team/api/oauth/callback");
    expect(manifest).toContain("https://app.farol.team/api/slack/callback");
  });
});
