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
    instance = drizzle(pool, { schema: fullSchema });
  }
  return instance;
}
