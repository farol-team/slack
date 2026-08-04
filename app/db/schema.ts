import {
  mysqlTable,
  mysqlEnum,
  serial,
  varchar,
  text,
  timestamp,
  bigint,
  boolean,
  json,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: serial("id").primaryKey(),
  unionId: varchar("unionId", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 320 }),
  avatar: text("avatar"),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
  lastSignInAt: timestamp("lastSignInAt").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ---------- SaaS domain: Slack workspace = OpenViking account ----------

export const workspaces = mysqlTable("workspaces", {
  id: serial("id").primaryKey(),
  ownerUserId: bigint("ownerUserId", { mode: "number", unsigned: true })
    .notNull()
    .references(() => users.id),
  name: varchar("name", { length: 255 }).notNull(),
  /** Slack team id once the Slack app is installed (OAuth). */
  slackTeamId: varchar("slackTeamId", { length: 64 }).unique(),
  /** OpenViking account id (= tenant boundary). */
  ovAccountId: varchar("ovAccountId", { length: 64 }).notNull().unique(),
  plan: mysqlEnum("plan", ["free", "team", "enterprise"])
    .default("free")
    .notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Workspace = typeof workspaces.$inferSelect;

export const workspaceMembers = mysqlTable("workspace_members", {
  id: serial("id").primaryKey(),
  workspaceId: bigint("workspaceId", { mode: "number", unsigned: true })
    .notNull()
    .references(() => workspaces.id),
  userId: bigint("userId", { mode: "number", unsigned: true })
    .notNull()
    .references(() => users.id),
  /** OpenViking user key issued for this member (memory identity). */
  ovUserKey: varchar("ovUserKey", { length: 128 }),
  role: mysqlEnum("role", ["owner", "admin", "member"])
    .default("member")
    .notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;

export const runners = mysqlTable("runners", {
  id: serial("id").primaryKey(),
  workspaceId: bigint("workspaceId", { mode: "number", unsigned: true })
    .notNull()
    .references(() => workspaces.id),
  label: varchar("label", { length: 255 }).notNull(),
  /** SHA-256 of the issued `ovr_...` token — the token itself is never stored. */
  tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(),
  agents: json("agents").$type<string[]>(),
  version: varchar("version", { length: 32 }),
  lastSeenAt: timestamp("lastSeenAt"),
  revokedAt: timestamp("revokedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Runner = typeof runners.$inferSelect;

export const channels = mysqlTable("channels", {
  id: serial("id").primaryKey(),
  workspaceId: bigint("workspaceId", { mode: "number", unsigned: true })
    .notNull()
    .references(() => workspaces.id),
  slackChannelId: varchar("slackChannelId", { length: 64 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  ingestEnabled: boolean("ingestEnabled").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Channel = typeof channels.$inferSelect;

export const tasks = mysqlTable("tasks", {
  id: serial("id").primaryKey(),
  workspaceId: bigint("workspaceId", { mode: "number", unsigned: true })
    .notNull()
    .references(() => workspaces.id),
  runnerId: bigint("runnerId", { mode: "number", unsigned: true })
    .references(() => runners.id),
  slackChannelId: varchar("slackChannelId", { length: 64 }).notNull(),
  threadTs: varchar("threadTs", { length: 32 }).notNull(),
  prompt: text("prompt").notNull(),
  status: mysqlEnum("status", ["running", "done", "failed", "cancelled"])
    .default("running")
    .notNull(),
  acpSessionId: varchar("acpSessionId", { length: 128 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  finishedAt: timestamp("finishedAt"),
});
export type Task = typeof tasks.$inferSelect;

export const slackInstallations = mysqlTable("slack_installations", {
  id: serial("id").primaryKey(),
  workspaceId: bigint("workspaceId", { mode: "number", unsigned: true })
    .notNull()
    .references(() => workspaces.id),
  teamId: varchar("teamId", { length: 64 }).notNull().unique(),
  teamName: varchar("teamName", { length: 255 }),
  botUserId: varchar("botUserId", { length: 64 }),
  /** Bot access token (xoxb-...). Production: encrypt at rest (KMS). */
  botToken: text("botToken").notNull(),
  scopes: varchar("scopes", { length: 512 }),
  installedByUserId: bigint("installedByUserId", {
    mode: "number",
    unsigned: true,
  }).references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});
export type SlackInstallation = typeof slackInstallations.$inferSelect;

/** One-time OAuth state tokens (CSRF protection for the Slack flow). */
export const slackOauthStates = mysqlTable("slack_oauth_states", {
  id: serial("id").primaryKey(),
  state: varchar("state", { length: 64 }).notNull().unique(),
  workspaceId: bigint("workspaceId", { mode: "number", unsigned: true })
    .notNull()
    .references(() => workspaces.id),
  userId: bigint("userId", { mode: "number", unsigned: true })
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type SlackOauthState = typeof slackOauthStates.$inferSelect;

// TODO: Add your tables here. See docs/Database.md for schema examples and patterns.
//
// Example:
// export const posts = mysqlTable("posts", {
//   id: serial("id").primaryKey(),
//   title: varchar("title", { length: 255 }).notNull(),
//   content: text("content"),
//   createdAt: timestamp("created_at").notNull().defaultNow(),
// });
//
// Note: FK columns referencing a serial() PK must use:
//   bigint("columnName", { mode: "number", unsigned: true }).notNull()
