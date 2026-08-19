/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },

  // Runs on Cloudflare's own infrastructure on the schedule configured in
  // vite.config.ts's localBindingConfig — never in the browser, and each
  // tick gets its own fresh subrequest budget (see lib/sync.ts).
  // Imported dynamically (rather than statically at module top-level) so
  // this worker entry's module graph doesn't reach `cloudflare:workers`
  // (pulled in transitively via lib/sync.ts -> lib/etoro.ts) until a
  // scheduled event actually fires — plain-Node test harnesses that
  // `import()` the built bundle to exercise `fetch` never trigger it.
  async scheduled(event: ScheduledEvent, _env: Env, ctx: ExecutionContext): Promise<void> {
    console.log("scheduled handler invoked", event.cron, new Date(event.scheduledTime).toISOString());
    ctx.waitUntil(
      import("../lib/sync")
        .then(({ runScheduledSync }) => runScheduledSync())
        .then(() => console.log("runScheduledSync finished"))
        .catch((error) => console.error("runScheduledSync failed", error)),
    );
  },
};

export default worker;
