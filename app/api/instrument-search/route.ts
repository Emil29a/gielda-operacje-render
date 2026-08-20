import { searchInstruments } from "../../../lib/etoro";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("query") ?? "";
    if (!query.trim()) return Response.json({ items: [] });
    const items = await searchInstruments(query);
    return Response.json({ items });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Nie udało się wyszukać instrumentu." },
      { status: 500 },
    );
  }
}
