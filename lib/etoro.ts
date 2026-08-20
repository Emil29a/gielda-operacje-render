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
      };
    },
  );
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
      const [currentYear, lastTwoYears, gainHistory] = await Promise.all([
        etoroRequest<TradeInfo>(`${tradeInfoPath}?period=CurrYear`),
        etoroRequest<TradeInfo>(`${tradeInfoPath}?period=LastTwoYears`),
        etoroRequest<{ monthly?: Array<{ timestamp: string }> }>(
          `/api/v1/user-info/people/${encodeURIComponent(username)}/gain`,
        ).catch(() => ({ monthly: [] })),
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
    }];
  });
}

export async function fetchInvestorExtendedStats(username: string, cid: number): Promise<InvestorExtendedStats> {
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
    etoroRequest<RawFeedResponse>(`/api/v1/feeds/user/${cid}?take=5`),
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
  // eToro returns gain history oldest-first; reversed here so both the
  // yearly and monthly chip rows read newest-first, matching the rest of
  // the dashboard's "most recent first" convention.
  const toGainPoints = (result: typeof monthlyResult): GainPoint[] =>
    result.status === "fulfilled"
      ? (result.value.gains ?? []).map((point) => ({ date: point.date, gain: point.gain * 100 })).reverse()
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
    instrumentPosts = toFeedPosts(instrumentFeedResult);
  }

  // Position within the Popular Investor cohort: the list endpoint never
  // returns a rank number directly, but it does return `pagination.totalItems`
  // for a filtered query — so the pool size and "how many rank above this
  // investor" are each obtained with a single pageSize=1 request (reading
  // only the count, not the rows) instead of paging through the full list.
  // Restricted to popularInvestor=true — the unfiltered pool is ~3.5 million
  // accounts (mostly inactive/demo), which would make any percentile
  // meaningless; Popular Investors (roughly 500-600) are the only cohort
  // this comparison is actually useful against.
  let rankPosition: number | null = null;
  let rankPoolSize: number | null = null;
  let rankPeriodLabel: string | null = null;
  const resolveRank = async (period: "LastYear" | "LastTwoYears", gain: number) => {
    const rankingsPath = `/api/v2/portfolios/rankings?period=${period}&sort=-gain&popularInvestor=true&pageSize=1`;
    const [poolResult, aboveResult] = await Promise.allSettled([
      etoroRequest<{ pagination?: { totalItems?: number } }>(rankingsPath),
      etoroRequest<{ pagination?: { totalItems?: number } }>(`${rankingsPath}&gainMin=${gain + 0.0001}`),
    ]);
    const pool = poolResult.status === "fulfilled" ? poolResult.value.pagination?.totalItems ?? null : null;
    const above = aboveResult.status === "fulfilled" ? aboveResult.value.pagination?.totalItems ?? null : null;
    return pool != null && above != null ? { position: above + 1, pool } : null;
  };
  if (ranking?.gain != null) {
    const lastYear = await resolveRank("LastYear", ranking.gain);
    if (lastYear) {
      rankPosition = lastYear.position;
      rankPoolSize = lastYear.pool;
      rankPeriodLabel = "rok";
    } else {
      // Not every tracked investor is a currently-active Popular Investor —
      // a demoted or newly-onboarded account can fall entirely outside the
      // LastYear PI pool. Falling back to a 2-year window gives most of
      // those investors SOME comparison instead of a flat "not available".
      // Needs the investor's own 2-year gain (a different number from the
      // 1-year `ranking.gain` above) — one extra single-row lookup, only
      // spent on this rarer fallback path.
      const twoYearResult = await etoroRequest<{ data?: { gain?: number } }>(
        `/api/v2/portfolios/${encodeURIComponent(username)}/rankings?period=LastTwoYears`,
      ).catch(() => null);
      const twoYearGain = twoYearResult?.data?.gain;
      const lastTwoYears = twoYearGain != null ? await resolveRank("LastTwoYears", twoYearGain) : null;
      if (lastTwoYears) {
        rankPosition = lastTwoYears.position;
        rankPoolSize = lastTwoYears.pool;
        rankPeriodLabel = "2 lata";
      }
    }
  }

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
    annualizedReturn: ranking?.annualizedReturn != null ? ranking.annualizedReturn * 100 : null,
    topTradedInstrumentId: ranking?.topTradedInstrumentId ?? null,
    topTradedInstrumentSymbol,
    topTradedInstrumentPct: ranking?.topTradedInstrumentPct ?? null,
    topTradedAssetClass: ranking?.topTradedAssetClassId != null
      ? ASSET_CLASS_NAMES[ranking.topTradedAssetClassId] ?? null
      : null,
    monthlyGains: toGainPoints(monthlyResult),
    yearlyGains: toGainPoints(yearlyResult),
    assetAllocationHistory,
    rankPosition,
    rankPoolSize,
    rankPeriodLabel,
    userPosts: toFeedPosts(userPostsResult),
    instrumentPosts,
  };
}
