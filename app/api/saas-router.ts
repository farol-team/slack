import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./queries/connection";
import {
  channels,
  runners,
  tasks,
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
        .$returningId();
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
      const recentTasks = await db
        .select()
        .from(tasks)
        .where(eq(tasks.workspaceId, ws.id))
        .orderBy(desc(tasks.createdAt))
        .limit(10);
      return { workspace: ws, runners: runnerList, channels: channelList, recentTasks };
    }),
});

// ---------------------------------------------------------------------------
// Runners (thin clients)
// ---------------------------------------------------------------------------

export const runnerRouter = createRouter({
  /** Issue a new runner token. The raw token is returned ONCE. */
  createToken: authedQuery
    .input(z.object({ workspaceId: z.number(), label: z.string().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      await requireMembership(input.workspaceId, ctx.user.id);
      const db = getDb();
      const token = `frl_${randomBytes(24).toString("hex")}`;
      const [r] = await db
        .insert(runners)
        .values({
          workspaceId: input.workspaceId,
          label: input.label,
          tokenHash: sha256(token),
        })
        .$returningId();
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

  /** INTERNAL: cloud validates a runner token against this endpoint. */
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
      const [member] = await db
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, r.workspaceId))
        .limit(1);
      await db.update(runners).set({ lastSeenAt: new Date() }).where(eq(runners.id, r.id));
      return {
        valid: true as const,
        workspaceId: ws?.ovAccountId ?? "",
        userKey: member?.ovUserKey ?? "",
        runnerId: r.id,
      };
    }),
});

// ---------------------------------------------------------------------------
// Memory browser (proxy to OpenViking)
// ---------------------------------------------------------------------------

const OV_URL = process.env.OPENVIKING_URL ?? "";
const OV_ROOT_KEY = process.env.OPENVIKING_ROOT_KEY ?? "";

async function ovFetch(path: string, body: unknown) {
  if (!OV_URL) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "OpenViking not configured" });
  const res = await fetch(`${OV_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": OV_ROOT_KEY },
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
      const data = (await ovFetch("/api/v1/search/find", {
        account_id: ws.ovAccountId,
        query: input.query,
        target_uri: input.scope ?? `/${ws.ovAccountId}/resources/`,
        limit: 10,
      })) as { results?: unknown[] };
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
