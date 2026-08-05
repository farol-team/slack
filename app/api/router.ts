import { authRouter } from "./auth-router";
import { createRouter, publicQuery } from "./middleware";
import {
  billingRouter,
  chatSyncRouter,
  memoryRouter,
  runnerRouter,
  workspaceRouter,
} from "./saas-router";
import { slackRouter } from "./slack-oauth";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: authRouter,
  workspace: workspaceRouter,
  runner: runnerRouter,
  memory: memoryRouter,
  billing: billingRouter,
  slack: slackRouter,
  chatSync: chatSyncRouter,
});

export type AppRouter = typeof appRouter;
