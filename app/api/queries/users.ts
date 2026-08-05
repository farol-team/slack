import { and, eq } from "drizzle-orm";
import * as schema from "@db/schema";
import { getDb } from "./connection";
import { env } from "../lib/env";

export async function findUserById(id: number) {
  const rows = await getDb()
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .limit(1);
  return rows.at(0);
}

export async function findUserByProviderSubject(
  provider: string,
  subject: string
) {
  const rows = await getDb()
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.provider, provider),
        eq(schema.users.subject, subject)
      )
    )
    .limit(1);
  return rows.at(0);
}

export type UpsertUserData = {
  provider: string;
  subject: string;
  email?: string | null;
  name?: string | null;
  avatar?: string | null;
};

/** Insert or refresh a user by (provider, subject). Emails listed in
 *  OWNER_EMAILS are promoted to role "admin" on every sign-in. */
export async function upsertUser(data: UpsertUserData) {
  const isOwner =
    !!data.email && env.ownerEmails.includes(data.email.toLowerCase());
  const rolePatch = isOwner ? ({ role: "admin" } as const) : {};

  const [user] = await getDb()
    .insert(schema.users)
    .values({
      provider: data.provider,
      subject: data.subject,
      email: data.email ?? null,
      name: data.name ?? null,
      avatar: data.avatar ?? null,
      lastSignInAt: new Date(),
      ...rolePatch,
    })
    .onConflictDoUpdate({
      target: [schema.users.provider, schema.users.subject],
      set: {
        email: data.email ?? null,
        name: data.name ?? null,
        avatar: data.avatar ?? null,
        lastSignInAt: new Date(),
        ...rolePatch,
      },
    })
    .returning();
  return user;
}
