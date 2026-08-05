import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { env } from "./lib/env";
import { Paths } from "@contracts/constants";

const app = new Hono<{ Bindings: HttpBindings }>();

app.use(bodyLimit({ maxSize: 50 * 1024 * 1024 }));

// Sign in with Slack (OIDC).
app.get("/api/auth/slack", async (c) => {
  const { handleSlackLogin } = await import("./identity/auth");
  return handleSlackLogin(c);
});
app.get(Paths.oauthCallback, async (c) => {
  const { handleOidcCallback } = await import("./identity/auth");
  return handleOidcCallback(c);
});

// Add to Slack (bot install).
app.get("/api/slack/callback", async (c) => {
  const { handleSlackCallback } = await import("./slack-oauth");
  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  if (!code || !state) return c.redirect("/dashboard?slack=error&reason=missing_params");
  const { redirectTo } = await handleSlackCallback(code, state);
  return c.redirect(redirectTo);
});

// Runner connect (browser handoff with polling).
app.post("/api/runner/connect/start", async (c) => {
  const { handleConnectStart } = await import("./runner-connect");
  return handleConnectStart(c);
});
app.get("/api/runner/connect/poll", async (c) => {
  const { handleConnectPoll } = await import("./runner-connect");
  return handleConnectPoll(c);
});

app.use("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext,
  });
});
app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

if (env.isProduction) {
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app);

  const port = parseInt(process.env.PORT || "3000");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}
