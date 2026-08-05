import { describe, expect, it } from "vitest";

process.env.APP_SECRET ||= "test-secret-for-session-signing";

const { signSessionToken, verifySessionToken } = await import("./session");

describe("session token", () => {
  it("round-trips a signed payload", async () => {
    const token = await signSessionToken({ userId: 42 });
    const claim = await verifySessionToken(token);
    expect(claim).toEqual({ userId: 42 });
  });

  it("rejects a tampered token", async () => {
    const token = await signSessionToken({ userId: 42 });
    const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    expect(await verifySessionToken(tampered)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signSessionToken(
      { userId: 42 },
      new Date(Date.now() - 1000)
    );
    expect(await verifySessionToken(token)).toBeNull();
  });

  it("rejects a token with a missing userId", async () => {
    expect(await verifySessionToken("not-a-jwt")).toBeNull();
  });
});
