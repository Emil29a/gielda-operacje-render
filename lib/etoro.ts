import type { AssetAllocationSeries, FeedPost, GainPoint, HistoricalPosition, Instrument, InvestorExtendedStats, Investor, MarketRate, PortfolioPosition } from "./types";
import { shiftDateKey, warsawDateKey } from "./time";
import { mapWithConcurrency } from "./concurrency";
import { findKnownExchangeNames, findKnownInstruments, getState, getStateWithTimestamp, setState } from "./store";

const INVESTOR_REQUEST_CONCURRENCY = 5;
// lib/sync.ts's runScheduledSync() proactively warms this cache every tick
// for a rotating chunk of investors (POSITION_CHUNK_SIZE), but full rotation
// across all tracked investors takes several ticks. The TTL needs to outlast
// one full rotation cycle so a dashboard visit almost always finds a cache
// entry within its TTL — withHistoryCache only falls back to a stale entry
// on an actual fetch error, not on mere expiry, so a too-short TTL here
// meant most visits still triggered a live 27-investor fetch fan-out
// directly in the request path regardless of the warming.
const HISTORY_CACHE_TTL_MS = 15 * 60 * 1000;
const RECENT_HISTORY_CACHE_TTL_MS = 10 * 60 * 1000;

// A 429 from eToro is treated as a global, site-wide circuit breaker: every
// caller across every request (this tab, another tab, the 5-minute
// background sync, a future deployment) shares this D1-backed cooldown, so
// nothing retries against eToro until it expires. This matters far more than
// per-request retries — retrying a request-by-request 429 just adds more
// "offending" requests during an active lockout instead of letting it clear.
//
// The cooldown backs off exponentially on repeated strikes (8 → 16 → 32,
// capped at 45 min): eToro's actual lockout length isn't documented, so a
// fixed wait that turns out too short would just mean tripping the same
// wall again on the very next attempt. A strike streak resets the moment a
// request actually succeeds.
const BASE_RATE_LIMIT_COOLDOWN_MS = 8 * 60 * 1000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 45 * 60 * 1000;
const API_COOLDOWN_KEY = "etoro_api_cooldown_until";
const API_STRIKES_KEY = "etoro_api_cooldown_strikes";
const HISTORY_COOLDOWN_KEY = "etoro_history_cooldown_until";
const HISTORY_STRIKES_KEY = "etoro_history_cooldown_strikes";

const BASE_URL = "https://public-api.etoro.com";

async function cooldownRemainingMinutes(stateKey: string): Promise<number> {
  const raw = await getState(stateKey).catch(() => null);
  if (!raw) return 0;
  const remainingMs = new Date(raw).getTime() - Date.now();
  return remainingMs > 0 ? Math.ceil(remainingMs / 60_000) : 0;
}

async function markRateLimited(stateKey: string, strikesKey: string) {
  const strikesRaw = await getState(strikesKey).catch(() => null);
  const strikes = (strikesRaw ? Number(strikesRaw) || 0 : 0) + 1;
  const cooldownMs = Math.min(
    BASE_RATE_LIMIT_COOLDOWN_MS * 2 ** (strikes - 1),
    MAX_RATE_LIMIT_COOLDOWN_MS,
  );
  const until = new Date(Date.now() + cooldownMs).toISOString();
  await Promise.all([
    setState(stateKey, until).catch(() => {}),
    setState(strikesKey, String(strikes)).catch(() => {}),
  ]);
}

async function markRequestSucceeded(stateKey: string, strikesKey: string) {
  // A successful request proves eToro is currently letting us through, so a
  // cooldown a sibling request in the same concurrent batch just set (or an
  // older one still winding down) is now stale and shouldn't keep blocking
  // us for its full, possibly-escalated duration.
  const [strikesRaw, cooldownRaw] = await Promise.all([
    getState(strikesKey).catch(() => null),
    getState(stateKey).catch(() => null),
  ]);
  const tasks: Promise<unknown>[] = [];
  if (strikesRaw && strikesRaw !== "0") tasks.push(setState(strikesKey, "0").catch(() => {}));
  if (cooldownRaw && new Date(cooldownRaw).getTime() > Date.now()) {
    tasks.push(setState(stateKey, new Date(0).toISOString()).catch(() => {}));
  }
  if (tasks.length) await Promise.all(tasks);
}

export function priceChange(openRate: number | null, currentRate: number | null) {
  if (openRate == null || currentRate == null || openRate === 0) {
    return { priceChangePct: null, priceDirection: "unknown" as const };
  }
  const priceChangePct = ((currentRate - openRate) / openRate) * 100;
  const priceDirection = Math.abs(priceChangePct) < 0.005
    ? "flat" as const
    : priceChangePct > 0 ? "up" as const : "down" as const;
  return { priceChangePct, priceDirection };
}

type RuntimeEnv = {
  ETORO_API_KEY?: string;
  ETORO_USER_KEY?: string;
};

function runtimeEnv() {
  return process.env as unknown as RuntimeEnv;
}

export function etoroMode(): "unconfigured" | "live" {
  const current = runtimeEnv();
  return current.ETORO_API_KEY && current.ETORO_USER_KEY ? "live" : "unconfigured";
}

async function etoroRequest<T>(path: string): Promise<T> {
  const current = runtimeEnv();
  if (!current.ETORO_API_KEY || !current.ETORO_USER_KEY) {
    throw new Error("Brakuje kluczy eToro po stronie serwera.");
  }
  const cooldown = await cooldownRemainingMinutes(API_COOLDOWN_KEY);
  if (cooldown > 0) {
    throw new Error(`eToro tymczasowo ograniczyło liczbę zapytań. Spróbuj ponownie za ok. ${cooldown} min.`);
  }
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers: {
      "x-api-key": current.ETORO_API_KEY,
      "x-user-key": current.ETORO_USER_KEY,
      "x-request-id": crypto.randomUUID(),
    },
    // Without a timeout, a single slow/unresponsive eToro call hangs the
    // whole invocation indefinitely — every caller already wraps these in
    // .catch() for graceful degradation, but that only helps once the call
    // actually rejects. Matches fetchPublicHistory's existing timeout.
    signal: AbortSignal.timeout(12_000),
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    errorMessage?: string;
  };
  if (response.status === 429) {
    await markRateLimited(API_COOLDOWN_KEY, API_STRIKES_KEY);
    throw new Error(
      payload.errorMessage || payload.error || "eToro zwróciło błąd 429.",
    );
  }
  if (!response.ok) {
    throw new Error(
      payload.errorMessage || payload.error || `eToro zwróciło błąd ${response.status}.`,
    );
  }
  await markRequestSucceeded(API_COOLDOWN_KEY, API_STRIKES_KEY);
  return payload;
}

// Cheap identity-only resolve: 1 request per investor (just the people
// lookup) instead of resolveInvestors' 3 (people lookup + 2 tradeinfo
// periods for gain stats). Enough to get a real cid/name/avatar — which is
// what unlocks portfolio syncing showing up correctly and the history
// live-fallback (both need cid) — without paying for gain stats up front.
// Gain stats missing just renders as "—" in the UI, same as any other
// not-yet-available field; resolveInvestors can fill them in later, more
// gradually, once identity resolution for everyone isn't still pending.
export async function resolveInvestorIdentities(usernames: string[], slotOffset = 0): Promise<Investor[]> {
  return mapWithConcurrency(
    usernames,
    INVESTOR_REQUEST_CONCURRENCY,
    async (username, index) => {
      const params = new URLSearchParams({ usernames: username });
      const data = await etoroRequest<{
        users?: Array<{
          realCID?: number;
          gcid?: number;
          username: string;
          avatars?: Array<{ url?: string; width?: number; type?: string }>;
        }>;
      }>(`/api/v1/user-info/people?${params}`);
      const profile = (data.users ?? []).find(
        (item) => item.username.toLowerCase() === username.toLowerCase(),
      );
      if (!profile) throw new Error(`Nie odnaleziono profilu @${username}.`);
      const avatars = [...(profile.avatars ?? [])].filter((item) => item.url);
      const originalAvatar = avatars.find((item) =>
        item.type?.toLowerCase() === "original" || item.url?.includes("/avatars/original/"),
      );
      const avatar = originalAvatar?.url || avatars.sort(
        (a, b) => (b.width ?? 0) - (a.width ?? 0),
      )[0]?.url;
      return {
        slot: slotOffset + index + 1,
        username: profile.username,
        cid: profile.realCID || profile.gcid || 0,
        fullName: profile.username,
        avatarUrl: avatar || null,
        riskScore: null,
        dailyGain: null,
        gainYtd: null,
        gainTwoYears: null,
        copiers: null,
        updatedAt: new Date().toISOString(),
        activeSince: null,
        annualizedReturn: null,
        fiveYearGain: null,
        rankPosition: null,
        rankPoolSize: null,
      };
    },
  );
}

// Compounds a "since inception" return from monthly gain-history entries —
// e.g. +10% then -10% nets to -1%, not 0%, so this multiplies growth
// factors rather than summing percentages. Used as a fallback for
// fiveYearGain on accounts too young for eToro's own 5-year figure.
function compoundMonthlyGains(monthly: Array<{ gain?: number }>): number | null {
  if (!monthly.length) return null;
  const factor = monthly.reduce((acc, month) => acc * (1 + (month.gain ?? 0) / 100), 1);
  return (factor - 1) * 100;
}

export async function resolveInvestors(usernames: string[], slotOffset = 0): Promise<Investor[]> {
  return mapWithConcurrency(
    usernames,
    INVESTOR_REQUEST_CONCURRENCY,
    async (username, index) => {
      const params = new URLSearchParams({ usernames: username });
      const data = await etoroRequest<{
        users?: Array<{
          realCID?: number;
          gcid?: number;
          username: string;
          avatars?: Array<{ url?: string; width?: number; type?: string }>;
        }>;
      }>(`/api/v1/user-info/people?${params}`);
      const profile = (data.users ?? []).find(
        (item) => item.username.toLowerCase() === username.toLowerCase(),
      );
      if (!profile) throw new Error(`Nie odnaleziono profilu @${username}.`);
      type TradeInfo = {
        fullName?: string;
        gain?: number;
        riskScore?: number;
        dailyGain?: number;
        copiers?: number;
        isPopularInvestor?: boolean;
      };
      const tradeInfoPath = `/api/v1/user-info/people/${encodeURIComponent(username)}/tradeinfo`;
      // tradeinfo's own weeksSinceRegistration field is unreliable (verified
      // off by years against real registration dates on multiple accounts),
      // so registration date comes from a separate, cheap source instead:
      // the earliest entry in this investor's full monthly gain history —
      // its timestamp lines up exactly with the real "active since" date
      // shown on eToro's own profile pages.
      //
      // findExactRank's list-scan (see that function) already returns
      // annualizedReturn/fiveYearGain for free from the matched row, so
      // that's the primary source now instead of a dedicated per-investor
      // request — computed here alongside the others, not after, so the
      // rank lookup's own sequential paging overlaps with these instead of
      // adding to the total wait. The dedicated per-investor rankings
      // request only still runs as a fallback, for the rare investor
      // findExactRank can't find in the copiersMin pool at all (e.g.
      // leszekfx, with too few copiers to appear in it).
      const [currentYear, lastTwoYears, gainHistory, rank] = await Promise.all([
        etoroRequest<TradeInfo>(`${tradeInfoPath}?period=CurrYear`),
        etoroRequest<TradeInfo>(`${tradeInfoPath}?period=LastTwoYears`),
        etoroRequest<{ monthly?: Array<{ timestamp: string; gain?: number }> }>(
          `/api/v1/user-info/people/${encodeURIComponent(username)}/gain`,
        ).catch(() => ({ monthly: [] })),
        findExactRank(username),
      ]);
      if (!currentYear.isPopularInvestor) {
        throw new Error(`@${username} nie jest obecnie oznaczony jako Popular Investor.`);
      }
      const avatars = [...(profile.avatars ?? [])].filter((item) => item.url);
      const originalAvatar = avatars.find((item) =>
        item.type?.toLowerCase() === "original" || item.url?.includes("/avatars/original/"),
      );
      const avatar = originalAvatar?.url || avatars.sort(
        (a, b) => (b.width ?? 0) - (a.width ?? 0),
      )[0]?.url;
      let annualizedReturn = rank?.annualizedReturn ?? null;
      // Real 5-year figure when the account is old enough for eToro to give
      // one (see findExactRank); otherwise, compounding the same monthly
      // gain history already fetched for activeSince gives an honest
      // "return since this account started" number instead of just "—" —
      // exactly what a 5-year figure degrades to for a younger account.
      const fiveYearGain = rank?.fiveYearGain ?? compoundMonthlyGains(gainHistory.monthly);
      if (rank == null) {
        const rankingRow = await etoroRequest<{ data?: { annualizedReturn?: number } }>(
          `/api/v2/portfolios/${encodeURIComponent(username)}/rankings?period=LastYear`,
        ).catch(() => null);
        annualizedReturn = rankingRow?.data?.annualizedReturn != null ? rankingRow.data.annualizedReturn * 100 : null;
      }
      return {
        slot: slotOffset + index + 1,
        username: profile.username,
        cid: profile.realCID || profile.gcid || 0,
        fullName: currentYear.fullName || profile.username,
        avatarUrl: avatar || null,
        riskScore: currentYear.riskScore ?? null,
        dailyGain: currentYear.dailyGain ?? null,
        gainYtd: currentYear.gain ?? null,
        gainTwoYears: lastTwoYears.gain ?? null,
        copiers: currentYear.copiers ?? null,
        updatedAt: new Date().toISOString(),
        activeSince: gainHistory.monthly?.[0]?.timestamp ?? null,
        annualizedReturn,
        fiveYearGain,
        rankPosition: rank?.position ?? null,
        rankPoolSize: rank?.poolSize ?? null,
      };
    },
  );
}

export async function fetchPortfolio(username: string): Promise<PortfolioPosition[]> {
  const data = await etoroRequest<{
    positions?: PortfolioPosition[];
    socialTrades?: Array<{ positions?: PortfolioPosition[] }>;
  }>(`/api/v1/user-info/people/${encodeURIComponent(username)}/portfolio/live`);
  // `positions` are this investor's own positions. `socialTrades` are positions
  // inherited from people they copy and must not be attributed as their own trades.
  const all = data.positions ?? [];
  const seen = new Set<string>();
  return all
    .map((position) => ({ ...position, positionId: String(position.positionId) }))
    .filter((position) => {
      if (seen.has(position.positionId)) return false;
      seen.add(position.positionId);
      return true;
    });
}

async function fetchInstrumentsLive(ids: number[]): Promise<Instrument[]> {
  const chunks = Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) =>
    ids.slice(index * 100, index * 100 + 100),
  );
  const results = await Promise.all(chunks.map(async (chunk) => {
    const params = new URLSearchParams({ instrumentIds: chunk.join(",") });
    const data = await etoroRequest<{
      instrumentDisplayDatas?: Array<{
        instrumentID: number;
        instrumentDisplayName?: string;
        symbolFull?: string;
        exchangeID?: number;
        images?: Array<{
          width?: number;
          height?: number;
          uri?: string;
        }>;
      }>;
    }>(`/api/v1/market-data/instruments?${params}`);
    return data.instrumentDisplayDatas ?? [];
  }));
  return results.flat().map((item) => {
    const image = [...(item.images ?? [])]
      .filter((current) => current.uri)
      .sort((a, b) => (b.width ?? b.height ?? 0) - (a.width ?? a.height ?? 0))[0];
    return {
      instrumentId: item.instrumentID,
      symbol: item.symbolFull || `#${item.instrumentID}`,
      displayName: item.instrumentDisplayName || item.symbolFull || `Instrument ${item.instrumentID}`,
      exchangeId: item.exchangeID ?? null,
      exchangeName: null,
      logoUrl: image?.uri ?? null,
    };
  });
}

// Instrument metadata (symbol, name, exchange, logo) is effectively static,
// so once an instrument is resolved it's cached indefinitely in D1. A 429
// during a live lookup then only ever affects instruments never seen
// before — everything already known keeps showing its real name and logo
// instead of falling back to "#id · Instrument id".
export async function fetchInstruments(instrumentIds: number[]): Promise<Instrument[]> {
  const ids = [...new Set(instrumentIds)].filter(Number.isFinite);
  if (!ids.length) return [];
  const cachedEntries = await Promise.all(ids.map(async (id) => {
    const raw = await getState(`instrument:${id}`).catch(() => null);
    return raw ? (JSON.parse(raw) as Instrument) : null;
  }));
  const resultMap = new Map<number, Instrument>();
  const missingIds: number[] = [];
  ids.forEach((id, index) => {
    const cached = cachedEntries[index];
    if (cached) resultMap.set(id, cached);
    else missingIds.push(id);
  });
  if (missingIds.length) {
    // Before attempting a live lookup (which may be rate-limited), reuse
    // symbol/name data eToro has already given us for these instruments on
    // some past event or open position — accurate, and no API call needed.
    const known = await findKnownInstruments(missingIds).catch((error) => {
      console.error("findKnownInstruments failed", error);
      return new Map<number, {
        symbol: string;
        displayName: string;
        exchangeId: number | null;
        exchangeName: string | null;
      }>();
    });
    const stillMissing: number[] = [];
    for (const id of missingIds) {
      const match = known.get(id);
      if (!match) {
        stillMissing.push(id);
        continue;
      }
      const instrument: Instrument = {
        instrumentId: id,
        symbol: match.symbol,
        displayName: match.displayName,
        exchangeId: match.exchangeId,
        exchangeName: match.exchangeName,
        logoUrl: null,
      };
      resultMap.set(id, instrument);
      await setState(`instrument:${id}`, JSON.stringify(instrument)).catch(() => {});
    }
    if (stillMissing.length) {
      try {
        const fetched = await fetchInstrumentsLive(stillMissing);
        await Promise.all(fetched.map((instrument) =>
          setState(`instrument:${instrument.instrumentId}`, JSON.stringify(instrument)).catch(() => {}),
        ));
        for (const instrument of fetched) resultMap.set(instrument.instrumentId, instrument);
      } catch {
        // Still-missing ids stay unresolved — callers already fall back to a placeholder.
      }
    }
  }
  return [...resultMap.values()];
}

async function fetchExchangesLive(ids: number[]): Promise<Map<number, string>> {
  const params = new URLSearchParams({ exchangeIds: ids.join(",") });
  const data = await etoroRequest<{
    exchangeInfo?: Array<{ exchangeID: number; exchangeDescription?: string }>;
  }>(`/api/v1/market-data/exchanges?${params}`);
  return new Map((data.exchangeInfo ?? []).map((item) => [
    item.exchangeID,
    item.exchangeDescription || `Giełda #${item.exchangeID}`,
  ]));
}

// Same indefinite cache as fetchInstruments, and for the same reason.
export async function fetchExchanges(exchangeIds: number[]): Promise<Map<number, string>> {
  const ids = [...new Set(exchangeIds)].filter(Number.isFinite);
  if (!ids.length) return new Map();
  const cachedEntries = await Promise.all(ids.map((id) => getState(`exchange:${id}`).catch(() => null)));
  const resultMap = new Map<number, string>();
  const missingIds: number[] = [];
  ids.forEach((id, index) => {
    const cached = cachedEntries[index];
    if (cached) resultMap.set(id, cached);
    else missingIds.push(id);
  });
  if (missingIds.length) {
    const known = await findKnownExchangeNames(missingIds).catch(() => new Map<number, string>());
    const stillMissing: number[] = [];
    for (const id of missingIds) {
      const name = known.get(id);
      if (name) {
        resultMap.set(id, name);
        await setState(`exchange:${id}`, name).catch(() => {});
      } else {
        stillMissing.push(id);
      }
    }
    if (stillMissing.length) {
      try {
        const fetched = await fetchExchangesLive(stillMissing);
        await Promise.all([...fetched.entries()].map(([id, name]) =>
          setState(`exchange:${id}`, name).catch(() => {}),
        ));
        for (const [id, name] of fetched) resultMap.set(id, name);
      } catch {
        // Still-missing ids stay unresolved — callers already fall back to a placeholder.
      }
    }
  }
  return resultMap;
}

async function fetchPublicHistoryFrom(
  cid: number,
  startDate: string,
): Promise<HistoricalPosition[]> {
  const cooldown = await cooldownRemainingMinutes(HISTORY_COOLDOWN_KEY);
  if (cooldown > 0) {
    throw new Error(`Historia eToro jest tymczasowo ograniczona. Spróbuj ponownie za ok. ${cooldown} min.`);
  }
  const positions = new Map<string, HistoricalPosition>();
  const startTime = `${startDate}T00:00:00Z`;
  for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
    const params = new URLSearchParams({
      CID: String(cid),
      StartTime: startTime,
      PageNumber: String(pageNumber),
      ItemsPerPage: "100",
    });
    const historyUrl = `https://www.etoro.com/sapi/trade-data-real/history/public/credit/flat?${params}`;
    const response = await fetch(historyUrl, {
      cache: "no-store",
      headers: {
        accept: "application/json",
        referer: "https://www.etoro.com/",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 429) {
      await markRateLimited(HISTORY_COOLDOWN_KEY, HISTORY_STRIKES_KEY);
      throw new Error("Historia eToro zwróciła błąd 429.");
    }
    if (!response.ok) {
      throw new Error(`Historia eToro zwróciła błąd ${response.status}.`);
    }
    await markRequestSucceeded(HISTORY_COOLDOWN_KEY, HISTORY_STRIKES_KEY);
    const data = await response.json() as {
      PublicHistoryPositions?: Array<{
        PositionID: number;
        OpenDateTime: string;
        OpenRate?: number;
        InstrumentID: number;
        IsBuy: boolean;
        CloseDateTime: string;
        CloseRate?: number;
        NetProfit?: number;
        Leverage?: number;
      }>;
    };
    const page = data.PublicHistoryPositions ?? [];
    for (const item of page) {
      positions.set(String(item.PositionID), {
        positionId: String(item.PositionID),
        openTimestamp: item.OpenDateTime,
        openRate: item.OpenRate ?? null,
        instrumentId: item.InstrumentID,
        isBuy: item.IsBuy,
        leverage: item.Leverage ?? null,
        closeTimestamp: item.CloseDateTime,
        closeRate: item.CloseRate ?? null,
        netProfit: item.NetProfit ?? null,
      });
    }
    if (page.length < 100) break;
  }
  return [...positions.values()];
}

async function withHistoryCache(
  cacheKey: string,
  ttlMs: number,
  load: () => Promise<HistoricalPosition[]>,
): Promise<HistoricalPosition[]> {
  const cached = await getStateWithTimestamp(cacheKey).catch(() => null);
  if (cached && Date.now() - new Date(cached.updated_at).getTime() < ttlMs) {
    return JSON.parse(cached.value) as HistoricalPosition[];
  }
  try {
    const positions = await load();
    await setState(cacheKey, JSON.stringify(positions)).catch(() => {});
    return positions;
  } catch (error) {
    // A stale cached copy beats no transaction data at all when eToro is rate-limiting us.
    if (cached) return JSON.parse(cached.value) as HistoricalPosition[];
    throw error;
  }
}

export async function fetchPublicHistory(
  cid: number,
  selectedDate: string,
): Promise<HistoricalPosition[]> {
  return withHistoryCache(`history:${cid}:${selectedDate}`, HISTORY_CACHE_TTL_MS, async () => {
    const positions = await fetchPublicHistoryFrom(cid, shiftDateKey(selectedDate, -1));
    return positions.filter((position) =>
      warsawDateKey(position.openTimestamp) === selectedDate ||
      warsawDateKey(position.closeTimestamp) === selectedDate);
  });
}

// Cache-only counterpart to fetchPublicHistory, for callers that must never
// block on eToro's live latency (the dashboard's request path — see
// app/api/dashboard/route.ts). lib/sync.ts's cron tick is the only thing
// that ever populates this cache via fetchPublicHistory; this just reads
// whatever's there (any age) instead of live-fetching on a miss. A request
// might occasionally show slightly-stale or momentarily-missing precise
// history for an investor the cron hasn't reached yet, but it always
// responds fast — bounded by a D1 read, not eToro's availability.
export async function getCachedPublicHistory(
  cid: number,
  selectedDate: string,
): Promise<{ positions: HistoricalPosition[]; cached: boolean }> {
  const cached = await getStateWithTimestamp(`history:${cid}:${selectedDate}`).catch(() => null);
  if (!cached) return { positions: [], cached: false };
  try {
    return { positions: JSON.parse(cached.value) as HistoricalPosition[], cached: true };
  } catch {
    return { positions: [], cached: false };
  }
}

export async function fetchRecentPublicHistory(
  cid: number,
): Promise<HistoricalPosition[]> {
  return withHistoryCache(
    `history-recent:${cid}`,
    RECENT_HISTORY_CACHE_TTL_MS,
    () => fetchPublicHistoryFrom(cid, shiftDateKey(warsawDateKey(), -90)),
  );
}

export async function fetchMarketRates(instrumentIds: number[]): Promise<MarketRate[]> {
  const ids = [...new Set(instrumentIds)].filter(Number.isFinite);
  if (!ids.length) return [];
  const chunks = Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) =>
    ids.slice(index * 100, index * 100 + 100),
  );
  const results = await Promise.all(chunks.map(async (chunk) => {
    const params = new URLSearchParams({ instrumentIds: chunk.join(",") });
    const data = await etoroRequest<{
      rates?: Array<{
        instrumentID?: number;
        instrumentId?: number;
        bid?: number;
        ask?: number;
        lastExecution?: number;
        date?: string;
      }>;
    }>(`/api/v1/market-data/instruments/rates?${params}`);
    return data.rates ?? [];
  }));
  return results.flat().map((item) => {
    const bid = item.bid ?? null;
    const ask = item.ask ?? null;
    const lastExecution = item.lastExecution ?? null;
    const currentRate = lastExecution ?? (bid != null && ask != null ? (bid + ask) / 2 : bid ?? ask);
    return {
      instrumentId: Number(item.instrumentID ?? item.instrumentId),
      bid,
      ask,
      lastExecution,
      currentRate: currentRate ?? null,
      rateAt: item.date ?? null,
    };
  }).filter((item) => Number.isFinite(item.instrumentId));
}

// eToro's /market-data/instrument-types list is short and effectively
// static (10 asset classes) — not worth a live call just to label
// topTradedAssetClassId, so it's hardcoded here instead.
const ASSET_CLASS_NAMES: Record<number, string> = {
  1: "Forex",
  2: "Surowce",
  3: "CFD",
  4: "Indeksy",
  5: "Akcje",
  6: "ETF",
  7: "Obligacje",
  8: "Fundusze",
  9: "Opcje",
  10: "Kryptowaluty",
};

// Extended, on-demand stats for a single investor's profile dialog — not
// part of the batch sync (lib/sync.ts), fetched only when a user actually
// opens that investor's portfolio, so the extra eToro requests are paced by
// real clicks rather than adding to the 27-investor background sync budget.
//
// profitableWeeksPct/profitableMonthsPct/peakToValley and
// weeksSinceRegistration are deliberately NOT surfaced here: verified
// directly against a known investor whose /gain history shows real negative
// months, these fields still come back as flat 0 (or, for
// weeksSinceRegistration, off from the investor's true registration date by
// years) — eToro's API returns them but they don't reflect reality, so
// showing them would just be confidently wrong.
type RawFeedResponse = {
  discussions?: Array<{
    id: string;
    post?: {
      owner?: { username?: string; avatar?: { medium?: string; small?: string } };
      created?: string;
      message?: { text?: string };
    };
    emotionsData?: { like?: { paging?: { totalCount?: number } } };
    summary?: { totalCommentsAndReplies?: number };
  }>;
};

function toFeedPosts(result: PromiseSettledResult<RawFeedResponse>): FeedPost[] {
  if (result.status !== "fulfilled") return [];
  return (result.value.discussions ?? []).flatMap((item) => {
    const post = item.post;
    if (!post?.owner?.username || !post.created || !post.message?.text) return [];
    return [{
      id: item.id,
      username: post.owner.username,
      avatarUrl: post.owner.avatar?.medium ?? post.owner.avatar?.small ?? null,
      createdAt: post.created,
      text: post.message.text,
      likes: item.emotionsData?.like?.paging?.totalCount ?? 0,
      comments: item.summary?.totalCommentsAndReplies ?? 0,
      authorGainYtd: null,
      authorGainTwoYears: null,
    }];
  });
}

// Adds each post author's own CurrYear/LastTwoYears gain (same tradeinfo
// endpoint resolveInvestors uses) so a reader can weigh a post against the
// poster's actual track record. Works for any eToro username, not just
// tracked investors — verified directly. Best-effort per author: one
// author's tradeinfo failing shouldn't blank out gains for every other post
// in the feed, so each lookup is individually caught. Deduplicated by
// username first since the same author often has multiple posts in one feed.
async function fetchAuthorGains(usernames: string[]): Promise<Map<string, { gainYtd: number | null; gainTwoYears: number | null }>> {
  const unique = [...new Set(usernames)];
  const entries = await mapWithConcurrency(unique, INVESTOR_REQUEST_CONCURRENCY, async (username) => {
    const [currentYear, lastTwoYears] = await Promise.all([
      etoroRequest<{ gain?: number }>(`/api/v1/user-info/people/${encodeURIComponent(username)}/tradeinfo?period=CurrYear`).catch(() => null),
      etoroRequest<{ gain?: number }>(`/api/v1/user-info/people/${encodeURIComponent(username)}/tradeinfo?period=LastTwoYears`).catch(() => null),
    ]);
    return [username, { gainYtd: currentYear?.gain ?? null, gainTwoYears: lastTwoYears?.gain ?? null }] as const;
  });
  return new Map(entries);
}


// eToro posts reference instruments as cashtags ($AAPL, $BRK.B, $SKHY) —
// Google Translate has no notion of these and will sometimes mangle them
// (translating a ticker that happens to spell a real word, or dropping the
// $). Swapped out for placeholder tokens unlikely to be touched by
// translation, then swapped back in after.
const TICKER_PATTERN = /\$[A-Za-z][A-Za-z0-9.]{0,9}/g;

export function protectTickers(text: string): { text: string; tickers: string[] } {
  const tickers: string[] = [];
  const protectedText = text.replace(TICKER_PATTERN, (match) => {
    tickers.push(match);
    return `⟦${tickers.length - 1}⟧`;
  });
  return { text: protectedText, tickers };
}

export function restoreTickers(text: string, tickers: string[]): string {
  return text.replace(/⟦\s*(\d+)\s*⟧/g, (_, index) => tickers[Number(index)] ?? "");
}

// eToro's own API has no translation endpoint, so this calls Google
// Translate's unofficial (undocumented, no API key required) single-string
// endpoint — the same one many open-source translation tools use. Best
// effort only: on any failure (network, unexpected shape, rate limit) the
// original text is kept rather than the post disappearing or erroring out
// the whole dialog. Trimmed to 1800 chars first to stay well under this
// endpoint's URL-length tolerance.
async function translateToPolish(text: string): Promise<string> {
  const { text: withPlaceholders, tickers } = protectTickers(text.slice(0, 1800));
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=pl&dt=t&q=${encodeURIComponent(withPlaceholders)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) return text;
    const data = (await response.json()) as [Array<[string, string]>] | null;
    const translated = data?.[0]?.map((segment) => segment[0]).join("");
    return translated ? restoreTickers(translated, tickers) : text;
  } catch {
    return text;
  }
}

async function translateFeedPosts(posts: FeedPost[]): Promise<FeedPost[]> {
  return Promise.all(posts.map(async (post) => ({ ...post, text: await translateToPolish(post.text) })));
}

// Translation and author-gain lookups touch entirely different fields
// (text vs. authorGainYtd/authorGainTwoYears), so they run concurrently
// rather than one waiting on the other.
async function hydrateFeedPosts(posts: FeedPost[]): Promise<FeedPost[]> {
  const [translated, gains] = await Promise.all([
    translateFeedPosts(posts),
    fetchAuthorGains(posts.map((post) => post.username)),
  ]);
  return translated.map((post) => {
    const gain = gains.get(post.username);
    return gain ? { ...post, authorGainYtd: gain.gainYtd, authorGainTwoYears: gain.gainTwoYears } : post;
  });
}

const RANK_PAGE_SIZE = 100;

type RankRow = {
  username: string;
  gain: number;
  annualizedReturn: number | null;
  fiveYearGain: number | null;
  weeksSinceRegistration: number | null;
};

// popularInvestor=true only ever covers 566 accounts — eToro's own
// complete "official PI" cohort, confirmed fixed across every period and
// not something more requests can grow. Several tracked investors are
// individually flagged isPopularInvestor:true on their own profile but
// aren't among those 566 (a real inconsistency in eToro's own data).
// copiersMin=7 instead: verified as a genuinely working, monotonically
// sorted filter (unlike gainMin), giving a ~1900-2100 account pool that
// rescues most of those cases while staying small enough to fully scan.
// The one case it still can't rescue is an investor with fewer than 7
// copiers (only leszekfx, at 2) — going lower would 10x+ the pool and the
// worst-case page-scan cost for very little gain.
const RANK_COPIERS_MIN = 7;

export async function fetchRankPage(page: number): Promise<{ rows: RankRow[]; totalItems: number | null }> {
  const data = await etoroRequest<{
    results?: Array<{
      username?: string;
      gain?: number;
      annualizedReturn?: number;
      fiveYearGain?: number;
      weeksSinceRegistration?: number;
    }>;
    pagination?: { totalItems?: number };
  }>(`/api/v2/portfolios/rankings?period=LastYear&sort=-gain&copiersMin=${RANK_COPIERS_MIN}&pageSize=${RANK_PAGE_SIZE}&page=${page}`);
  return {
    rows: (data.results ?? []).flatMap((row) => row.username ? [{
      username: row.username,
      gain: row.gain ?? 0,
      annualizedReturn: row.annualizedReturn != null ? row.annualizedReturn * 100 : null,
      fiveYearGain: row.fiveYearGain != null ? row.fiveYearGain * 100 : null,
      weeksSinceRegistration: row.weeksSinceRegistration ?? null,
    }] : []),
    totalItems: data.pagination?.totalItems ?? null,
  };
}

// A prior version of this function estimated where `gain` alone would sort
// within the pool via binary search. That looked reliable (verified against
// one known investor) but turned out not to be: `isPopularInvestor` on an
// investor's own profile and actual membership in the ranked list are
// different things — two investors (infinity-ai, mrmoire) each individually
// flagged as PIs were confirmed, by scanning every page, to not appear in
// the (then popularInvestor=true, 566-account) ranked list at all.
// Estimating a gain-based slot for a non-member produces a real-looking but
// fabricated number, and when two non-members' gains fall in the same gap
// between two actual members, they get the identical fabricated position —
// which is exactly the "some people have the same ranking" bug this
// replaces.
//
// This version only ever reports a position for a VERIFIED row: it scans
// pages in order (stopping as soon as the username is found) and returns
// null — "not ranked", surfaced honestly in the UI — for anyone who
// genuinely isn't in the pool, rather than guessing. Sequential (not
// parallel) on purpose: this already runs as a paced background step, and
// a burst of page requests is exactly the pattern that has tripped eToro's
// rate limiter before. `getPage` is injectable for unit testing against a
// fake in-memory pool.
//
// The matched row is returned too (annualizedReturn, fiveYearGain) — this
// scan already fetches that data for free, so resolveInvestors can skip a
// dedicated per-investor request for annualizedReturn. fiveYearGain is
// nulled out for accounts under 5 years old (weeksSinceRegistration < 260):
// verified directly that eToro still returns *some* fiveYearGain value for
// a 12-week-old account rather than leaving it blank, so age is the only
// way to tell a real figure from a meaningless one for a short-lived
// account.
export async function findExactRank(
  username: string,
  getPage: (page: number) => Promise<{ rows: RankRow[]; totalItems: number | null }> = fetchRankPage,
): Promise<{ position: number; poolSize: number; annualizedReturn: number | null; fiveYearGain: number | null } | null> {
  const target = username.toLowerCase();
  const first = await getPage(1).catch(() => null);
  if (!first || first.totalItems == null) return null;
  const poolSize = first.totalItems;
  const totalPages = Math.ceil(poolSize / RANK_PAGE_SIZE);

  const indexOf = (rows: RankRow[]) => rows.findIndex((row) => row.username.toLowerCase() === target);
  const toResult = (row: RankRow, position: number) => ({
    position,
    poolSize,
    annualizedReturn: row.annualizedReturn,
    fiveYearGain: (row.weeksSinceRegistration ?? 0) >= 260 ? row.fiveYearGain : null,
  });

  const foundOnFirst = indexOf(first.rows);
  if (foundOnFirst !== -1) return toResult(first.rows[foundOnFirst], foundOnFirst + 1);

  for (let page = 2; page <= totalPages; page++) {
    const data = await getPage(page).catch(() => null);
    if (!data) continue;
    const index = indexOf(data.rows);
    if (index !== -1) return toResult(data.rows[index], (page - 1) * RANK_PAGE_SIZE + index + 1);
  }
  return null;
}

// Turns a user-typed ticker or company name into eToro instrumentIds. eToro's
// /market-data/search takes a `fields` allowlist plus either an
// internalSymbolFull or displayname filter — both do prefix/substring
// matching (verified: "NVD" matches NVDA, NVDA.EUR, NVDY; "Nvidia" matches
// the same via displayname), but neither param matches across both symbol
// and name at once, so both are queried and merged. instrumentId can come
// back negative (a placeholder row, not a real instrument) — filtered out.
export async function searchInstruments(
  query: string,
): Promise<Array<{ instrumentId: number; symbol: string; displayName: string }>> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const fields = "instrumentId,internalSymbolFull,displayname";
  type SearchResponse = {
    items?: Array<{ instrumentId?: number; internalSymbolFull?: string; displayname?: string }>;
  };
  const [bySymbol, byName] = await Promise.all([
    etoroRequest<SearchResponse>(
      `/api/v1/market-data/search?${new URLSearchParams({ internalSymbolFull: trimmed, fields, pageSize: "10" })}`,
    ).catch(() => ({ items: [] }) as SearchResponse),
    etoroRequest<SearchResponse>(
      `/api/v1/market-data/search?${new URLSearchParams({ displayname: trimmed, fields, pageSize: "10" })}`,
    ).catch(() => ({ items: [] }) as SearchResponse),
  ]);
  const seen = new Map<number, { instrumentId: number; symbol: string; displayName: string }>();
  for (const item of [...(bySymbol.items ?? []), ...(byName.items ?? [])]) {
    if (item.instrumentId == null || item.instrumentId < 0 || !item.internalSymbolFull) continue;
    if (!seen.has(item.instrumentId)) {
      seen.set(item.instrumentId, {
        instrumentId: item.instrumentId,
        symbol: item.internalSymbolFull,
        displayName: item.displayname || item.internalSymbolFull,
      });
    }
  }
  return [...seen.values()].slice(0, 12);
}

// Same feed endpoint fetchInvestorExtendedStats uses for the "most traded
// instrument" discussion panel, exposed standalone so a user can look up
// discussion for any instrument by ticker/name, not just the ones already
// tied to a tracked investor's top holding.
export async function fetchInstrumentFeed(instrumentId: number, offset = 0): Promise<FeedPost[]> {
  const result = await etoroRequest<RawFeedResponse>(`/api/v1/feeds/instrument/${instrumentId}?take=10&offset=${offset}`)
    .then((value): PromiseSettledResult<RawFeedResponse> => ({ status: "fulfilled", value }))
    .catch((reason): PromiseSettledResult<RawFeedResponse> => ({ status: "rejected", reason }));
  return hydrateFeedPosts(toFeedPosts(result));
}

export async function fetchInvestorExtendedStats(username: string): Promise<InvestorExtendedStats> {
  // feeds/user takes the investor's gcid, NOT the realCID used everywhere
  // else in this app (portfolio, tradeinfo, rankings) — verified directly:
  // calling it with realCID always returns zero posts, even for an investor
  // with 25,000+ copiers who clearly posts regularly; gcid returns their
  // real feed. gcid isn't something callers of this function already have,
  // so it's looked up fresh here.
  const peopleLookup = await etoroRequest<{ users?: Array<{ username: string; gcid?: number }> }>(
    `/api/v1/user-info/people?usernames=${encodeURIComponent(username)}`,
  ).catch(() => null);
  const gcid = peopleLookup?.users?.find(
    (item) => item.username.toLowerCase() === username.toLowerCase(),
  )?.gcid;

  const [rankingResult, monthlyResult, yearlyResult, assetsResult, userPostsResult] = await Promise.allSettled([
    etoroRequest<{
      data?: {
        gain?: number;
        winRatio?: number;
        trades?: number;
        totalTradedInstruments?: number;
        avgPosSize?: number;
        annualizedReturn?: number;
        topTradedInstrumentId?: number;
        topTradedInstrumentPct?: number;
        topTradedAssetClassId?: number;
      };
    }>(`/api/v2/portfolios/${encodeURIComponent(username)}/rankings?period=LastYear`),
    etoroRequest<{ gains?: Array<{ date: string; gain: number }> }>(
      `/api/v2/portfolios/${encodeURIComponent(username)}/gain/monthly`,
    ),
    etoroRequest<{ gains?: Array<{ date: string; gain: number }> }>(
      `/api/v2/portfolios/${encodeURIComponent(username)}/gain/yearly?count=6`,
    ),
    etoroRequest<{
      results?: Array<{
        date: string;
        cashPct: number;
        assets?: Array<{ instrumentId: number; symbol: string; investedPct: number }>;
      }>;
    }>(`/api/v2/portfolios/${encodeURIComponent(username)}/assets/history?period=OneMonthAgo`),
    gcid != null
      ? etoroRequest<RawFeedResponse>(`/api/v1/feeds/user/${gcid}?take=5`)
      : Promise.reject(new Error("gcid nieznany")),
  ]);

  // rankings is the primary source for almost the entire scalar grid — if it
  // fails (rate limit, transient 5xx, etc.) there's no point returning a
  // payload of all-null fields that silently renders as a wall of "—" with
  // no indication anything went wrong. Fail loud instead so the dialog shows
  // a real error the user (and next debugging session) can actually see.
  if (rankingResult.status === "rejected") {
    const reason = rankingResult.reason;
    throw reason instanceof Error ? reason : new Error(String(reason));
  }
  const ranking = rankingResult.value.data ?? null;
  // eToro returns gain history oldest-first — kept as-is, since the yearly
  // bar chart reads left-to-right as oldest-to-newest and the monthly
  // heatmap re-buckets everything into a year/month grid regardless of
  // input order.
  const toGainPoints = (result: typeof monthlyResult): GainPoint[] =>
    result.status === "fulfilled"
      ? (result.value.gains ?? []).map((point) => ({ date: point.date, gain: point.gain * 100 }))
      : [];

  let topTradedInstrumentSymbol: string | null = null;
  let instrumentPosts: FeedPost[] = [];
  if (ranking?.topTradedInstrumentId != null) {
    const [instrument, instrumentFeedResult] = await Promise.all([
      fetchInstruments([ranking.topTradedInstrumentId]).catch(() => []),
      etoroRequest<RawFeedResponse>(`/api/v1/feeds/instrument/${ranking.topTradedInstrumentId}?take=5`)
        .then((value): PromiseSettledResult<RawFeedResponse> => ({ status: "fulfilled", value }))
        .catch((reason): PromiseSettledResult<RawFeedResponse> => ({ status: "rejected", reason })),
    ]);
    topTradedInstrumentSymbol = instrument[0]?.symbol ?? null;
    instrumentPosts = await hydrateFeedPosts(toFeedPosts(instrumentFeedResult));
  }

  // Rank within Popular Investors and annualizedReturn are NOT recomputed
  // here — they're already computed periodically in resolveInvestors() (see
  // that function's own comment on the binary-search approach) and stored
  // on the investor row, which the dialog already has in scope. Doing it
  // again per dialog-open would cost ~4-5 extra requests for a number this
  // codepath already has cheap access to.

  // The donut only ever shows the most recent day (a portfolio-composition
  // snapshot, not a trend), so only that last day needs computing — sorted
  // by actual size today (not summed over the whole month, which previously
  // let a since-sold position outrank what's actually held now), biggest
  // first. "Inne" stays last as the conventional catch-all regardless of
  // its own size.
  let assetAllocationHistory: AssetAllocationSeries = { labels: [], points: [] };
  if (assetsResult.status === "fulfilled") {
    const rawDays = assetsResult.value.results ?? [];
    const lastDay = rawDays[rawDays.length - 1];
    if (lastDay) {
      const assets = (lastDay.assets ?? []).filter((asset) => asset.symbol);
      const topAssets = [...assets].sort((a, b) => b.investedPct - a.investedPct).slice(0, 8);
      const topSum = topAssets.reduce((sum, asset) => sum + asset.investedPct, 0);
      const allSum = assets.reduce((sum, asset) => sum + asset.investedPct, 0);
      const otherPct = Math.max(0, allSum - topSum);
      const entries = [
        { label: "Gotówka", value: lastDay.cashPct },
        ...topAssets.map((asset) => ({ label: asset.symbol, value: asset.investedPct })),
      ].sort((a, b) => b.value - a.value);
      assetAllocationHistory = {
        labels: [...entries.map((entry) => entry.label), "Inne"],
        points: [{ date: lastDay.date, values: [...entries.map((entry) => entry.value * 100), otherPct * 100] }],
      };
    }
  }

  return {
    winRatio: ranking?.winRatio ?? null,
    trades: ranking?.trades ?? null,
    totalTradedInstruments: ranking?.totalTradedInstruments ?? null,
    avgPosSize: ranking?.avgPosSize ?? null,
    topTradedInstrumentId: ranking?.topTradedInstrumentId ?? null,
    topTradedInstrumentSymbol,
    topTradedInstrumentPct: ranking?.topTradedInstrumentPct ?? null,
    topTradedAssetClass: ranking?.topTradedAssetClassId != null
      ? ASSET_CLASS_NAMES[ranking.topTradedAssetClassId] ?? null
      : null,
    monthlyGains: toGainPoints(monthlyResult),
    yearlyGains: toGainPoints(yearlyResult),
    assetAllocationHistory,
    userPosts: await hydrateFeedPosts(toFeedPosts(userPostsResult)),
    instrumentPosts,
  };
}
