import {
  pgTable,
  pgEnum,
  serial,
  integer,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["user", "admin"]);
export const workspacePlan = pgEnum("workspace_plan", ["free", "team", "enterprise"]);
export const memberRole = pgEnum("member_role", ["owner", "admin", "member"]);
export const chatStatus = pgEnum("chat_status", ["idle", "running"]);
export const turnStatus = pgEnum("turn_status", [
  "running",
  "done",
  "failed",
  "cancelled",
  "orphaned",
]);

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    /** Identity provider that issued `subject` (e.g. "slack"). */
    provider: varchar("provider", { length: 32 }).notNull().default("slack"),
    /** Provider-scoped user id (OIDC `sub`). */
    subject: varchar("subject", { length: 255 }),
    name: varchar("name", { length: 255 }),
    email: varchar("email", { length: 320 }),
    avatar: text("avatar"),
    role: userRole("role").default("user").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    lastSignInAt: timestamp("lastSignInAt").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("users_provider_subject_idx").on(t.provider, t.subject)],
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ---------- SaaS domain: Slack workspace = OpenViking account ----------

export const workspaces = pgTable("workspaces", {
  id: serial("id").primaryKey(),
  ownerUserId: integer("ownerUserId")
    .notNull()
    .references(() => users.id),
  name: varchar("name", { length: 255 }).notNull(),
  /** Slack team id once the Slack app is installed (OAuth). */
  slackTeamId: varchar("slackTeamId", { length: 64 }).unique(),
  /** OpenViking account id (= tenant boundary). */
  ovAccountId: varchar("ovAccountId", { length: 64 }).notNull().unique(),
  plan: workspacePlan("plan").default("free").notNull(),
  /** Whether files shared in Slack are imported into team memory. On by
   *  default; a team whose policy forbids copies turns it off here. */
  storeFiles: boolean("storeFiles").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Workspace = typeof workspaces.$inferSelect;

export const workspaceMembers = pgTable("workspace_members", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspaceId")
    .notNull()
    .references(() => workspaces.id),
  userId: integer("userId")
    .notNull()
    .references(() => users.id),
  /** OpenViking user key issued for this member (memory identity). */
  ovUserKey: varchar("ovUserKey", { length: 128 }),
  /** Slack user id (U…) linked to this member; matched by email on first mention. */
  slackUserId: varchar("slackUserId", { length: 32 }),
  role: memberRole("role").default("member").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;

export const runners = pgTable("runners", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspaceId")
    .notNull()
    .references(() => workspaces.id),
  /** Member who owns this runner: their mentions run here (BYOA). */
  ownerMemberId: integer("ownerMemberId")
    .notNull()
    .references(() => workspaceMembers.id),
  label: varchar("label", { length: 255 }).notNull(),
  /** SHA-256 of the issued `frl_...` token — the token itself is never stored. */
  tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(),
  agents: jsonb("agents").$type<string[]>(),
  version: varchar("version", { length: 32 }),
  lastSeenAt: timestamp("lastSeenAt"),
  revokedAt: timestamp("revokedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Runner = typeof runners.$inferSelect;

export const channels = pgTable("channels", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspaceId")
    .notNull()
    .references(() => workspaces.id),
  slackChannelId: varchar("slackChannelId", { length: 64 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  ingestEnabled: boolean("ingestEnabled").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Channel = typeof channels.$inferSelect;

/** A conversation: one Slack thread bound to an owner and an ACP session.
 *  Mirrored from the cloud (source of truth for live state). */
export const chats = pgTable("chats", {
  id: serial("id").primaryKey(),
  /** Cloud-side chat id (UUID). */
  chatUuid: varchar("chatUuid", { length: 36 }).notNull().unique(),
  workspaceId: integer("workspaceId")
    .notNull()
    .references(() => workspaces.id),
  ownerMemberId: integer("ownerMemberId").references(() => workspaceMembers.id),
  slackChannelId: varchar("slackChannelId", { length: 64 }).notNull(),
  threadTs: varchar("threadTs", { length: 32 }).notNull(),
  acpSessionId: varchar("acpSessionId", { length: 128 }),
  status: chatStatus("status").default("idle").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  lastActivityAt: timestamp("lastActivityAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});
export type Chat = typeof chats.$inferSelect;

/** One turn of a chat: prompt -> result (wire protocol: one task). */
export const turns = pgTable("turns", {
  id: serial("id").primaryKey(),
  /** Cloud-side task id (UUID). */
  turnUuid: varchar("turnUuid", { length: 36 }).notNull().unique(),
  chatId: integer("chatId")
    .notNull()
    .references(() => chats.id),
  workspaceId: integer("workspaceId")
    .notNull()
    .references(() => workspaces.id),
  runnerId: integer("runnerId").references(() => runners.id),
  prompt: text("prompt").notNull(),
  status: turnStatus("status").default("running").notNull(),
  error: text("error"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  finishedAt: timestamp("finishedAt"),
});
export type Turn = typeof turns.$inferSelect;

export const memoryFiles = pgTable("memory_files", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspaceId")
    .notNull()
    .references(() => workspaces.id),
  slackChannelId: varchar("slackChannelId", { length: 64 }).notNull(),
  /** Slack's file id — what a `file_deleted` event gives us. */
  slackFileId: varchar("slackFileId", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 512 }).notNull(),
  mime: varchar("mime", { length: 128 }),
  /** Size as Slack reported it: OpenViking lists an imported resource as a
   *  directory of size 0, so this is the only honest number we have. */
  bytes: integer("bytes").notNull().default(0),
  /** Where it landed in the account's viking filesystem. */
  uri: varchar("uri", { length: 1024 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type MemoryFile = typeof memoryFiles.$inferSelect;

export const slackInstallations = pgTable("slack_installations", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspaceId")
    .notNull()
    .references(() => workspaces.id),
  teamId: varchar("teamId", { length: 64 }).notNull().unique(),
  teamName: varchar("teamName", { length: 255 }),
  botUserId: varchar("botUserId", { length: 64 }),
  /** Bot access token (xoxb-...). Production: encrypt at rest (KMS). */
  botToken: text("botToken").notNull(),
  /** Scopes as recorded at install time. Slack can widen a grant without
   *  our callback seeing it (a reinstall from api.slack.com updates the same
   *  token), so treat this as a hint — `auth.test` returns the truth in the
   *  `x-oauth-scopes` header. */
  scopes: varchar("scopes", { length: 512 }),
  installedByUserId: integer("installedByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});
export type SlackInstallation = typeof slackInstallations.$inferSelect;

/** One-time OAuth state tokens (CSRF protection for the Slack flows). */
export const slackOauthStates = pgTable("slack_oauth_states", {
  id: serial("id").primaryKey(),
  state: varchar("state", { length: 64 }).notNull().unique(),
  /** Flow this state belongs to: "install" (Add to Slack) or "login" (OIDC). */
  kind: varchar("kind", { length: 16 }).notNull().default("install"),
  /** NULL for the login flow: the workspace may not exist yet. */
  workspaceId: integer("workspaceId").references(() => workspaces.id),
  /** NULL for the login flow: the user is not authenticated yet. */
  userId: integer("userId").references(() => users.id),
  /** Login flow: where to redirect after a successful sign-in. */
  next: varchar("next", { length: 512 }),
  /** Login flow: OIDC nonce bound to the issued id_token. */
  nonce: varchar("nonce", { length: 64 }),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type SlackOauthState = typeof slackOauthStates.$inferSelect;

/** Browser-handoff codes for `farol runner connect`: the desktop runner
 *  polls until a logged-in user approves the code in the dashboard. */
export const runnerConnectCodes = pgTable("runner_connect_codes", {
  id: serial("id").primaryKey(),
  code: varchar("code", { length: 64 }).notNull().unique(),
  /** Machine name shown on the approval card. */
  label: varchar("label", { length: 255 }),
  userId: integer("userId").references(() => users.id),
  workspaceId: integer("workspaceId"),
  memberId: integer("memberId"),
  /** Plaintext `frl_...` token, stored only until the runner polls it once. */
  token: varchar("token", { length: 128 }),
  approvedAt: timestamp("approvedAt"),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type RunnerConnectCode = typeof runnerConnectCodes.$inferSelect;
