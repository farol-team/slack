import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./queries/connection";
import {
  channels,
  chats,
  runners,
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
        ovAccountId: workspaces.ovAccountId,
        plan: workspaces.plan,
        createdAt: workspaces.createdAt,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(eq(workspaceMembers.userId, ctx.user.id));
  }),

  create: authedQuery
    .input(z.object({ name: z.string().min(2).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const ovAccountId = `ws_${randomBytes(6).toString("hex")}`;
      const [ws] = await db
        .insert(workspaces)
        .values({ ownerUserId: ctx.user.id, name: input.name, ovAccountId })
        .returning({ id: workspaces.id });
      await db.insert(workspaceMembers).values({
        workspaceId: ws.id,
        userId: ctx.user.id,
        role: "owner",
        ovUserKey: `ovu_${randomBytes(16).toString("hex")}`,
      });
      return { id: ws.id, ovAccountId };
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
      const recentTurns = await db
        .select()
        .from(turns)
        .where(eq(turns.workspaceId, ws.id))
        .orderBy(desc(turns.createdAt))
        .limit(10);
      return { workspace: ws, runners: runnerList, channels: channelList, recentTurns };
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
    .input(z.object({ runnerId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const secret = ctx.req.headers.get("x-internal-secret") ?? "";
      if (!INTERNAL_SECRET || secret !== INTERNAL_SECRET) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
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
    .input(z.object({ token: z.string() }))
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
      await db.update(runners).set({ lastSeenAt: new Date() }).where(eq(runners.id, r.id));
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

function requireInternalHeader(ctx: { req: { headers: Headers } }) {
  const secret = ctx.req.headers.get("x-internal-secret") ?? "";
  if (!INTERNAL_SECRET || secret !== INTERNAL_SECRET) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
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
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireInternalHeader(ctx);
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
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireInternalHeader(ctx);
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

const OV_URL = process.env.OPENVIKING_URL ?? "";
const OV_ROOT_KEY = process.env.OPENVIKING_ROOT_KEY ?? "";

async function ovFetch(path: string, body: unknown, account?: string) {
  if (!OV_URL) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "OpenViking not configured" });
  // Trusted mode: identity travels in headers, root key authorizes us
  // as the identity-injecting upstream.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": OV_ROOT_KEY,
  };
  if (account) {
    headers["X-OpenViking-Account"] = account;
    headers["X-OpenViking-User"] = "farol-dashboard";
  }
  const res = await fetch(`${OV_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new TRPCError({ code: "BAD_GATEWAY", message: `OpenViking ${res.status}` });
  return res.json();
}

export const memoryRouter = createRouter({
  search: authedQuery
    .input(z.object({ workspaceId: z.number(), query: z.string().min(1), scope: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      await requireMembership(input.workspaceId, ctx.user.id);
      const db = getDb();
      const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1);
      if (!ws) throw new TRPCError({ code: "NOT_FOUND" });
      const data = (await ovFetch(
        "/api/v1/search/find",
        {
          query: input.query,
          target_uri: input.scope ?? "viking://resources/",
          limit: 10,
        },
        ws.ovAccountId,
      )) as { results?: unknown[] };
      return { results: data.results ?? [] };
    }),

  status: authedQuery
    .input(z.object({ workspaceId: z.number() }))
    .query(async ({ ctx, input }) => {
      await requireMembership(input.workspaceId, ctx.user.id);
      if (!OV_URL) return { configured: false, online: false };
      try {
        const res = await fetch(`${OV_URL}/api/v1/status`, {
          headers: { "X-API-Key": OV_ROOT_KEY },
        });
        return { configured: true, online: res.ok };
      } catch {
        return { configured: true, online: false };
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
});
