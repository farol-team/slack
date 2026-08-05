import type { Context } from "hono";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { runnerConnectCodes, workspaces } from "@db/schema";
import { env } from "./lib/env";
import { getDb } from "./queries/connection";

const CODE_TTL_MS = 10 * 60 * 1000;

/** POST /api/runner/connect/start — public. The desktop runner opens the
 *  returned url in a browser and starts polling /api/runner/connect/poll. */
export async function handleConnectStart(c: Context) {
  let label: string | null = null;
  try {
    const body: unknown = await c.req.json();
    if (
      body &&
      typeof body === "object" &&
      typeof (body as { label?: unknown }).label === "string"
    ) {
      label = ((body as { label: string }).label || "").slice(0, 255) || null;
    }
  } catch {
    // Empty or non-JSON body is fine — label stays null.
  }

  const code = randomBytes(16).toString("hex");
  await getDb()
    .insert(runnerConnectCodes)
    .values({ code, label, expiresAt: new Date(Date.now() + CODE_TTL_MS) });

  return c.json({
    code,
    url: `${env.publicUrl}/runner/connect?code=${code}`,
  });
}

/** GET /api/runner/connect/poll?code= — public. On the first poll after
 *  approval the plaintext token is returned and erased from the DB;
 *  repeat polls report "approved" without the token. */
export async function handleConnectPoll(c: Context) {
  const code = c.req.query("code") ?? "";
  if (!code) {
    return c.json({ status: "expired" }, 404);
  }
  const db = getDb();
  const [row] = await db
    .select()
    .from(runnerConnectCodes)
    .where(eq(runnerConnectCodes.code, code))
    .limit(1);
  if (!row || row.expiresAt < new Date()) {
    return c.json({ status: "expired" }, 404);
  }

  if (row.token) {
    let workspaceId = "";
    if (row.workspaceId) {
      const [ws] = await db
        .select({ ovAccountId: workspaces.ovAccountId })
        .from(workspaces)
        .where(eq(workspaces.id, row.workspaceId))
        .limit(1);
      workspaceId = ws?.ovAccountId ?? String(row.workspaceId);
    }
    await db
      .update(runnerConnectCodes)
      .set({ token: null })
      .where(eq(runnerConnectCodes.id, row.id));
    return c.json({ status: "approved", token: row.token, workspaceId });
  }
  if (row.approvedAt) {
    return c.json({ status: "approved" });
  }
  // The label lets the approval page show "Authorize runner <label>?".
  return c.json({ status: "pending", label: row.label });
}
