import {
  etoroMode,
  fetchExchanges,
  fetchInstruments,
  fetchPortfolio,
  fetchPublicHistory,
  HISTORY_CACHE_TTL_MS,
  resolveInvestorIdentities,
  resolveInvestors,
} from "./etoro";
import { warsawDateKey } from "./time";
import {
  ensureSchema,
  getState,
  getStatesWithTimestamps,
  listInvestors,
  replaceInvestors,
  setState,
  syncPositionsForInvestors,
  updateInvestors,
} from "./store";
import { hasTrackedUsernames, TRACKED_USERNAMES } from "./tracked-investors";
import type { Investor, PortfolioPosition } from "./types";

// Render runs this on a per-visit basis (see app/api/dashboard/route.ts),
// not a per-invocation-billed Cloudflare Worker with a Cron Trigger to
// chunk work around. The real constraint is purely eToro's own rate limit,
// which reacts to *burst* concurrency more than total volume over time — a
// batch of 5 profile resolutions (3 requests each = 15 at once) was enough
// to trip a 429 even though the total request count for a whole sync is
// unremarkable. Every fetch below stays deliberately low-concurrency and
// paced, in exchange for a full sync simply taking longer.
const PORTFOLIO_CONCURRENCY = 3;
const IDENTITY_CONCURRENCY = 3;
const PROFILE_CONCURRENCY = 2;
const HISTORY_CONCURRENCY = 3;
const BATCH_PAUSE_MS = 1_500;
// How many not-yet-identity-resolved investors to resolve per visit, and
// how many already-identified-but-stats-missing investors to enrich with
// full gain stats per visit — small on purpose, so a single page visit's
// request budget goes mostly to the journal-critical steps (portfolio sync,
// history) instead of being spent entirely on profile lookups. Convergence
// to "everyone fully resolved" happens gradually, over several visits.
const IDENTITY_BATCH_LIMIT = 15;
// Dialed back from 15: at 15 x 3 requests, this step alone was heavy enough
// that — stacked on top of the portfolio sync step immediately before it in
// the same tick — the combined total was repeatedly enough to draw a fresh
// 429 partway through, even with per-batch pacing on each step individually.
// A tripped cooldown here doesn't just stall this step: it also blocks the
// dashboard route's live instrument-name self-heal for the rest of that same
// request, which is why unresolved "#id" placeholders and this step's gaps
// tend to show up together. Smaller here means slower backlog convergence
// but a real chance of each tick actually finishing clean.
const FULL_PROFILE_BATCH_LIMIT = 6;
// A short gap between major steps, not just between batches within one —
// spreads the tick's total request volume out over more real time instead
// of the portfolio sync step's last request being immediately followed by
// the identity/profile steps' first one.
const STEP_GAP_MS = 2_000;
// The public-history endpoint turned out to have its own, much stricter
// rate limit than the rest of the API — verified directly: ~9 back-to-back
// fetchPublicHistory calls tripped a dedicated history cooldown lasting 45
// minutes (far longer than the general API cooldown's 8-45 min sliding
// scale), while every other step tolerated several times that volume. A
// burst of investors whose history has genuinely never been cached (e.g.
// a freshly-added batch) used to try to warm all of them in one tick; now
// it only live-fetches up to this many per tick, safely under the observed
// wall, and leaves the rest for the next tick(s) to pick up gradually.
const HISTORY_WARM_BATCH_LIMIT = 6;

const POSITION_SYNC_LOCK_TTL_MS = 5 * 60 * 1000;
const MIN_POSITION_SYNC_INTERVAL_MS = 90 * 1000;

async function pause(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// Runs resolver(batch) over usernames in small, paced batches — a failed
// batch (eToro's rate limit reacts to more than just this process, e.g.
// local dev and the deployed Render instance sharing the same investors)
// only costs that batch; the loop still moves on with whatever did resolve.
async function resolvePaced(
  usernames: string[],
  concurrency: number,
  resolver: (batch: string[], offset: number) => Promise<Investor[]>,
): Promise<Investor[]> {
  const resolved: Investor[] = [];
  for (let i = 0; i < usernames.length; i += concurrency) {
    const batch = usernames.slice(i, i + concurrency);
    try {
      resolved.push(...await resolver(batch, i));
    } catch (error) {
      console.error("[sync] resolve batch failed, continuing", error instanceof Error ? error.message : error);
    }
    if (i + concurrency < usernames.length) await pause(BATCH_PAUSE_MS);
  }
  return resolved;
}

// The journal (dziennik zmian) is driven entirely by position diffing here,
// keyed by username — it works for every investor regardless of whether
// their profile has been resolved yet, so this always runs first and gets
// first claim on the request budget.
async function syncPortfolios(investors: Investor[]) {
  // mapWithConcurrency alone bounds *instantaneous* concurrency to
  // PORTFOLIO_CONCURRENCY, but its worker pool pulls the next item the
  // moment any slot frees up — no pause between batches. That was fine at
  // 27 investors; grown to 39, a full tick's worth of back-to-back requests
  // was enough to draw a fresh 429 from eToro on its own, escalating the
  // shared cooldown even under otherwise reasonable pacing. Chunking into
  // explicit batches with the same BATCH_PAUSE_MS used by resolvePaced below
  // keeps this step's *sustained* rate in line with the rest of the sync,
  // not just its peak concurrency.
  const attempted: { investor: Investor; positions: PortfolioPosition[] | null }[] = [];
  const batches = chunkArray(investors, PORTFOLIO_CONCURRENCY);
  for (let i = 0; i < batches.length; i++) {
    const results = await Promise.all(batches[i].map(async (investor) => ({
      investor,
      // null (not []) on failure: an empty array would tell the diffing
      // logic in syncPositionsForInvestors "every position this investor
      // had just closed", which is wrong — a fetch failure means we simply
      // don't know their current state yet, not that it's now empty. Such
      // investors are filtered out below and left untouched this tick.
      positions: await fetchPortfolio(investor.username).catch((error) => {
        console.error(`[sync] portfolio fetch failed for ${investor.username}, skipping this tick`, error instanceof Error ? error.message : error);
        return null;
      }),
    })));
    attempted.push(...results);
    if (i + 1 < batches.length) await pause(BATCH_PAUSE_MS);
  }
  const portfolios = attempted.filter(
    (item): item is { investor: Investor; positions: NonNullable<typeof item.positions> } => item.positions !== null,
  );
  const instrumentIds = portfolios.flatMap(({ positions }) =>
    positions.map((position) => position.instrumentId),
  );
  const instrumentList = await fetchInstruments(instrumentIds).catch(() => []);
  const exchanges = await fetchExchanges(
    instrumentList.flatMap((item) => item.exchangeId == null ? [] : [item.exchangeId]),
  ).catch(() => new Map<number, string>());
  const instruments = new Map(instrumentList.map((item) => [item.instrumentId, {
    ...item,
    exchangeName: item.exchangeId == null ? null : exchanges.get(item.exchangeId) ?? null,
  }]));
  const observedAt = new Date().toISOString();
  await syncPositionsForInvestors(portfolios, instruments, observedAt);
}

// Warms lib/etoro.ts's D1 history cache for today for every given investor —
// paced the same way as everything else here. The dashboard route falls
// back to a live fetch for any investor whose cache this hasn't reached
// yet, so today's view is always complete even between visits; this is
// what keeps that fallback rare.
//
// A cheap batched read decides who actually still needs a live call (cache
// missing or older than HISTORY_CACHE_TTL_MS) before spending any request
// budget — most ticks this finds almost nobody, since a successful fetch
// keeps a given investor's entry fresh well past the next several ticks.
// The live-fetch count is then capped at HISTORY_WARM_BATCH_LIMIT: a
// investor whose cache has simply never been populated (e.g. right after
// being added to TRACKED_USERNAMES) used to mean every one of them tried a
// live fetch in the same tick, which is exactly the burst that tripped the
// history endpoint's own stricter rate limit. Whoever doesn't fit in this
// tick's budget converges over the next one(s) instead.
async function warmHistoryForToday(investors: Investor[]) {
  const today = warsawDateKey();
  const resolved = investors.filter((investor) => investor.cid !== 0);
  if (!resolved.length) return;

  const keys = resolved.map((investor) => `history:${investor.cid}:${today}`);
  const cached = await getStatesWithTimestamps(keys).catch(() => new Map<string, { value: string; updatedAt: string }>());
  const now = Date.now();
  const stale = resolved.filter((investor) => {
    const entry = cached.get(`history:${investor.cid}:${today}`);
    return !entry || now - new Date(entry.updatedAt).getTime() >= HISTORY_CACHE_TTL_MS;
  });
  const toWarm = stale.slice(0, HISTORY_WARM_BATCH_LIMIT);

  for (let i = 0; i < toWarm.length; i += HISTORY_CONCURRENCY) {
    const batch = toWarm.slice(i, i + HISTORY_CONCURRENCY);
    await Promise.all(batch.map((investor) => fetchPublicHistory(investor.cid, today).catch(() => [])));
    if (i + HISTORY_CONCURRENCY < toWarm.length) await pause(BATCH_PAUSE_MS);
  }
}

// Seeds tracked_investors with placeholder rows (or keeps existing ones) so
// syncPortfolios() and the rest always have something to work with — this
// never calls eToro, so it's free to run on every check.
export async function ensureBootstrapped(): Promise<{ investors: Investor[]; justBootstrapped: boolean }> {
  const investors = await listInvestors();
  const source = await getState("data_source");
  const needsBootstrap = source !== "etoro-live-own-positions-v2" || !hasTrackedUsernames(investors);
  if (!needsBootstrap) return { investors, justBootstrapped: false };

  const existingByUsername = new Map(investors.map((investor) => [investor.username.toLowerCase(), investor]));
  const seeded = TRACKED_USERNAMES.map((username, index) => {
    const existing = existingByUsername.get(username);
    return existing ?? {
      slot: index + 1,
      username,
      cid: 0,
      fullName: username,
      avatarUrl: null,
      riskScore: null,
      dailyGain: null,
      gainYtd: null,
      gainTwoYears: null,
      copiers: null,
      updatedAt: new Date(0).toISOString(),
      activeSince: null,
      annualizedReturn: null,
      fiveYearGain: null,
      rankPosition: null,
      rankPoolSize: null,
    };
  });
  await replaceInvestors(seeded, source !== "etoro-live-own-positions-v2");
  await setState("data_source", "etoro-live-own-positions-v2");
  return { investors: await listInvestors(), justBootstrapped: true };
}

// Runs on every dashboard visit for today (see app/api/dashboard/route.ts),
// locked/throttled (90s minimum interval) so rapid repeat visits are cheap
// no-ops instead of piling up eToro requests. Order matters here: the
// journal (positions/events) is the priority, so it goes first and always
// gets a chance to run even if eToro starts rate-limiting partway through —
// profile identity and gain-stat enrichment are lower priority and limited
// to a small batch per visit, converging gradually across many visits
// rather than trying (and risking a 429 on) everyone at once.
export async function synchronizePositionsOnly() {
  if (etoroMode() !== "live") return;
  await ensureSchema();
  let { investors } = await ensureBootstrapped();
  if (!investors.length) return;

  const [lockUntilRaw, lastSyncRaw] = await Promise.all([
    getState("position_sync_lock_until"),
    getState("last_position_sync"),
  ]);
  const now = Date.now();
  const lockedByOther = lockUntilRaw != null && new Date(lockUntilRaw).getTime() > now;
  const tooSoon = lastSyncRaw != null
    && now - new Date(lastSyncRaw).getTime() < MIN_POSITION_SYNC_INTERVAL_MS;
  if (lockedByOther || tooSoon) return;

  await setState("position_sync_lock_until", new Date(now + POSITION_SYNC_LOCK_TTL_MS).toISOString());
  try {
    // 1. The journal: works for everyone regardless of profile resolution.
    try {
      await syncPortfolios(investors);
      await setState("last_position_sync", new Date().toISOString());
    } catch (error) {
      console.error("[sync] portfolio sync step failed", error instanceof Error ? error.message : error);
    }
    await pause(STEP_GAP_MS);

    // 2. Cheap identity (cid/name/avatar) for a small batch of investors
    // that don't have it yet — 1 request each, unlocks history + display.
    const unidentified = investors.filter((investor) => investor.cid === 0).slice(0, IDENTITY_BATCH_LIMIT);
    if (unidentified.length) {
      const resolved = await resolvePaced(
        unidentified.map((investor) => investor.username),
        IDENTITY_CONCURRENCY,
        (batch, offset) => resolveInvestorIdentities(batch, offset),
      );
      if (resolved.length) await updateInvestors(resolved);
      investors = await listInvestors();
      await pause(STEP_GAP_MS);
    }

    // 3. Full profile (gain stats) for a small batch of already-identified
    // investors that are still missing it — 3 requests each, the most
    // expensive step, so it stays smallest and last.
    const missingStats = investors.filter(
      (investor) => investor.cid !== 0
        && (investor.gainYtd == null || investor.activeSince == null || investor.rankPosition == null || investor.fiveYearGain == null),
    ).slice(0, FULL_PROFILE_BATCH_LIMIT);
    if (missingStats.length) {
      const resolved = await resolvePaced(
        missingStats.map((investor) => investor.username),
        PROFILE_CONCURRENCY,
        (batch, offset) => resolveInvestors(batch, offset),
      );
      if (resolved.length) await updateInvestors(resolved);
      investors = await listInvestors();
      await pause(STEP_GAP_MS);
    }

    // 4. Today's precise history — also only for investors with a cid.
    try {
      await warmHistoryForToday(investors);
    } catch (error) {
      console.error("[sync] history warm step failed", error instanceof Error ? error.message : error);
    }
  } finally {
    await setState("position_sync_lock_until", new Date(0).toISOString()).catch(() => {});
  }
}
