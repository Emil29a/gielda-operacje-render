#!/usr/bin/env node
// Render clones the full repo and runs this from the project root (unlike
// a slim/dist-only deploy), so lib/sync.ts is imported straight from
// source — no need to hunt for its hashed chunk inside dist/standalone.
// Run with: node --experimental-strip-types start.mjs
//
// No background interval here on purpose — syncing runs only when someone
// actually visits the dashboard (see app/api/dashboard/route.ts), never on
// a hidden timer that keeps polling eToro with nobody watching.
import { join } from "node:path";
import { startProdServer } from "vinext/server/prod-server";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";

startProdServer({
  port,
  host,
  outDir: join(import.meta.dirname, "dist", "standalone", "dist"),
}).catch((error) => {
  console.error("[vinext] Failed to start standalone server");
  console.error(error);
  process.exit(1);
});
