import { fetchInstrumentFeed } from "../../../lib/etoro";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const instrumentId = Number(url.searchParams.get("instrumentId"));
    if (!Number.isFinite(instrumentId)) {
      return Response.json({ error: "Brak parametru instrumentId." }, { status: 400 });
    }
    const posts = await fetchInstrumentFeed(instrumentId);
    return Response.json({ posts });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Nie udało się pobrać dyskusji." },
      { status: 500 },
    );
  }
}
