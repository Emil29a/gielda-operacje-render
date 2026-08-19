#!/usr/bin/env node
// Render clones the full repo and runs this from the project root (unlike
// a slim/dist-only deploy), so lib/sync.ts is imported straight from
// source — no need to hunt for its hashed chunk inside dist/standalone.
// Run with: node --experimental-strip-types start.mjs
//
// Render runs this as one long-lived process (unlike Cloudflare Workers,
// which bills per-invocation and needed a separate Cron Trigger), so the
// background sync is just a setInterval in the same process as the HTTP
// server — no separate worker/schedule mechanism required.
import { join } from "node:path";
import { startProdServer } from "vinext/server/prod-server";
import { runScheduledSync } from "./lib/sync.ts";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";

const SYNC_INTERVAL_MS = 3 * 60 * 1000;

function runSyncLoop() {
  const tick = () => {
    runScheduledSync()
      .then(() => console.log("[sync] tick finished", new Date().toISOString()))
      .catch((error) => console.error("[sync] tick failed", error));
  };
  tick();
  setInterval(tick, SYNC_INTERVAL_MS);
}

startProdServer({
  port,
  host,
  outDir: join(import.meta.dirname, "dist", "standalone", "dist"),
}).catch((error) => {
  console.error("[vinext] Failed to start standalone server");
  console.error(error);
  process.exit(1);
});

runSyncLoop();
