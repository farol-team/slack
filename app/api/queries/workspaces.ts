import { randomBytes } from "node:crypto";
import { workspaceMembers, workspaces } from "@db/schema";
import type { getDb } from "./connection";

type Db = ReturnType<typeof getDb>;

/** Create a workspace plus its owner member (with an OpenViking user key).
 *  Shared by `workspace.create` and the "Add to Slack" flow that provisions
 *  a workspace on first install. */
export async function createWorkspaceForUser(
  db: Db,
  userId: number,
  name: string
) {
  const ovAccountId = `ws_${randomBytes(6).toString("hex")}`;
  const [ws] = await db
    .insert(workspaces)
    .values({ ownerUserId: userId, name, ovAccountId })
    .returning();
  await db.insert(workspaceMembers).values({
    workspaceId: ws.id,
    userId,
    role: "owner",
    ovUserKey: `ovu_${randomBytes(16).toString("hex")}`,
  });
  return ws;
}
