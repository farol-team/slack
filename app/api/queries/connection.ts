import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../lib/env";
import * as schema from "@db/schema";
import * as relations from "@db/relations";

const fullSchema = { ...schema, ...relations };

let instance: ReturnType<typeof drizzle<typeof fullSchema>>;

export function getDb() {
  if (!instance) {
    // Managed PostgreSQL requires TLS; the cluster CA is not bundled,
    // so trust the server cert by host (same posture as sibling apps).
    // Serverless-friendly pool: instances freeze between requests and
    // their sockets die — keep idle lifetime short and never let an
    // idle-client error escape as an unhandled event (it kills node).
    const pool = new Pool({
      connectionString: env.databaseUrl,
      ssl: env.databaseUrl.includes("localhost")
        ? undefined
        : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on("error", (err) => {
      console.warn("[pg] idle client error:", err.message);
    });

    // A frozen instance wakes up holding sockets that died while it slept, and
    // pgbouncer drops connections on its own schedule. The first query after a
    // cold start is the one that finds out — which is exactly the request a
    // person just made. One retry turns a 500 into a slightly slow response.
    const rawQuery = pool.query.bind(pool);
    (pool as { query: unknown }).query = async (...args: unknown[]) => {
      // Callback form: leave it alone, nothing here awaits it.
      if (typeof args.at(-1) === "function") {
        return (rawQuery as (...a: unknown[]) => unknown)(...args);
      }
      try {
        return await (rawQuery as (...a: unknown[]) => Promise<unknown>)(...args);
      } catch (err) {
        if (!isTransient(err)) throw err;
        console.warn("[pg] transient error, retrying:", (err as Error).message);
        return await (rawQuery as (...a: unknown[]) => Promise<unknown>)(...args);
      }
    };

    instance = drizzle(pool, { schema: fullSchema });
  }
  return instance;
}

/** Connection-level failures worth one more attempt: a dead socket, a closed
 *  pgbouncer connection, an admin-terminated backend. Query errors — bad SQL,
 *  constraint violations — are not in here and must surface as they are. */
function isTransient(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  const code = e?.code ?? "";
  if (
    ["ECONNRESET", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED"].includes(code) ||
    ["08000", "08003", "08006", "08P01", "57P01", "57P02", "57P03"].includes(code)
  ) {
    return true;
  }
  const msg = (e?.message ?? "").toLowerCase();
  return (
    msg.includes("connection terminated") ||
    msg.includes("server closed the connection") ||
    msg.includes("connection timeout") ||
    msg.includes("timeout exceeded when trying to connect")
  );
}
