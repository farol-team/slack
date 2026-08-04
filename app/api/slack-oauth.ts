import { randomBytes } from "node:crypto";
import { getDb } from "./queries/connection";
import {
  channels,
  slackInstallations,
  slackOauthStates,
  workspaceMembers,
  workspaces,
} from "@db/schema";
import { and, eq, gt } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authedQuery, createRouter, publicQuery } from "./middleware";

const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID ?? "";
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET ?? "";
const PUBLIC_URL = (process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "");
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? "";

export const SLACK_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "groups:history",
  "groups:read",
].join(",");

const redirectUri = () => `${PUBLIC_URL}/api/slack/callback`;

async function requireMembership(workspaceId: number, userId: number) {
  const db = getDb();
  const [m] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1);
  if (!m) throw new TRPCError({ code: "FORBIDDEN", message: "Not a member" });
  return m;
}

export const slackRouter = createRouter({
  /** Build the "Add to Slack" authorize URL with a DB-backed state. */
  connectUrl: authedQuery
    .input(z.object({ workspaceId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!SLACK_CLIENT_ID) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "SLACK_CLIENT_ID не настроен на сервере",
        });
      }
      await requireMembership(input.workspaceId, ctx.user.id);
      const db = getDb();
      const state = randomBytes(24).toString("hex");
      await db.insert(slackOauthStates).values({
        state,
        workspaceId: input.workspaceId,
        userId: ctx.user.id,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });
      const url =
        "https://slack.com/oauth/v2/authorize" +
        `?client_id=${encodeURIComponent(SLACK_CLIENT_ID)}` +
        `&scope=${encodeURIComponent(SLACK_SCOPES)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri())}` +
        `&state=${state}`;
      return { url };
    }),

  /** INTERNAL for ov-cloud: bot token by Slack team id.
   *  Guarded by a shared secret header. */
  installationByTeam: publicQuery
    .input(z.object({ teamId: z.string() }))
    .query(async ({ ctx, input }) => {
      const secret = ctx.req.headers.get("x-internal-secret") ?? "";
      if (!INTERNAL_SECRET || secret !== INTERNAL_SECRET) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      const db = getDb();
      const [inst] = await db
        .select()
        .from(slackInstallations)
        .where(eq(slackInstallations.teamId, input.teamId))
        .limit(1);
      if (!inst) throw new TRPCError({ code: "NOT_FOUND" });
      const [ws] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, inst.workspaceId))
        .limit(1);
      return {
        botToken: inst.botToken,
        teamId: inst.teamId,
        ovAccountId: ws?.ovAccountId ?? "",
      };
    }),

  /** Import progress proxy: workspace -> ov-cloud job status. */
  importStatus: authedQuery
    .input(z.object({ workspaceId: z.number() }))
    .query(async ({ ctx, input }) => {
      await requireMembership(input.workspaceId, ctx.user.id);
      const db = getDb();
      const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1);
      if (!ws?.slackTeamId) return { state: "not_connected" as const };
      const cloudUrl = (process.env.OV_CLOUD_URL ?? "").replace(/\/$/, "");
      if (!cloudUrl || !INTERNAL_SECRET) return { state: "unavailable" as const };
      try {
        const res = await fetch(`${cloudUrl}/internal/import/${ws.slackTeamId}/status`, {
          headers: { "x-internal-secret": INTERNAL_SECRET },
        });
        if (res.status === 404) return { state: "not_started" as const };
        if (!res.ok) return { state: "unavailable" as const };
        return (await res.json()) as Record<string, unknown>;
      } catch {
        return { state: "unavailable" as const };
      }
    }),
});

// ---------------------------------------------------------------------------
// OAuth callback (plain HTTP, registered in boot.ts)
// ---------------------------------------------------------------------------

type SlackOauthResponse = {
  ok: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  team?: { id: string; name: string };
};

export async function handleSlackCallback(
  code: string,
  state: string,
): Promise<{ redirectTo: string }> {
  const db = getDb();

  const [st] = await db
    .select()
    .from(slackOauthStates)
    .where(
      and(
        eq(slackOauthStates.state, state),
        gt(slackOauthStates.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!st) {
    return { redirectTo: "/dashboard?slack=error&reason=state" };
  }
  await db.delete(slackOauthStates).where(eq(slackOauthStates.id, st.id));

  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri(),
    }),
  });
  const data = (await res.json()) as SlackOauthResponse;
  if (!data.ok || !data.access_token || !data.team) {
    return { redirectTo: `/dashboard?slack=error&reason=${data.error ?? "unknown"}` };
  }

  // Upsert installation + link workspace.
  const [existing] = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, data.team.id))
    .limit(1);
  if (existing) {
    await db
      .update(slackInstallations)
      .set({
        botToken: data.access_token,
        botUserId: data.bot_user_id,
        scopes: data.scope,
        teamName: data.team.name,
      })
      .where(eq(slackInstallations.id, existing.id));
  } else {
    await db.insert(slackInstallations).values({
      workspaceId: st.workspaceId,
      teamId: data.team.id,
      teamName: data.team.name,
      botUserId: data.bot_user_id ?? null,
      botToken: data.access_token,
      scopes: data.scope,
      installedByUserId: st.userId,
    });
  }
  await db
    .update(workspaces)
    .set({ slackTeamId: data.team.id })
    .where(eq(workspaces.id, st.workspaceId));

  // Best-effort channel sync (bot sees only channels it's a member of).
  try {
    const chRes = await fetch(
      "https://slack.com/api/conversations.list?limit=200&types=public_channel,private_channel",
      { headers: { Authorization: `Bearer ${data.access_token}` } },
    );
    const chData = (await chRes.json()) as {
      ok: boolean;
      channels?: { id: string; name: string; is_member?: boolean }[];
    };
    if (chData.ok && chData.channels) {
      for (const ch of chData.channels.filter((c) => c.is_member)) {
        const [dup] = await db
          .select()
          .from(channels)
          .where(
            and(
              eq(channels.workspaceId, st.workspaceId),
              eq(channels.slackChannelId, ch.id),
            ),
          )
          .limit(1);
        if (!dup) {
          await db.insert(channels).values({
            workspaceId: st.workspaceId,
            slackChannelId: ch.id,
            name: ch.name,
          });
        }
      }
    }
  } catch {
    // channel sync is non-fatal
  }

  // Kick off the historical import in ov-cloud (fire-and-forget).
  void triggerHistoryImport(data.team.id);

  return { redirectTo: "/dashboard?slack=connected" };
}

/** Fire-and-forget: ask ov-cloud to start the historical import. */
export async function triggerHistoryImport(teamId: string): Promise<void> {
  const cloudUrl = (process.env.OV_CLOUD_URL ?? "").replace(/\/$/, "");
  if (!cloudUrl || !INTERNAL_SECRET) return;
  try {
    await fetch(`${cloudUrl}/internal/import/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": INTERNAL_SECRET,
      },
      body: JSON.stringify({ team_id: teamId }),
    });
  } catch {
    // import is best-effort; user can see status in the dashboard
  }
}
