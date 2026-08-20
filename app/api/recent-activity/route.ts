import { fetchInstruments, fetchRecentPublicHistory } from "../../../lib/etoro";
import { ensureSchema, listCurrentPositions, listEventsSince, listInvestors } from "../../../lib/store";
import { previousOrSameBusinessDateKey, shiftBusinessDateKey, warsawDateKey } from "../../../lib/time";
import { mapWithConcurrency } from "../../../lib/concurrency";

export const dynamic = "force-dynamic";

export type RecentActivityPerson = {
  username: string;
  dates: string[];
  // Did this person also do the *opposite* action (sell, for a buy card;
  // re-buy, for a sell card) on the same instrument within the window?
  alsoOppositeDates: string[];
  // Positions both opened AND closed within the window — a genuine
  // short-term round trip. Shown on both the buy and sell card for that
  // instrument, since it's relevant to either view.
  roundTripReturnPct: number | null;
  // Buy card only: unrealized return of positions opened in window that
  // are *still* open right now (never sold, in window or since).
  openReturnPct: number | null;
  // Sell card only: realized return of positions closed in window that
  // were opened *before* the window (an existing holding being sold, not
  // a same-window round trip — see roundTripReturnPct for that case).
  closeReturnPct: number | null;
  // Sell card only: after this window's sale(s), does this person still
  // hold any position in this instrument at all? Null when it can't be
  // determined (buy card, or the sale data is incomplete).
  fullyExited: boolean | null;
};

export type RecentActivityGroup = {
  key: string;
  instrumentId: number;
  symbol: string;
  displayName: string;
  logoUrl: string | null;
  action: "buy" | "sell";
  people: RecentActivityPerson[];
};

export type RecentActivityPayload = {
  startDate: string;
  endDate: string;
  groups: RecentActivityGroup[];
};

const ALLOWED_DAY_WINDOWS = [5, 14, 30];

// Investor-recent-trades' history fetch, run for all 27 tracked investors
// instead of just the one being viewed. Same 10-min D1 cache
// (fetchRecentPublicHistory), so the 5/14/30-day panels loading back to
// back only pay the live-eToro cost once, the rest are cache reads.
const HISTORY_FETCH_CONCURRENCY = 3;

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

// trade_events alone (this endpoint's original source) reliably captures
// OPENs — a new position appearing is directly observable at the next sync
// tick — but badly under-counts CLOSEs/sells: a position only gets a CLOSE
// row written if a sync tick had *already* seen it as open and a *later*
// tick catches it gone, so anything opened and closed between ticks (or
// before this app started tracking it) is invisible there. eToro's public
// history endpoint (fetchRecentPublicHistory, the same source the per-day
// journal's "historicalEvents" already trusts for exact closes) doesn't
// have that gap — it's a complete record of every closed trade — so it's
// the primary source here for both sides of a closed trade, including the
// per-position netProfit needed for the return figures below. trade_events
// still contributes OPENs for positions that are *currently* open (public
// history only covers trades that have already closed), and
// listCurrentPositions() supplies the unrealized netProfit / still-held
// check for "bought and still holding" and "fully exited" respectively.
export async function GET(request: Request) {
  try {
    await ensureSchema();
    const url = new URL(request.url);
    const requestedDays = Number(url.searchParams.get("days"));
    const days = ALLOWED_DAY_WINDOWS.includes(requestedDays) ? requestedDays : 5;
    const endDate = previousOrSameBusinessDateKey(warsawDateKey());
    const startDate = shiftBusinessDateKey(endDate, -(days - 1));
    const inWindow = (day: string) => day >= startDate && day <= endDate;

    type Bucket = {
      symbol: string;
      displayName: string;
      people: Map<string, { username: string; dates: Set<string> }>;
    };
    const buckets = new Map<string, Bucket>();
    const addEntry = (
      instrumentId: number,
      action: "buy" | "sell",
      username: string,
      day: string,
      symbol: string,
      displayName: string,
    ) => {
      if (!inWindow(day)) return;
      const key = `${instrumentId}:${action}`;
      const bucket = buckets.get(key) ?? { symbol, displayName, people: new Map() };
      const usernameKey = username.toLowerCase();
      const person = bucket.people.get(usernameKey) ?? { username, dates: new Set<string>() };
      person.dates.add(day);
      bucket.people.set(usernameKey, person);
      buckets.set(key, bucket);
    };

    // Per (username, instrumentId): every buy/sell date in window, split
    // into round-trip (both legs in window) vs. one-sided (only the
    // open, or only the close, falls in window) — built alongside the
    // buckets above so each person row can be cross-referenced against
    // their *other* activity on the same instrument in the same window.
    type PersonInstrument = {
      boughtDates: Set<string>;
      soldDates: Set<string>;
      roundTripReturns: number[];
      closeOnlyReturns: number[];
    };
    const personInstrument = new Map<string, PersonInstrument>();
    const trackPI = (username: string, instrumentId: number) => {
      const key = `${username.toLowerCase()}:${instrumentId}`;
      let entry = personInstrument.get(key);
      if (!entry) {
        entry = { boughtDates: new Set(), soldDates: new Set(), roundTripReturns: [], closeOnlyReturns: [] };
        personInstrument.set(key, entry);
      }
      return entry;
    };

    const [events, investors, currentPositions] = await Promise.all([
      listEventsSince(`${startDate}T00:00:00Z`),
      listInvestors(),
      listCurrentPositions(),
    ]);

    for (const event of events) {
      if (!event.isBuy || event.eventType !== "OPEN") continue; // sells come from public history below
      const day = warsawDateKey(event.occurredAt);
      addEntry(event.instrumentId, "buy", event.username, day, event.symbol, event.displayName);
      if (inWindow(day)) trackPI(event.username, event.instrumentId).boughtDates.add(day);
    }

    await mapWithConcurrency(
      investors.filter((investor) => investor.cid !== 0),
      HISTORY_FETCH_CONCURRENCY,
      async (investor) => {
        const positions = await fetchRecentPublicHistory(investor.cid).catch(() => []);
        for (const position of positions) {
          if (!position.isBuy) continue; // shorts excluded
          const openDay = warsawDateKey(position.openTimestamp);
          const closeDay = warsawDateKey(position.closeTimestamp);
          const openInWindow = inWindow(openDay);
          const closeInWindow = inWindow(closeDay);

          addEntry(position.instrumentId, "buy", investor.username, openDay, `#${position.instrumentId}`, `Instrument ${position.instrumentId}`);
          addEntry(position.instrumentId, "sell", investor.username, closeDay, `#${position.instrumentId}`, `Instrument ${position.instrumentId}`);

          if (openInWindow || closeInWindow) {
            const pi = trackPI(investor.username, position.instrumentId);
            if (openInWindow) pi.boughtDates.add(openDay);
            if (closeInWindow) pi.soldDates.add(closeDay);
            if (position.netProfit != null) {
              if (openInWindow && closeInWindow) pi.roundTripReturns.push(position.netProfit);
              else if (closeInWindow) pi.closeOnlyReturns.push(position.netProfit);
            }
          }
        }
      },
    );

    // Unrealized return for "bought in window, still holding" entries, and
    // whether a sale left any position of that instrument still standing.
    // Only positions actually opened *within this window* count toward the
    // return figure — an investor can hold several lots of the same
    // instrument from very different times, and blending in a months-old
    // lot's return under a "bought 19.08, return to date" label would
    // misattribute it to a trade that isn't the one being shown. The
    // still-holds-anything check is deliberately NOT window-limited: the
    // question "did they fully exit?" is about right now, regardless of
    // when the remaining lot (if any) was opened.
    const openReturns = new Map<string, number[]>();
    const stillHoldsAny = new Set<string>();
    for (const position of currentPositions) {
      if (!position.isBuy) continue;
      const key = `${position.username.toLowerCase()}:${position.instrumentId}`;
      stillHoldsAny.add(key);
      if (position.netProfit == null) continue;
      if (!inWindow(warsawDateKey(position.openTimestamp))) continue;
      const list = openReturns.get(key) ?? [];
      list.push(position.netProfit);
      openReturns.set(key, list);
    }

    const instrumentIds = [...new Set([...buckets.keys()].map((key) => Number(key.split(":")[0])))];
    const freshInstruments = new Map(
      (await fetchInstruments(instrumentIds).catch(() => [])).map((item) => [item.instrumentId, item]),
    );

    const groups: RecentActivityGroup[] = [...buckets.entries()].map(([key, bucket]) => {
      const instrumentId = Number(key.split(":")[0]);
      const action = key.endsWith(":buy") ? "buy" as const : "sell" as const;
      const fresh = freshInstruments.get(instrumentId);
      const people: RecentActivityPerson[] = [...bucket.people.values()].map((person) => {
        const piKey = `${person.username.toLowerCase()}:${instrumentId}`;
        const pi = personInstrument.get(piKey);
        const dates = [...person.dates].sort();
        const roundTripReturnPct = average(pi?.roundTripReturns ?? []);
        if (action === "sell") {
          return {
            username: person.username,
            dates,
            alsoOppositeDates: [...(pi?.boughtDates ?? [])].sort(),
            roundTripReturnPct,
            openReturnPct: null,
            closeReturnPct: average(pi?.closeOnlyReturns ?? []),
            fullyExited: !stillHoldsAny.has(piKey),
          };
        }
        return {
          username: person.username,
          dates,
          alsoOppositeDates: [...(pi?.soldDates ?? [])].sort(),
          roundTripReturnPct,
          openReturnPct: average(openReturns.get(piKey) ?? []),
          closeReturnPct: null,
          fullyExited: null,
        };
      }).sort((a, b) => b.dates.length - a.dates.length || a.username.localeCompare(b.username, "pl"));
      return {
        key,
        instrumentId,
        symbol: fresh?.symbol ?? bucket.symbol,
        displayName: fresh?.displayName ?? bucket.displayName,
        logoUrl: fresh?.logoUrl ?? null,
        action,
        people,
      };
    }).sort((a, b) => b.people.length - a.people.length || a.displayName.localeCompare(b.displayName, "pl"));

    const payload: RecentActivityPayload = { startDate, endDate, groups };
    return Response.json(payload, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Nie udało się pobrać podsumowania." },
      { status: 500 },
    );
  }
}
