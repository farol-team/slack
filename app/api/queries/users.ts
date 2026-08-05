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

/** Insert or refresh a user by (provider, subject), falling back to the email
 *  so one person stays one account. Emails listed in OWNER_EMAILS are promoted
 *  to role "admin" on every sign-in. */
export async function upsertUser(data: UpsertUserData) {
  const isOwner =
    !!data.email && env.ownerEmails.includes(data.email.toLowerCase());
  const rolePatch = isOwner ? ({ role: "admin" } as const) : {};

  // A row seeded without a subject never conflicts on (provider, subject) —
  // NULL is not equal to NULL — so signing in would mint a second account for
  // the same person, owning none of their runners. Claim the row by email
  // instead; the providers we accept verify it.
  if (data.email) {
    const [existing] = await getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, data.email))
      .limit(1);
    if (existing) {
      const [updated] = await getDb()
        .update(schema.users)
        .set({
          provider: data.provider,
          subject: data.subject,
          name: data.name ?? existing.name,
          avatar: data.avatar ?? existing.avatar,
          lastSignInAt: new Date(),
          ...rolePatch,
        })
        .where(eq(schema.users.id, existing.id))
        .returning();
      return updated;
    }
  }

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
