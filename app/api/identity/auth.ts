import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import * as cookie from "cookie";
import { randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import {
  slackInstallations,
  slackOauthStates,
  workspaceMembers,
  workspaces,
} from "@db/schema";
import { Paths, Session } from "@contracts/constants";
import { Errors } from "@contracts/errors";
import { env } from "../lib/env";
import { getSessionCookieOptions } from "../lib/cookies";
import { getDb } from "../queries/connection";
import { findUserById, upsertUser } from "../queries/users";
import { signSessionToken, verifySessionToken } from "./session";
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserInfo,
  verifyIdToken,
} from "./slack";

export async function authenticateRequest(headers: Headers) {
  const cookies = cookie.parse(headers.get("cookie") || "");
  const token = cookies[Session.cookieName];
  if (!token) {
    console.warn("[auth] No session cookie found in request.");
    throw Errors.forbidden("Invalid authentication token.");
  }
  const claim = await verifySessionToken(token);
  if (!claim) {
    throw Errors.forbidden("Invalid authentication token.");
  }
  const user = await findUserById(claim.userId);
  if (!user) {
    throw Errors.forbidden("User not found. Please re-login.");
  }
  return user;
}

const oidcRedirectUri = () => `${env.publicUrl}${Paths.oauthCallback}`;

/** Only allow same-origin paths as the post-login redirect target. */
function sanitizeNext(next: string | undefined): string {
  if (next && next.startsWith("/") && !next.startsWith("//")) {
    return next.slice(0, 512);
  }
  return "/dashboard";
}

/** GET /api/auth/slack — start the "Sign in with Slack" OIDC flow. */
export async function handleSlackLogin(c: Context) {
  if (!env.slackClientId) {
    return c.json({ error: "Slack sign-in is not configured" }, 500);
  }
  const state = randomBytes(24).toString("hex");
  const nonce = randomBytes(16).toString("hex");
  await getDb()
    .insert(slackOauthStates)
    .values({
      state,
      kind: "login",
      next: sanitizeNext(c.req.query("next")),
      nonce,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
  return c.redirect(
    buildAuthorizeUrl({ redirectUri: oidcRedirectUri(), state, nonce }),
    302
  );
}

/** GET /api/oauth/callback — finish the OIDC flow: verify the one-time
 *  state, exchange the code, verify the id_token, upsert the user, link
 *  them to the team's workspace when one exists, and set the session. */
export async function handleOidcCallback(c: Context) {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");
  const errorDescription = c.req.query("error_description");

  if (error) {
    if (error === "access_denied") {
      return c.redirect(Paths.login, 302);
    }
    return c.json({ error, error_description: errorDescription }, 400);
  }
  if (!code || !state) {
    return c.json({ error: "code and state are required" }, 400);
  }

  try {
    const db = getDb();
    const [st] = await db
      .select()
      .from(slackOauthStates)
      .where(
        and(
          eq(slackOauthStates.state, state),
          eq(slackOauthStates.kind, "login"),
          gt(slackOauthStates.expiresAt, new Date())
        )
      )
      .limit(1);
    if (!st) {
      return c.redirect(`${Paths.login}?error=state`, 302);
    }
    // One-time state: consume it before doing any network calls.
    await db.delete(slackOauthStates).where(eq(slackOauthStates.id, st.id));

    const tokenResp = await exchangeCode(code, oidcRedirectUri());
    await verifyIdToken(tokenResp.id_token, st.nonce);
    const info = await fetchUserInfo(tokenResp.access_token);

    const user = await upsertUser({
      provider: "slack",
      subject: info.sub,
      email: info.email ?? null,
      name: info.name ?? null,
      avatar: info.picture ?? null,
    });

    // If the user's Slack team already has the bot installed, join the
    // workspace as a member (and link the Slack user id for BYOA routing).
    const teamId = info["https://slack.com/team_id"];
    const slackUserId = info["https://slack.com/user_id"];
    if (teamId) {
      const [inst] = await db
        .select({ id: slackInstallations.id })
        .from(slackInstallations)
        .where(eq(slackInstallations.teamId, teamId))
        .limit(1);
      if (inst) {
        const [ws] = await db
          .select()
          .from(workspaces)
          .where(eq(workspaces.slackTeamId, teamId))
          .limit(1);
        if (ws) {
          const [member] = await db
            .select()
            .from(workspaceMembers)
            .where(
              and(
                eq(workspaceMembers.workspaceId, ws.id),
                eq(workspaceMembers.userId, user.id)
              )
            )
            .limit(1);
          if (!member) {
            await db.insert(workspaceMembers).values({
              workspaceId: ws.id,
              userId: user.id,
              role: "member",
              ovUserKey: `ovu_${randomBytes(16).toString("hex")}`,
              slackUserId: slackUserId ?? null,
            });
          } else if (slackUserId && !member.slackUserId) {
            await db
              .update(workspaceMembers)
              .set({ slackUserId })
              .where(eq(workspaceMembers.id, member.id));
          }
        }
      }
    }

    const token = await signSessionToken({ userId: user.id });
    const cookieOpts = getSessionCookieOptions(c.req.raw.headers);
    setCookie(c, Session.cookieName, token, {
      ...cookieOpts,
      maxAge: Session.maxAgeMs / 1000,
    });

    return c.redirect(st.next ?? "/dashboard", 302);
  } catch (err) {
    console.error("[OIDC] Callback failed", err);
    return c.json({ error: "OAuth callback failed" }, 500);
  }
}
