import { createClient } from "@libsql/client";
import { LibsqlD1Adapter } from "./libsql-d1-adapter";

// TURSO_DATABASE_URL/TURSO_AUTH_TOKEN point at the persistent, external
// database (see README for how this differs from Cloudflare D1). Render's
// free web service filesystem is ephemeral — it resets on every restart —
// so local dev is the ONLY place a local SQLite file makes sense; anything
// deployed needs a real Turso database or the trade-event history won't
// survive a restart.
let adapter: LibsqlD1Adapter | undefined;

export function getD1() {
  if (!adapter) {
    const url = process.env.TURSO_DATABASE_URL || "file:./local.db";
    const authToken = process.env.TURSO_AUTH_TOKEN;
    const client = createClient(authToken ? { url, authToken } : { url });
    adapter = new LibsqlD1Adapter(client);
  }
  return adapter;
}
