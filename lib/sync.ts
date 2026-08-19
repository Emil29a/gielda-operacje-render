import {
  etoroMode,
  fetchExchanges,
  fetchInstruments,
  fetchPortfolio,
  fetchPublicHistory,
  resolveInvestors,
} from "./etoro";
import { mapWithConcurrency } from "./concurrency";
import { warsawDateKey } from "./time";

const INVESTOR_REQUEST_CONCURRENCY = 5;
// Cloudflare Workers cap outbound fetches at 50 per invocation on the free
// plan. Resolving a profile costs 3 requests (people lookup + 2 tradeinfo
// periods), so refreshing all 27 tracked investors in one go (~81 requests)
// can never fit. Profiles are refreshed in small rotating chunks instead —
// spread the cost across many small, always-in-budget invocations rather
// than needing a bigger budget (a paid plan) or a single request that just
// fails.
const PROFILE_CHUNK_SIZE = 5;
// syncPortfolios's D1 writes are now batched (see syncPositionsForInvestors
// in lib/store.ts), but each investor still costs one fetchPortfolio()
// subrequest, and runScheduledSync also spends a chunk of budget resolving
// profiles AND warming today's history cache (see below) in the same
// invocation — so portfolios are refreshed in rotating chunks too, same
// rationale as PROFILE_CHUNK_SIZE above.
const POSITION_CHUNK_SIZE = 7;
// Several open tabs (or, on a future deployment, several visitors) can each
// independently decide "it's time to sync". Without a shared lock and a
// minimum interval, they'd pile up overlapping eToro request bursts instead
// of sharing one result — this makes these functions safe to call from
// anywhere, any number of times in parallel.
const POSITION_SYNC_LOCK_TTL_MS = 60 * 1000;
const MIN_POSITION_SYNC_INTERVAL_MS = 90 * 1000;
const PROFILE_SYNC_LOCK_TTL_MS = 60 * 1000;
import {
  ensureSchema,
  getState,
  listInvestors,
  replaceInvestors,
  setState,
  syncPositionsForInvestors,
  updateInvestors,
} from "./store";
import {
  hasTrackedUsernames,
  TRACKED_USERNAMES,
  trackedInvestorPlaceholders,
} from "./tracked-investors";
import type { Investor } from "./types";

async function syncPortfolios(investors: Investor[]) {
  const portfolios = await mapWithConcurrency(
    investors,
    INVESTOR_REQUEST_CONCURRENCY,
    async (investor) => ({
      investor,
      positions: await fetchPortfolio(investor.username),
    }),
  );
  const instrumentIds = portfolios.flatMap(({ positions }) =>
    positions.map((position) => position.instrumentId),
  );
  const instrumentList = await fetchInstruments(instrumentIds);
  const exchanges = await fetchExchanges(
    instrumentList.flatMap((item) => item.exchangeId == null ? [] : [item.exchangeId]),
  );
  const instruments = new Map(instrumentList.map((item) => [item.instrumentId, {
    ...item,
    exchangeName: item.exchangeId == null ? null : exchanges.get(item.exchangeId) ?? null,
  }]));
  const observedAt = new Date().toISOString();
  await syncPositionsForInvestors(portfolios, instruments, observedAt);
}

// Seeds tracked_investors with placeholder rows (or keeps existing ones) so
// syncPortfolios() and resolveProfileChunk() always have something to work
// with — this never calls eToro, so it's free to run on every check.
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
    };
  });
  await replaceInvestors(seeded, source !== "etoro-live-own-positions-v2");
  await setState("data_source", "etoro-live-own-positions-v2");
  return { investors: await listInvestors(), justBootstrapped: true };
}

// Refreshes one rotating slice of investor profiles (name, avatar, gains,
// copiers) per call, cycling through everyone over several calls instead of
// all at once — see PROFILE_CHUNK_SIZE above for why.
async function resolveProfileChunk(): Promise<void> {
  const [lockUntilRaw, cursorRaw] = await Promise.all([
    getState("profile_sync_lock_until"),
    getState("profile_resolve_cursor"),
  ]);
  const now = Date.now();
  if (lockUntilRaw != null && new Date(lockUntilRaw).getTime() > now) return;

  await setState("profile_sync_lock_until", new Date(now + PROFILE_SYNC_LOCK_TTL_MS).toISOString());
  try {
    const usernames = [...TRACKED_USERNAMES];
    const cursor = cursorRaw ? Number(cursorRaw) || 0 : 0;
    const startIndex = cursor % usernames.length;
    const chunk = usernames.slice(startIndex, startIndex + PROFILE_CHUNK_SIZE);
    const wrapCount = PROFILE_CHUNK_SIZE - chunk.length;
    const wrapped = wrapCount > 0 ? usernames.slice(0, wrapCount) : [];

    const [resolvedChunk, resolvedWrapped] = await Promise.all([
      chunk.length ? resolveInvestors(chunk, startIndex) : Promise.resolve([]),
      wrapped.length ? resolveInvestors(wrapped, 0) : Promise.resolve([]),
    ]);
    const resolved = [...resolvedChunk, ...resolvedWrapped];
    if (resolved.length) await updateInvestors(resolved);
    await setState("profile_resolve_cursor", String((startIndex + PROFILE_CHUNK_SIZE) % usernames.length));
  } finally {
    await setState("profile_sync_lock_until", new Date(0).toISOString()).catch(() => {});
  }
}

// Silent, lightweight refresh of just today's position snapshots — driven by
// someone actually viewing today's data, or an explicit "Odśwież teraz"
// click, never a hidden background timer, and never surfaced as a "sync
// failed" notice since it's opportunistic.
export async function synchronizePositionsOnly() {
  if (etoroMode() !== "live") return;
  await ensureSchema();
  const { investors } = await ensureBootstrapped();
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
    await syncPortfolios(investors);
    await setState("last_position_sync", new Date().toISOString());
  } finally {
    await setState("position_sync_lock_until", new Date(0).toISOString()).catch(() => {});
  }
}

// Entry point for the Cloudflare Cron Trigger (see worker/index.ts's
// `scheduled` handler) — runs every few minutes, on Cloudflare's own
// infrastructure, never in the browser. Each tick refreshes one rotating
// chunk of investors' portfolios (POSITION_CHUNK_SIZE) plus one profile
// chunk (PROFILE_CHUNK_SIZE) — comfortably under the free plan's
// 50-per-invocation cap on both outbound fetches and D1/binding calls,
// unlike trying to sync everyone in a single tick.
export async function runScheduledSync() {
  await ensureSchema();
  const mode = etoroMode();
  if (mode === "unconfigured") {
    const investors = await listInvestors();
    const source = await getState("data_source");
    if (source !== "awaiting-etoro-keys" || !hasTrackedUsernames(investors)) {
      await replaceInvestors(trackedInvestorPlaceholders(), true);
      await setState("data_source", "awaiting-etoro-keys");
    }
    return;
  }
  const { investors } = await ensureBootstrapped();
  if (!investors.length) return;

  const cursorRaw = await getState("position_sync_cursor");
  const cursor = cursorRaw ? Number(cursorRaw) || 0 : 0;
  const startIndex = cursor % investors.length;
  const chunk = investors.slice(startIndex, startIndex + POSITION_CHUNK_SIZE);
  const wrapCount = POSITION_CHUNK_SIZE - chunk.length;
  const wrapped = wrapCount > 0 ? investors.slice(0, wrapCount) : [];

  const positionChunk = [...chunk, ...wrapped];
  await syncPortfolios(positionChunk);
  await setState("position_sync_cursor", String((startIndex + POSITION_CHUNK_SIZE) % investors.length));
  await setState("last_position_sync", new Date().toISOString());

  // Warms lib/etoro.ts's D1 history cache (3 min TTL, same as this cron
  // interval) for today, for the same investors just portfolio-synced. Real
  // dashboard visits are sporadic, not every 3 minutes, so without this the
  // cache is cold on nearly every visit and each one triggers a live,
  // 27-investor fan-out to eToro's history endpoint directly in the request
  // path — that was the main source of the slow/hanging dashboard loads
  // (Cloudflare error 1102 / request cancellations) even after adding
  // per-call timeouts. Warming it here means a real visit almost always
  // finds a fresh cache entry instead.
  const today = warsawDateKey();
  await mapWithConcurrency(
    positionChunk.filter((investor) => investor.cid !== 0),
    INVESTOR_REQUEST_CONCURRENCY,
    (investor) => fetchPublicHistory(investor.cid, today).catch(() => []),
  );

  await resolveProfileChunk();
}
