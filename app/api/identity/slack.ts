import * as jose from "jose";
import { env } from "../lib/env";

const AUTHORIZE_URL = "https://slack.com/openid/connect/authorize";
const TOKEN_URL = "https://slack.com/api/openid.connect.token";
const USERINFO_URL = "https://slack.com/api/openid.connect.userInfo";
const JWKS_URL = "https://slack.com/openid/connect/keys";
const ISSUER = "https://slack.com";

export const OIDC_SCOPES = "openid profile email";

export function buildAuthorizeUrl(opts: {
  redirectUri: string;
  state: string;
  nonce: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", env.slackClientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", OIDC_SCOPES);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("nonce", opts.nonce);
  return url.toString();
}

export type OidcTokenResponse = {
  ok: boolean;
  access_token: string;
  id_token: string;
  token_type?: string;
};

export async function exchangeCode(
  code: string,
  redirectUri: string
): Promise<OidcTokenResponse> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.slackClientId,
      client_secret: env.slackClientSecret,
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Slack token exchange failed (${resp.status}): ${text}`);
  }
  const data = (await resp.json()) as OidcTokenResponse & { error?: string };
  if (!data.ok || !data.id_token || !data.access_token) {
    throw new Error(
      `Slack token exchange rejected: ${data.error ?? "unknown"}`
    );
  }
  return data;
}

let jwks: ReturnType<typeof jose.createRemoteJWKSet> | undefined;

function getJwks() {
  jwks ??= jose.createRemoteJWKSet(new URL(JWKS_URL));
  return jwks;
}

/** Verify a Slack-issued id_token: signature (JWKS, RS256), issuer,
 *  audience (= our client id) and the nonce we bound to the OAuth state. */
export async function verifyIdToken(
  idToken: string,
  expectedNonce?: string | null
): Promise<jose.JWTPayload> {
  const { payload } = await jose.jwtVerify(idToken, getJwks(), {
    issuer: ISSUER,
    audience: env.slackClientId,
  });
  if (!payload.sub) {
    throw new Error("sub missing from id_token");
  }
  if (expectedNonce && payload.nonce !== expectedNonce) {
    throw new Error("id_token nonce mismatch");
  }
  return payload;
}

export type SlackUserInfo = {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
  "https://slack.com/team_id"?: string;
  "https://slack.com/user_id"?: string;
};

export async function fetchUserInfo(
  accessToken: string
): Promise<SlackUserInfo> {
  const resp = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Slack userInfo failed (${resp.status}): ${text}`);
  }
  const data = (await resp.json()) as SlackUserInfo & {
    ok?: boolean;
    error?: string;
  };
  if (data.ok === false || !data.sub) {
    throw new Error(`Slack userInfo rejected: ${data.error ?? "unknown"}`);
  }
  return data;
}
