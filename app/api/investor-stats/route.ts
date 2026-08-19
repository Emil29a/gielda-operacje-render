import { fetchInvestorExtendedStats } from "../../../lib/etoro";
import { ensureSchema, listInvestors } from "../../../lib/store";

export const dynamic = "force-dynamic";

// Deliberately separate from /api/dashboard's route: these stats (win
// ratio, top traded instrument, monthly/yearly gain history) cost 3 extra
// eToro requests per investor, so they're fetched only when a user actually
// opens that investor's portfolio dialog — never as part of the periodic
// batch sync that runs for all tracked investors on every visit.
export async function GET(request: Request) {
  try {
    await ensureSchema();
    const url = new URL(request.url);
    const username = url.searchParams.get("username");
    if (!username) {
      return Response.json({ error: "Brak parametru username." }, { status: 400 });
    }
    const investors = await listInvestors();
    const investor = investors.find(
      (item) => item.username.toLowerCase() === username.toLowerCase(),
    );
    if (!investor) {
      return Response.json({ error: "Nie znaleziono inwestora." }, { status: 404 });
    }
    const stats = await fetchInvestorExtendedStats(investor.username, investor.cid);
    return Response.json(stats);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Nie udało się pobrać statystyk." },
      { status: 500 },
    );
  }
}
