import { authRouter } from "./auth-router";
import { createRouter, publicQuery } from "./middleware";
import { billingRouter, memoryRouter, runnerRouter, workspaceRouter } from "./saas-router";
import { slackRouter } from "./slack-oauth";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: authRouter,
  workspace: workspaceRouter,
  runner: runnerRouter,
  memory: memoryRouter,
  billing: billingRouter,
  slack: slackRouter,
});

export type AppRouter = typeof appRouter;
