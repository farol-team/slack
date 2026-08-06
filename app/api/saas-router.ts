import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./queries/connection";
import { createWorkspaceForUser } from "./queries/workspaces";
import {
  channels,
  chats,
  memoryFiles,
  runnerConnectCodes,
  runners,
  slackInstallations,
  turns,
  workspaceMembers,
  workspaces,
} from "@db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authedQuery, createRouter, publicQuery } from "./middleware";

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? "";

/** Resolve a workspace owned by (or shared with) the current user. */
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

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export const workspaceRouter = createRouter({
  list: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    return db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slackTeamId: workspaces.slackTeamId,
        slackTeamName: slackInstallations.teamName,
        ovAccountId: workspaces.ovAccountId,
        plan: workspaces.plan,
        storeFiles: workspaces.storeFiles,
        createdAt: workspaces.createdAt,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .leftJoin(
        slackInstallations,
        eq(slackInstallations.teamId, workspaces.slackTeamId),
      )
      .where(eq(workspaceMembers.userId, ctx.user.id));
  }),

  create: authedQuery
    .input(z.object({ name: z.string().min(2).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const ws = await createWorkspaceForUser(getDb(), ctx.user.id, input.name);
      return { id: ws.id, ovAccountId: ws.ovAccountId };
    }),

  overview: authedQuery
    .input(z.object({ workspaceId: z.number() }))
    .query(async ({ ctx, input }) => {
      await requireMembership(input.workspaceId, ctx.user.id);
      const db = getDb();
      const [ws] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, input.workspaceId))
        .limit(1);
      if (!ws) throw new TRPCError({ code: "NOT_FOUND" });
      let slackTeamName: string | null = null;
      if (ws.slackTeamId) {
        const [inst] = await db
          .select({ teamName: slackInstallations.teamName })
          .from(slackInstallations)
          .where(eq(slackInstallations.teamId, ws.slackTeamId))
          .limit(1);
        slackTeamName = inst?.teamName ?? null;
      }
      const runnerList = await db
        .select()
        .from(runners)
        .where(
          and(eq(runners.workspaceId, ws.id), isNull(runners.revokedAt)),
        );
      const channelList = await db
        .select()
        .from(channels)
        .where(eq(channels.workspaceId, ws.id));
      // The onboarding checklist only asks "has this workspace ever run a
      // turn" — one row answers it; the log itself lives on its own page.
      const [firstTurn] = await db
        .select({ id: turns.id })
        .from(turns)
        .where(eq(turns.workspaceId, ws.id))
        .limit(1);
      return {
        workspace: { ...ws, slackTeamName },
        runners: runnerList,
        channels: channelList,
        hasTurns: !!firstTurn,
      };
    }),

  /** The activity log: every turn this workspace ran, newest first.
   *  Lives on its own page — an overview that scrolls is not an overview,
   *  and this list is read when something went wrong or someone asks what
   *  the agent did, not on the way past. */
  turns: authedQuery
    .input(
      z.object({
        workspaceId: z.number(),
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      await requireMembership(input.workspaceId, ctx.user.id);
      const db = getDb();
      const rows = await db
        .select({
          id: turns.id,
          turnUuid: turns.turnUuid,
          prompt: turns.prompt,
          status: turns.status,
          error: turns.error,
          createdAt: turns.createdAt,
          finishedAt: turns.finishedAt,
          slackChannelId: chats.slackChannelId,
          threadTs: chats.threadTs,
          runnerLabel: runners.label,
        })
        .from(turns)
        .leftJoin(chats, eq(turns.chatId, chats.id))
        .leftJoin(runners, eq(turns.runnerId, runners.id))
        .where(eq(turns.workspaceId, input.workspaceId))
        .orderBy(desc(turns.createdAt))
        // One row past the page tells the caller there is a next one without
        // a second COUNT query over a table that only grows.
        .limit(input.limit + 1)
        .offset(input.offset);
      return {
        turns: rows.slice(0, input.limit),
        hasMore: rows.length > input.limit,
      };
    }),
});

// ---------------------------------------------------------------------------
// Runners (thin clients)
// ---------------------------------------------------------------------------

export const runnerRouter = createRouter({
  /** Issue a new runner token bound to the calling member (BYOA:
   *  their mentions run on this runner). The raw token is returned ONCE. */
  createToken: authedQuery
    .input(z.object({ workspaceId: z.number(), label: z.string().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const member = await requireMembership(input.workspaceId, ctx.user.id);
      const db = getDb();
      const token = `frl_${randomBytes(24).toString("hex")}`;
      const [r] = await db
        .insert(runners)
        .values({
          workspaceId: input.workspaceId,
          ownerMemberId: member.id,
          label: input.label,
          tokenHash: sha256(token),
        })
        .returning({ id: runners.id });
      return { id: r.id, token };
    }),

  /** Approve a runner-connect code from the browser handoff: issues a
   *  runner token for the caller's workspace and stashes the PLAINTEXT
   *  token on the connect code until the runner polls it once. */
  connectApprove: authedQuery
    .input(z.object({ code: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [row] = await db
        .select()
        .from(runnerConnectCodes)
        .where(eq(runnerConnectCodes.code, input.code))
        .limit(1);
      if (!row || row.expiresAt < new Date() || row.approvedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid or expired code",
        });
      }
      const [member] = await db
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, ctx.user.id))
        .limit(1);
      if (!member) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "no workspace" });
      }
      const token = `frl_${randomBytes(24).toString("hex")}`;
      const label = row.label ?? "desktop";
      // A machine reconnecting is the same runner, not another one: reuse its
      // row and rotate the token, or the list fills up with its own history.
      const [existing] = await db
        .select()
        .from(runners)
        .where(
          and(
            eq(runners.ownerMemberId, member.id),
            eq(runners.label, label),
            isNull(runners.revokedAt),
          ),
        )
        .limit(1);
      if (existing) {
        await db
          .update(runners)
          .set({ tokenHash: sha256(token) })
          .where(eq(runners.id, existing.id));
      } else {
        await db.insert(runners).values({
          workspaceId: member.workspaceId,
          ownerMemberId: member.id,
          label,
          tokenHash: sha256(token),
        });
      }
      await db
        .update(runnerConnectCodes)
        .set({
          token,
          userId: ctx.user.id,
          memberId: member.id,
          workspaceId: member.workspaceId,
          approvedAt: new Date(),
        })
        .where(eq(runnerConnectCodes.id, row.id));
      return { ok: true };
    }),

  list: authedQuery
    .input(z.object({ workspaceId: z.number() }))
    .query(async ({ ctx, input }) => {
      await requireMembership(input.workspaceId, ctx.user.id);
      const db = getDb();
      return db
        .select({
          id: runners.id,
          label: runners.label,
          agents: runners.agents,
          version: runners.version,
          lastSeenAt: runners.lastSeenAt,
          createdAt: runners.createdAt,
        })
        .from(runners)
        .where(and(eq(runners.workspaceId, input.workspaceId), isNull(runners.revokedAt)));
    }),

  revoke: authedQuery
    .input(z.object({ runnerId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [r] = await db.select().from(runners).where(eq(runners.id, input.runnerId)).limit(1);
      if (!r) throw new TRPCError({ code: "NOT_FOUND" });
      await requireMembership(r.workspaceId, ctx.user.id);
      await db.update(runners).set({ revokedAt: new Date() }).where(eq(runners.id, r.id));
      return { ok: true };
    }),

  /** INTERNAL: cloud reports runner liveness (throttled heartbeat). */
  touch: publicQuery
    .input(z.object({ runnerId: z.number(), secret: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      requireInternal(ctx, input.secret);
      const db = getDb();
      await db
        .update(runners)
        .set({ lastSeenAt: new Date() })
        .where(eq(runners.id, input.runnerId));
      return { ok: true };
    }),

  /** INTERNAL: cloud validates a runner token against this endpoint.
   *  Returns the OWNER member's memory identity — the cloud routes a
   *  mention to the runner whose owner matches the mention author. */
  validate: publicQuery
    .input(
      z.object({
        token: z.string(),
        // What the runner announced in `hello`. Without these the dashboard
        // has nothing to show but a dash.
        agents: z.array(z.string()).optional(),
        version: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      const db = getDb();
      const [r] = await db
        .select()
        .from(runners)
        .where(eq(runners.tokenHash, sha256(input.token)))
        .limit(1);
      if (!r || r.revokedAt) return { valid: false as const };
      const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, r.workspaceId)).limit(1);
      const [owner] = await db
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.id, r.ownerMemberId))
        .limit(1);
      if (!ws || !owner) return { valid: false as const };
      await db
        .update(runners)
        .set({
          lastSeenAt: new Date(),
          ...(input.agents ? { agents: input.agents } : {}),
          ...(input.version ? { version: input.version } : {}),
        })
        .where(eq(runners.id, r.id));
      return {
        valid: true as const,
        workspaceId: ws.ovAccountId,
        userKey: owner.ovUserKey ?? "",
        runnerId: r.id,
      };
    }),
});

// ---------------------------------------------------------------------------
// Chat mirror (INTERNAL: cloud -> SaaS persistence of chats and turns)
// ---------------------------------------------------------------------------

/** Yandex serverless ingress strips custom request headers, so internal
 *  calls carry the shared secret in the payload; the header is still
 *  accepted as an alternative for local/dev curl convenience. */
export function requireInternal(
  ctx: { req: { headers: Headers } },
  provided?: string,
) {
  const header = ctx.req.headers.get("x-internal-secret") ?? "";
  const ok =
    INTERNAL_SECRET &&
    (provided === INTERNAL_SECRET || header === INTERNAL_SECRET);
  if (!ok) throw new TRPCError({ code: "UNAUTHORIZED" });
}

export const chatSyncRouter = createRouter({
  /** Chat opened in the cloud: persist its identity and bindings. */
  upsert: publicQuery
    .input(
      z.object({
        chatUuid: z.string(),
        ovAccountId: z.string(),
        ownerUserKey: z.string(),
        slackChannelId: z.string(),
        threadTs: z.string(),
        secret: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireInternal(ctx, input.secret);
      const db = getDb();
      const [ws] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.ovAccountId, input.ovAccountId))
        .limit(1);
      if (!ws) throw new TRPCError({ code: "NOT_FOUND", message: "workspace" });
      const [owner] = await db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, ws.id),
            eq(workspaceMembers.ovUserKey, input.ownerUserKey),
          ),
        )
        .limit(1);
      const [existing] = await db
        .select()
        .from(chats)
        .where(eq(chats.chatUuid, input.chatUuid))
        .limit(1);
      if (!existing) {
        await db.insert(chats).values({
          chatUuid: input.chatUuid,
          workspaceId: ws.id,
          ownerMemberId: owner?.id,
          slackChannelId: input.slackChannelId,
          threadTs: input.threadTs,
        });
      }
      return { ok: true };
    }),

  /** Turn lifecycle: `running` inserts the turn, terminal states close it
   *  and fold the session id into the chat. */
  turn: publicQuery
    .input(
      z.object({
        chatUuid: z.string(),
        turnUuid: z.string(),
        status: z.enum(["running", "done", "failed", "cancelled", "orphaned"]),
        prompt: z.string().optional(),
        runnerId: z.number().optional(),
        acpSessionId: z.string().optional(),
        error: z.string().optional(),
        secret: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireInternal(ctx, input.secret);
      const db = getDb();
      const [chat] = await db
        .select()
        .from(chats)
        .where(eq(chats.chatUuid, input.chatUuid))
        .limit(1);
      if (!chat) throw new TRPCError({ code: "NOT_FOUND", message: "chat" });
      if (input.status === "running") {
        await db.insert(turns).values({
          turnUuid: input.turnUuid,
          chatId: chat.id,
          workspaceId: chat.workspaceId,
          runnerId: input.runnerId || null,
          prompt: input.prompt ?? "",
        });
        await db.update(chats).set({ status: "running" }).where(eq(chats.id, chat.id));
      } else {
        await db
          .update(turns)
          .set({
            status: input.status,
            error: input.error ?? null,
            finishedAt: new Date(),
          })
          .where(eq(turns.turnUuid, input.turnUuid));
        await db
          .update(chats)
          .set({
            status: "idle",
            ...(input.acpSessionId ? { acpSessionId: input.acpSessionId } : {}),
          })
          .where(eq(chats.id, chat.id));
      }
      return { ok: true };
    }),
});

// ---------------------------------------------------------------------------
// Memory browser (proxy to OpenViking)
// ---------------------------------------------------------------------------

/** All OV access goes through the cloud's internal API — the SaaS has
 *  no direct OpenViking route. */
async function cloudMemoryFetch(path: string, body: unknown) {
  const cloudUrl = (process.env.FAROL_CLOUD_URL ?? "").replace(/\/$/, "");
  if (!cloudUrl || !INTERNAL_SECRET)
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "cloud not configured" });
  const res = await fetch(`${cloudUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": INTERNAL_SECRET,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new TRPCError({ code: "BAD_GATEWAY", message: `cloud ${res.status}` });
  return res.json();
}

export type MemoryStats = {
  channels: {
    channelId: string;
    files: number;
    bytes: number;
    lastModified: string | null;
  }[];
  totalFiles: number;
  totalBytes: number;
  lastModified: string | null;
  /** Files shared in Slack and read into memory. Counted here rather than
   *  in OpenViking, which lists an imported resource as a 0-byte directory. */
  sharedFiles: { count: number; bytes: number };
};

export const memoryRouter = createRouter({
  /** Aggregated Slack-memory stats, proxied from the cloud (which owns
   *  OpenViking access; the SaaS has no direct OV route). */
  stats: authedQuery
    .input(z.object({ workspaceId: z.number() }))
    .query(async ({ ctx, input }): Promise<MemoryStats | null> => {
      await requireMembership(input.workspaceId, ctx.user.id);
      const db = getDb();
      const [ws] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, input.workspaceId))
        .limit(1);
      if (!ws?.slackTeamId) return null;
      const fileRows = await db
        .select({ bytes: memoryFiles.bytes })
        .from(memoryFiles)
        .where(eq(memoryFiles.workspaceId, ws.id));
      const fileStats = {
        count: fileRows.length,
        bytes: fileRows.reduce((sum, r) => sum + (r.bytes ?? 0), 0),
      };
      const cloudUrl = (process.env.FAROL_CLOUD_URL ?? "").replace(/\/$/, "");
      if (!cloudUrl || !INTERNAL_SECRET) return null;
      try {
        const res = await fetch(`${cloudUrl}/internal/memory/stats`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-secret": INTERNAL_SECRET,
          },
          body: JSON.stringify({ team_id: ws.slackTeamId }),
        });
        if (!res.ok) return null;
        const cloud = (await res.json()) as Omit<MemoryStats, "sharedFiles">;
        return { ...cloud, sharedFiles: fileStats };
      } catch {
        return null;
      }
    }),

  search: authedQuery
    .input(z.object({ workspaceId: z.number(), query: z.string().min(1), scope: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      await requireMembership(input.workspaceId, ctx.user.id);
      const db = getDb();
      const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1);
      if (!ws?.slackTeamId) throw new TRPCError({ code: "NOT_FOUND" });
      const data = (await cloudMemoryFetch("/internal/memory/search", {
        team_id: ws.slackTeamId,
        query: input.query,
        scope: input.scope,
      })) as { results?: unknown[] };
      return { results: data.results ?? [] };
    }),

  status: authedQuery
    .input(z.object({ workspaceId: z.number() }))
    .query(async ({ ctx, input }) => {
      await requireMembership(input.workspaceId, ctx.user.id);
      try {
        const data = (await cloudMemoryFetch("/internal/memory/status", {})) as {
          online?: boolean;
        };
        return { configured: true, online: data.online === true };
      } catch {
        return { configured: false, online: false };
      }
    }),
});

// ---------------------------------------------------------------------------
// Billing (stub: plan lives on the workspace)
// ---------------------------------------------------------------------------

export const billingRouter = createRouter({
  setPlan: authedQuery
    .input(z.object({ workspaceId: z.number(), plan: z.enum(["free", "team", "enterprise"]) }))
    .mutation(async ({ ctx, input }) => {
      const m = await requireMembership(input.workspaceId, ctx.user.id);
      if (m.role !== "owner") throw new TRPCError({ code: "FORBIDDEN", message: "Owners only" });
      const db = getDb();
      await db.update(workspaces).set({ plan: input.plan }).where(eq(workspaces.id, input.workspaceId));
      return { ok: true };
    }),

  /** INTERNAL: the cloud imported a shared file into team memory. */
  fileImported: publicQuery
    .input(
      z.object({
        ovAccountId: z.string(),
        slackChannelId: z.string(),
        slackFileId: z.string(),
        name: z.string(),
        mime: z.string().optional(),
        bytes: z.number().int().nonnegative().default(0),
        uri: z.string(),
        secret: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireInternal(ctx, input.secret);
      const db = getDb();
      const [ws] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.ovAccountId, input.ovAccountId))
        .limit(1);
      if (!ws) throw new TRPCError({ code: "NOT_FOUND", message: "workspace" });
      await db
        .insert(memoryFiles)
        .values({
          workspaceId: ws.id,
          slackChannelId: input.slackChannelId,
          slackFileId: input.slackFileId,
          name: input.name,
          mime: input.mime ?? null,
          bytes: input.bytes,
          uri: input.uri,
        })
        .onConflictDoUpdate({
          target: memoryFiles.slackFileId,
          set: { uri: input.uri, bytes: input.bytes, name: input.name },
        });
      return { ok: true };
    }),

  /** INTERNAL: Slack deleted a file — hand back where its copy lives so the
   *  cloud can remove it, and forget the record. */
  fileDeleted: publicQuery
    .input(z.object({ slackFileId: z.string(), secret: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      requireInternal(ctx, input.secret);
      const db = getDb();
      const [row] = await db
        .select()
        .from(memoryFiles)
        .where(eq(memoryFiles.slackFileId, input.slackFileId))
        .limit(1);
      if (!row) return { uri: null };
      await db.delete(memoryFiles).where(eq(memoryFiles.id, row.id));
      return { uri: row.uri };
    }),

  /** Whether files shared in Slack are copied into team memory. A policy
   *  decision, so it is the owner's to make. */
  setStoreFiles: authedQuery
    .input(z.object({ workspaceId: z.number(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const m = await requireMembership(input.workspaceId, ctx.user.id);
      if (m.role !== "owner") throw new TRPCError({ code: "FORBIDDEN", message: "Owners only" });
      await getDb()
        .update(workspaces)
        .set({ storeFiles: input.enabled })
        .where(eq(workspaces.id, input.workspaceId));
      return { ok: true };
    }),
});
