import { fetchExchanges, fetchInstruments, fetchMarketRates, fetchPortfolio, fetchRecentPublicHistory, priceChange } from "../../../lib/etoro";
import { ensureSchema, listInvestors } from "../../../lib/store";
import { warsawDateKey } from "../../../lib/time";
import type { CurrentPortfolioPosition, Instrument, TradeEvent } from "../../../lib/types";

export const dynamic = "force-dynamic";

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

    // Opening a portfolio fetches this investor's own live positions and
    // closed-trade history right now, rather than relying on the periodic
    // batch sync — the batch sync only runs when explicitly requested.
    const [recentPositions, livePositions] = await Promise.all([
      fetchRecentPublicHistory(investor.cid),
      fetchPortfolio(investor.username).catch(() => []),
    ]);
    const instrumentList = await fetchInstruments([
      ...recentPositions.map((position) => position.instrumentId),
      ...livePositions.map((position) => position.instrumentId),
    ]);
    const exchanges = await fetchExchanges(
      instrumentList.flatMap((item) => item.exchangeId == null ? [] : [item.exchangeId]),
    );
    const instruments = new Map(instrumentList.map((item) => [item.instrumentId, {
      ...item,
      exchangeName: item.exchangeId == null ? null : exchanges.get(item.exchangeId) ?? null,
    }]));
    const unknownInstrument = (instrumentId: number): Instrument => ({
      instrumentId,
      symbol: `#${instrumentId}`,
      displayName: `Instrument ${instrumentId}`,
      exchangeId: null,
      exchangeName: null,
      logoUrl: null,
    });

    const rates = await fetchMarketRates(livePositions.map((position) => position.instrumentId)).catch(() => []);
    const rateMap = new Map(rates.map((rate) => [rate.instrumentId, rate]));
    const today = warsawDateKey();

    const positions: CurrentPortfolioPosition[] = livePositions.map((position) => {
      const instrument = instruments.get(position.instrumentId) ?? unknownInstrument(position.instrumentId);
      const rate = rateMap.get(position.instrumentId);
      const currentRate = rate?.currentRate ?? null;
      const currentRateAt = rate?.rateAt ?? null;
      const quoteStatus = currentRate == null || !currentRateAt
        ? "unavailable" as const
        : warsawDateKey(currentRateAt) === today ? "today" as const : "previous" as const;
      return {
        ...position,
        username: investor.username,
        observedAt: new Date().toISOString(),
        symbol: instrument.symbol,
        displayName: instrument.displayName,
        exchangeId: instrument.exchangeId,
        exchangeName: instrument.exchangeName,
        logoUrl: instrument.logoUrl,
        currentRate,
        currentRateAt,
        quoteStatus,
        ...priceChange(position.openRate, currentRate),
      };
    });

    const events: TradeEvent[] = recentPositions
      .sort((a, b) => new Date(b.closeTimestamp).getTime() - new Date(a.closeTimestamp).getTime())
      .slice(0, 50)
      .map((position) => {
        const instrument = instruments.get(position.instrumentId) ?? unknownInstrument(position.instrumentId);
        return {
          id: -Number(position.positionId) * 2 - 1,
          username: investor.username,
          eventType: "CLOSE",
          occurredAt: position.closeTimestamp,
          detectedAt: position.closeTimestamp,
          positionId: position.positionId,
          instrumentId: position.instrumentId,
          symbol: instrument.symbol,
          displayName: instrument.displayName,
          exchangeId: instrument.exchangeId,
          exchangeName: instrument.exchangeName,
          logoUrl: instrument.logoUrl,
          isBuy: position.isBuy,
          openRate: position.openRate,
          leverage: position.leverage,
          investmentPct: null,
          netProfit: position.netProfit,
          closeRate: position.closeRate,
          precision: "exact",
          note: "Pozycja jest zamknięta; czas i wynik pochodzą z publicznej historii eToro.",
          currentRate: position.closeRate,
          currentRateAt: position.closeTimestamp,
          quoteStatus: "previous",
          rateKind: "closing",
          ...priceChange(position.openRate, position.closeRate),
        };
      });

    return Response.json({ events, positions }, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Nie udało się pobrać danych inwestora." },
      { status: 500 },
    );
  }
}
