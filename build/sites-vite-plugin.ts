import type { Plugin } from "vite";

/**
 * STUB — locally reconstructed placeholder.
 *
 * `build/sites-vite-plugin.ts` was imported by `vite.config.ts` but was not
 * present in the project handoff (it was missing from the original ZIP
 * archive too, not just this checkout). Judging by `.openai/hosting.json`
 * and `app/chatgpt-auth.ts`, the real plugin belongs to the OpenAI
 * "site creator" hosting platform this app was originally scaffolded in
 * (e.g. wiring `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`
 * for the ChatGPT-embedded preview). None of that is needed to run this app
 * as a plain local Next-on-Cloudflare dev server, so this stub is a no-op
 * Vite plugin that only exists to satisfy the import and let `npm run dev`
 * boot.
 *
 * If you have the original file (from the platform export or another
 * machine), replace this stub with it.
 */
export function sites(): Plugin {
  return {
    name: "sites-vite-plugin-stub",
  };
}
