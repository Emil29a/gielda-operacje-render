import { etoroMode, fetchExchanges, fetchInstruments, fetchMarketRates, fetchPublicHistory, getCachedPublicHistory, priceChange } from "../../../lib/etoro";
import { ensureSchema, getState, listCurrentPositions, listEvents } from "../../../lib/store";
import type { StoredPosition } from "../../../lib/store";
import { ensureBootstrapped, synchronizePositionsOnly } from "../../../lib/sync";
import { isValidDateKey, warsawDateKey, WARSAW_TIMEZONE } from "../../../lib/time";
import type { DashboardPayload, Instrument, TradeEvent } from "../../../lib/types";
import { mapWithConcurrency, withDeadline } from "../../../lib/concurrency";

// Hard ceiling on how long any single external-data step may hold up the
// response. fetchInstruments/fetchExchanges are D1-cached (fast on a hit),
// but fetchMarketRates has no cache at all and calls eToro live on every
// request — without a deadline, a slow upstream there reproduces the exact
// hang this file was already fixed for once (see getCachedPublicHistory).
const EXTERNAL_STEP_DEADLINE_MS = 5_000;

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await ensureSchema();
    const mode = etoroMode();
    const url = new URL(request.url);
    // ensureBootstrapped only seeds placeholder rows locally (no eToro
    // calls), so the UI has something to show even before any sync happens.
    const { investors } = await ensureBootstrapped();
    const requestedDate = url.searchParams.get("date");
    const selectedDate = isValidDateKey(requestedDate)
      ? requestedDate!
      : warsawDateKey();
    const isToday = selectedDate === warsawDateKey();
    // No background timer polls eToro on its own — profile/portfolio
    // syncing only happens because someone is actually looking at today,
    // right here. synchronizePositionsOnly() has its own lock and a 90s
    // minimum interval, so rapid repeat visits are cheap no-ops rather than
    // piling up eToro requests.
    if (isToday) {
      await synchronizePositionsOnly().catch(() => {});
    }
    const storedPositions = await listCurrentPositions();
    const snapshotEvents = (await listEvents()).filter(
      (event) => warsawDateKey(event.occurredAt) === selectedDate,
    );
    const unavailableHistory: string[] = [];
    // Today always loads completely: try the cache first (fast — warmed by
    // the synchronizePositionsOnly() call above), and for any investor it
    // hasn't reached yet, fall back to a live fetch right here rather than
    // just showing them as unavailable. The fallback stays gently paced
    // (HISTORY_FETCH_CONCURRENCY), not a 27-way burst, to respect eToro's
    // rate limit — the lesson from the burst-triggered 429s earlier.
    // Any other date is lower priority (the user only sees it by explicitly
    // clicking through) and stays cache-only, with no live fallback.
    const HISTORY_FETCH_CONCURRENCY = 3;
    const historyByInvestor = mode === "live"
      ? await mapWithConcurrency(investors, HISTORY_FETCH_CONCURRENCY, async (investor) => {
          const { positions, cached } = await getCachedPublicHistory(investor.cid, selectedDate);
          if (cached) return { investor, positions };
          if (isToday && investor.cid !== 0) {
            const livePositions = await fetchPublicHistory(investor.cid, selectedDate).catch(() => null);
            if (livePositions) return { investor, positions: livePositions };
          }
          unavailableHistory.push(investor.username);
          return { investor, positions };
        })
      : [];
    const historyInstrumentList = mode === "live"
      ? await withDeadline(
          fetchInstruments([
            ...storedPositions.map((position) => position.instrumentId),
            ...historyByInvestor.flatMap(({ positions }) => positions.map((position) => position.instrumentId)),
          ]).catch(() => []),
          EXTERNAL_STEP_DEADLINE_MS,
          [],
        )
      : [];
    const historyExchanges = mode === "live"
      ? await withDeadline(
          fetchExchanges(historyInstrumentList.flatMap((instrument) =>
            instrument.exchangeId == null ? [] : [instrument.exchangeId])).catch(() => new Map<number, string>()),
          EXTERNAL_STEP_DEADLINE_MS,
          new Map<number, string>(),
        )
      : new Map<number, string>();
    const historyInstruments = new Map(historyInstrumentList.map((instrument) => [
      instrument.instrumentId,
      {
        ...instrument,
        exchangeName: instrument.exchangeId == null
          ? null
          : historyExchanges.get(instrument.exchangeId) ?? null,
      },
    ]));
    const unknownInstrument = (instrumentId: number): Instrument => ({
      instrumentId,
      symbol: `#${instrumentId}`,
      displayName: `Instrument ${instrumentId}`,
      exchangeId: null,
      exchangeName: null,
      logoUrl: null,
    });
    const historicalEvents: TradeEvent[] = [];
    for (const { investor, positions: historyPositions } of historyByInvestor) {
      for (const position of historyPositions) {
        const instrument = historyInstruments.get(position.instrumentId)
          ?? unknownInstrument(position.instrumentId);
        const common = {
          username: investor.username,
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
          currentRate: null,
          currentRateAt: null,
          priceChangePct: null,
          priceDirection: "unknown" as const,
          quoteStatus: "unavailable" as const,
        };
        if (warsawDateKey(position.openTimestamp) === selectedDate) {
          historicalEvents.push({
            ...common,
            id: -Number(position.positionId) * 2,
            eventType: "OPEN",
            occurredAt: position.openTimestamp,
            detectedAt: position.openTimestamp,
            netProfit: null,
            closeRate: null,
            precision: "exact",
            note: "Dokładne otwarcie pochodzi z publicznej historii eToro.",
            rateKind: "current",
          });
        }
        if (warsawDateKey(position.closeTimestamp) === selectedDate) {
          historicalEvents.push({
            ...common,
            id: -Number(position.positionId) * 2 - 1,
            eventType: "CLOSE",
            occurredAt: position.closeTimestamp,
            detectedAt: position.closeTimestamp,
            netProfit: position.netProfit,
            closeRate: position.closeRate,
            precision: "exact",
            note: "Dokładne zamknięcie, kurs i wynik pochodzą z publicznej historii eToro.",
            rateKind: "closing",
          });
        }
      }
    }
    const currentOpenEvents: TradeEvent[] = storedPositions
      .filter((position) => warsawDateKey(position.openTimestamp) === selectedDate)
      .map((position) => ({
        id: -Number(position.positionId) * 2,
        username: position.username,
        eventType: "OPEN",
        occurredAt: position.openTimestamp,
        detectedAt: position.observedAt,
        positionId: position.positionId,
        instrumentId: position.instrumentId,
        symbol: position.symbol,
        displayName: position.displayName,
        exchangeId: position.exchangeId,
        exchangeName: position.exchangeName,
        logoUrl: historyInstruments.get(position.instrumentId)?.logoUrl ?? null,
        isBuy: position.isBuy,
        openRate: position.openRate,
        leverage: position.leverage,
        investmentPct: position.investmentPct,
        netProfit: position.netProfit,
        closeRate: null,
        precision: "exact",
        note: "Dokładne otwarcie pochodzi z aktualnego publicznego portfela eToro.",
        currentRate: null,
        currentRateAt: null,
        priceChangePct: null,
        priceDirection: "unknown",
        quoteStatus: "unavailable",
        rateKind: "current",
      }));
    // Some tracked investors run grid/dividend-style strategies with 100-200+
    // simultaneously open positions; across 27 investors that's grown past
    // 5,000 rows. Grouping the cheap StoredPosition rows by username first,
    // sorting each investor's bucket once, and trimming to the 50 most recent
    // *before* building full TradeEvent objects (instead of eagerly building
    // ~5,000 TradeEvent objects and only then grouping/sorting/trimming) keeps
    // both allocation and CPU work down to what's actually returned — the
    // eager version was expensive enough to trip the Workers free plan's
    // CPU/memory limits (Cloudflare error 1102).
    const positionsByUsername = new Map<string, StoredPosition[]>();
    for (const position of storedPositions) {
      const key = position.username.toLowerCase();
      const bucket = positionsByUsername.get(key);
      if (bucket) bucket.push(position);
      else positionsByUsername.set(key, [position]);
    }
    for (const bucket of positionsByUsername.values()) {
      bucket.sort((a, b) => new Date(b.openTimestamp).getTime() - new Date(a.openTimestamp).getTime());
    }
    const toRecentEvent = (position: StoredPosition): TradeEvent => ({
      id: -Number(position.positionId) * 2,
      username: position.username,
      eventType: "OPEN",
      occurredAt: position.openTimestamp,
      detectedAt: position.observedAt,
      positionId: position.positionId,
      instrumentId: position.instrumentId,
      symbol: position.symbol,
      displayName: position.displayName,
      exchangeId: position.exchangeId,
      exchangeName: position.exchangeName,
      logoUrl: historyInstruments.get(position.instrumentId)?.logoUrl ?? null,
      isBuy: position.isBuy,
      openRate: position.openRate,
      leverage: position.leverage,
      investmentPct: position.investmentPct,
      netProfit: position.netProfit,
      closeRate: null,
      precision: "exact",
      note: "Pozycja jest nadal otwarta w publicznym portfelu eToro.",
      currentRate: null,
      currentRateAt: null,
      priceChangePct: null,
      priceDirection: "unknown",
      quoteStatus: "unavailable",
      rateKind: "current",
    });
    const latestEvents = investors.flatMap((investor) =>
      (positionsByUsername.get(investor.username.toLowerCase()) ?? [])
        .slice(0, 50)
        .map(toRecentEvent));
    const eventMap = new Map<string, TradeEvent>();
    for (const event of snapshotEvents) {
      eventMap.set(`${event.username.toLowerCase()}:${event.positionId}:${event.eventType}`, event);
    }
    for (const event of currentOpenEvents) {
      eventMap.set(`${event.username.toLowerCase()}:${event.positionId}:${event.eventType}`, event);
    }
    for (const event of historicalEvents) {
      eventMap.set(`${event.username.toLowerCase()}:${event.positionId}:${event.eventType}`, event);
    }
    const events = [...eventMap.values()].sort(
      (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    );
    const instrumentIds = [
      ...storedPositions.map((position) => position.instrumentId),
      ...events.map((event) => event.instrumentId),
      ...latestEvents.map((event) => event.instrumentId),
    ];
    const rates = mode === "live"
      ? await withDeadline(fetchMarketRates(instrumentIds).catch(() => []), EXTERNAL_STEP_DEADLINE_MS, [])
      : [];
    const rateMap = new Map(rates.map((rate) => [rate.instrumentId, rate]));
    const today = warsawDateKey();
    const enrich = <T extends { instrumentId: number; openRate: number | null }>(item: T) => {
      const rate = rateMap.get(item.instrumentId);
      const event = item as T & Partial<TradeEvent>;
      const usesClosingRate = event.eventType === "CLOSE" && event.closeRate != null;
      const valuationRate = usesClosingRate ? event.closeRate! : rate?.currentRate ?? null;
      const valuationTime = usesClosingRate ? event.occurredAt ?? null : rate?.rateAt ?? null;
      const quoteStatus = valuationRate == null || !valuationTime
        ? "unavailable" as const
        : warsawDateKey(valuationTime) === today ? "today" as const : "previous" as const;
      return {
        ...item,
        logoUrl: historyInstruments.get(item.instrumentId)?.logoUrl ?? event.logoUrl ?? null,
        currentRate: valuationRate,
        currentRateAt: valuationTime,
        quoteStatus,
        rateKind: usesClosingRate ? "closing" as const : "current" as const,
        ...priceChange(item.openRate, valuationRate),
      };
    };
    const currentPositionMap = new Map(storedPositions.map((position) => [
      `${position.username.toLowerCase()}:${position.positionId}`,
      position,
    ]));
    const enrichedEvents = events.map((event) => {
      const currentPosition = currentPositionMap.get(
        `${event.username.toLowerCase()}:${event.positionId}`,
      );
      return enrich({
        ...event,
        netProfit: currentPosition?.netProfit ?? event.netProfit,
      });
    });
    const enrichedRecentEvents = latestEvents.map(enrich);
    // Some tracked investors run grid/dividend-style strategies with 100-200+
    // simultaneously open positions; across 27 investors that's grown past
    // 5,000 rows. Today's events (the priority data) are already computed
    // above from the full, uncapped storedPositions — this cap only bounds
    // the supplementary "every currently open position" list, which the UI
    // otherwise refreshes live and in full the moment an investor's profile
    // is opened. Processing and serializing all of them on every dashboard
    // load was enough to trip the Workers free plan's CPU/memory limits
    // (Cloudflare error 1102).
    const MAX_POSITIONS_IN_PAYLOAD = 1500;
    const positions = [...storedPositions]
      .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime())
      .slice(0, MAX_POSITIONS_IN_PAYLOAD)
      .map(enrich);
    const unavailableUsers = [...new Set(unavailableHistory)];
    const lastSync = await getState("last_position_sync");
    const payload: DashboardPayload = {
      mode,
      timezone: WARSAW_TIMEZONE,
      selectedDate,
      lastSync,
      investors,
      events: enrichedEvents,
      recentEvents: enrichedRecentEvents,
      positions,
      notice: mode === "unconfigured"
        ? "Brak kluczy API eToro."
        : unavailableUsers.length
          ? `eToro nie udostępniło teraz pełnej historii transakcji dla: ${unavailableUsers.map((username) => `@${username}`).join(", ")}. Bieżące pozycje są kompletne, ale część zamknięć może być chwilowo niewidoczna.`
          : "",
    };
    return Response.json(payload, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Nie udało się wczytać panelu." },
      { status: 500 },
    );
  }
}
