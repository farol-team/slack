import { describe, expect, it } from "vitest";

process.env.SLACK_CLIENT_ID ||= "test-client-id";

const { buildAuthorizeUrl } = await import("./slack");

describe("buildAuthorizeUrl", () => {
  it("contains client_id, redirect_uri, state, scope and nonce", () => {
    const url = new URL(
      buildAuthorizeUrl({
        redirectUri: "https://app.example.com/api/oauth/callback",
        state: "state-123",
        nonce: "nonce-abc",
      })
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://slack.com/openid/connect/authorize"
    );
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/api/oauth/callback"
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid profile email");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("nonce")).toBe("nonce-abc");
  });
});
