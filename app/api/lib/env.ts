import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value ?? "";
}

export const env = {
  appSecret: required("APP_SECRET"),
  isProduction: process.env.NODE_ENV === "production",
  databaseUrl: required("DATABASE_URL"),
  /** Slack app credentials — shared by OIDC login and "Add to Slack". */
  slackClientId: required("SLACK_CLIENT_ID"),
  slackClientSecret: required("SLACK_CLIENT_SECRET"),
  /** Public base URL of this app (used to build OAuth redirect URIs). */
  publicUrl: (process.env.PUBLIC_URL ?? "http://localhost:3000").replace(
    /\/$/,
    ""
  ),
  /** Shared secret for SaaS <-> cloud internal calls. */
  internalApiSecret: process.env.INTERNAL_API_SECRET ?? "",
  /** Base URL of the cloud service (data plane). */
  farolCloudUrl: (process.env.FAROL_CLOUD_URL ?? "").replace(/\/$/, ""),
  /** Emails (comma-separated) that get role "admin" on sign-in. */
  ownerEmails: (process.env.OWNER_EMAILS ?? "")
    .split(",")
    .map(e => e.trim().toLowerCase())
    .filter(Boolean),
};
