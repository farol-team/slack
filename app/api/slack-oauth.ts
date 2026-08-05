import { randomBytes } from "node:crypto";
import { getDb } from "./queries/connection";
import { createWorkspaceForUser } from "./queries/workspaces";
import {
  channels,
  slackInstallations,
  slackOauthStates,
  users,
  workspaceMembers,
  workspaces,
} from "@db/schema";
import { and, eq, gt } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authedQuery, createRouter, publicQuery } from "./middleware";
import { requireInternal } from "./saas-router";
import { env } from "./lib/env";

const PUBLIC_URL = env.publicUrl;
const INTERNAL_SECRET = env.internalApiSecret;

export const SLACK_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "groups:history",
  "groups:read",
  // Marks the message that asked: 👀 while the runner works, ✅ when it lands.
  "reactions:write",
  // BYOA needs to know who mentioned the bot: the member link is matched by
  // email on first contact (`users_info`), and the history importer names
  // authors. Missing here, a fresh install cannot route a single mention.
  "users:read",
  "users:read.email",
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
  /** Build the "Add to Slack" authorize URL with a DB-backed state.
   *  Without a workspaceId the workspace is created on callback. */
  connectUrl: authedQuery
    .input(z.object({ workspaceId: z.number().optional() }))
    .mutation(async ({ ctx, input }) => {
      if (!env.slackClientId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "SLACK_CLIENT_ID is not configured on the server",
        });
      }
      if (input.workspaceId !== undefined) {
        await requireMembership(input.workspaceId, ctx.user.id);
      }
      const db = getDb();
      const state = randomBytes(24).toString("hex");
      await db.insert(slackOauthStates).values({
        state,
        kind: "install",
        workspaceId: input.workspaceId ?? null,
        userId: ctx.user.id,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });
      const url =
        "https://slack.com/oauth/v2/authorize" +
        `?client_id=${encodeURIComponent(env.slackClientId)}` +
        `&scope=${encodeURIComponent(SLACK_SCOPES)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri())}` +
        `&state=${state}`;
      return { url };
    }),

  /** INTERNAL for cloud: bot token by Slack team id.
   *  Guarded by a shared secret header. */
  installationByTeam: publicQuery
    .input(z.object({ teamId: z.string(), secret: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      requireInternal(ctx, input.secret);
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
        // Bolt needs it to recognise (and ignore) the bot's own messages.
        botUserId: inst.botUserId,
        // Names the runner turns into a directory a person recognises.
        teamName: inst.teamName,
        teamId: inst.teamId,
        ovAccountId: ws?.ovAccountId ?? "",
      };
    }),

  /** INTERNAL for cloud: resolve a Slack user to a member's memory
   *  identity (BYOA routing). Matches the stored slackUserId link first,
   *  else by email — and persists the link on first match. */
  memberByTeamUser: publicQuery
    .input(
      z.object({
        teamId: z.string(),
        slackUserId: z.string(),
        email: z.string().email().optional(),
        secret: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      requireInternal(ctx, input.secret);
      const db = getDb();
      const [ws] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.slackTeamId, input.teamId))
        .limit(1);
      if (!ws) throw new TRPCError({ code: "NOT_FOUND", message: "workspace" });

      const [linked] = await db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, ws.id),
            eq(workspaceMembers.slackUserId, input.slackUserId),
          ),
        )
        .limit(1);
      if (linked) {
        return { ovUserKey: linked.ovUserKey ?? "", memberId: linked.id };
      }

      if (!input.email) {
        throw new TRPCError({ code: "NOT_FOUND", message: "member" });
      }
      const [match] = await db
        .select({ member: workspaceMembers })
        .from(workspaceMembers)
        .innerJoin(users, eq(workspaceMembers.userId, users.id))
        .where(
          and(
            eq(workspaceMembers.workspaceId, ws.id),
            eq(users.email, input.email),
          ),
        )
        .limit(1);
      if (!match) throw new TRPCError({ code: "NOT_FOUND", message: "member" });
      await db
        .update(workspaceMembers)
        .set({ slackUserId: input.slackUserId })
        .where(eq(workspaceMembers.id, match.member.id));
      return { ovUserKey: match.member.ovUserKey ?? "", memberId: match.member.id };
    }),

  /** Import progress proxy: workspace -> cloud job status. */
  importStatus: authedQuery
    .input(z.object({ workspaceId: z.number() }))
    .query(async ({ ctx, input }) => {
      await requireMembership(input.workspaceId, ctx.user.id);
      const db = getDb();
      const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1);
      if (!ws?.slackTeamId) return { state: "not_connected" as const };
      const cloudUrl = env.farolCloudUrl;
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
        eq(slackOauthStates.kind, "install"),
        gt(slackOauthStates.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!st || !st.userId) {
    return { redirectTo: "/dashboard?slack=error&reason=state" };
  }
  await db.delete(slackOauthStates).where(eq(slackOauthStates.id, st.id));

  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.slackClientId,
      client_secret: env.slackClientSecret,
      code,
      redirect_uri: redirectUri(),
    }),
  });
  const data = (await res.json()) as SlackOauthResponse;
  if (!data.ok || !data.access_token || !data.team) {
    return { redirectTo: `/dashboard?slack=error&reason=${data.error ?? "unknown"}` };
  }

  // No workspace pre-selected: create one for the installing user,
  // named after the Slack team.
  let workspaceId = st.workspaceId;
  if (!workspaceId) {
    const ws = await createWorkspaceForUser(
      db,
      st.userId,
      data.team.name || "My workspace",
    );
    workspaceId = ws.id;
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
      workspaceId,
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
    .where(eq(workspaces.id, workspaceId));

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
              eq(channels.workspaceId, workspaceId),
              eq(channels.slackChannelId, ch.id),
            ),
          )
          .limit(1);
        if (!dup) {
          await db.insert(channels).values({
            workspaceId,
            slackChannelId: ch.id,
            name: ch.name,
          });
        }
      }
    }
  } catch {
    // channel sync is non-fatal
  }

  // Provision the OpenViking account, then kick off the historical
  // import in cloud (both fire-and-forget).
  const teamId = data.team.id;
  void triggerProvision(teamId).then(() => triggerHistoryImport(teamId));

  return { redirectTo: "/dashboard?slack=connected" };
}

/** Fire-and-forget: ask cloud to create the OV account for this team. */
export async function triggerProvision(teamId: string): Promise<void> {
  const cloudUrl = env.farolCloudUrl;
  if (!cloudUrl || !INTERNAL_SECRET) return;
  try {
    await fetch(`${cloudUrl}/internal/provision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": INTERNAL_SECRET,
      },
      body: JSON.stringify({ team_id: teamId }),
    });
  } catch {
    // provisioning is retried implicitly: the account is also created
    // lazily by trusted-mode writes; dashboard shows memory status
  }
}

/** Fire-and-forget: ask cloud to start the historical import. */
export async function triggerHistoryImport(teamId: string): Promise<void> {
  const cloudUrl = env.farolCloudUrl;
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
