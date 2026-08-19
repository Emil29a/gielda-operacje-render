import { synchronizePositionsOnly } from "../../../lib/sync";

// "Odśwież teraz" refreshes today's position snapshots immediately — the
// higher-priority signal for open/close detection. Profile refresh (name,
// avatar, gains) stays on the Cron Trigger's rotation (lib/sync.ts) since it
// alone can't fit in one Worker invocation's subrequest budget.
export async function POST() {
  try {
    await synchronizePositionsOnly();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Synchronizacja nie powiodła się." },
      { status: 502 },
    );
  }
}
