import { fetchInvestorQualityMetrics, fetchInvestorQualityMetricsFromPool } from "../../../lib/etoro";
import type { InvestorQualityMetrics } from "../../../lib/etoro";
import { ensureSchema, getStateWithTimestamp, listInvestors, setState } from "../../../lib/store";

export const dynamic = "force-dynamic";

const CACHE_KEY = "investor_quality_v1";
const CACHE_TTL_MS = 60 * 60 * 1000;
// Two eToro requests per investor (see fetchInvestorQualityMetrics). Batched
// with an explicit pause between batches — plain concurrency-limiting alone
// (mapWithConcurrency's worker pool pulls the next item the instant a slot
// frees, no pause) was enough on its own to draw a fresh 429 partway through
// a ~39-investor sweep, same failure mode syncPositionsForInvestors had
// before it got the same fix.
const CONCURRENCY = 3;
const BATCH_PAUSE_MS = 1500;
// The pool-scan fallback below can add up to ~40 more sequential requests
// right after this sweep's own ~26 (39 investors ÷ 3 x 2 requests) — verified
// directly that running them back-to-back with no gap was, on its own,
// enough to draw a fresh 429 on the fallback's very first request even
// though the main sweep itself had just finished cleanly. This gap gives
// eToro's side a moment to breathe between the two.
const FALLBACK_GAP_MS = 4000;
// If a systemic failure (rate-limit cooldown tripped mid-sweep, etc.) wipes
// out most results, the run isn't trustworthy "nobody qualifies" data — it's
// a broken sweep that happens to look like one. Caching it would serve that
// false "nobody qualifies" answer to every visitor for the next hour, so a
// sweep this unreliable is discarded in favor of whatever was cached before.
const UNRELIABLE_NULL_FRACTION = 0.4;

async function pause(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export type InvestorQualityResult = {
  username: string;
  meetsCriteria: boolean;
  reasons: string[];
  metrics: InvestorQualityMetrics | null;
};

export type InvestorQualityPayload = {
  computedAt: string;
  results: InvestorQualityResult[];
};

function fmtPct(value: number | null) {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}

// Same 8 conditions worked out earlier against the statistical screen:
// 2yr gain 65-200%, YTD >=20%, risk <=6, high leverage <=10%, copiers >50,
// >=150 trades over 2 years, win ratio >=60%, and copiersGain > 0 (a
// simpler, honest stand-in for "copiers actually profit" — comparing the
// blended-tenure copiersGain figure directly against the investor's own
// multi-year headline gain turned out to reject almost everyone, since
// copiers who joined recently haven't captured that same multi-year run).
function evaluate(username: string, metrics: InvestorQualityMetrics | null): InvestorQualityResult {
  if (!metrics) {
    return { username, meetsCriteria: false, reasons: ["Brak danych z eToro"], metrics: null };
  }
  const reasons: string[] = [];
  if (metrics.gain2y == null || metrics.gain2y < 65 || metrics.gain2y > 200) {
    reasons.push(`Zwrot 2 lata poza 65–200% (${fmtPct(metrics.gain2y)})`);
  }
  if (metrics.ytd == null || metrics.ytd < 20) {
    reasons.push(`YTD poniżej 20% (${fmtPct(metrics.ytd)})`);
  }
  if (metrics.riskScore == null || metrics.riskScore > 6) {
    reasons.push(`Risk score powyżej 6 (${metrics.riskScore ?? "—"})`);
  }
  if (metrics.highLeveragePct == null || metrics.highLeveragePct > 10) {
    reasons.push(`Wysoka dźwignia powyżej 10% (${fmtPct(metrics.highLeveragePct)})`);
  }
  if (metrics.copiers == null || metrics.copiers <= 50) {
    reasons.push(`Kopiujących ${metrics.copiers ?? 0} (wymagane >50)`);
  }
  if (metrics.trades2y == null || metrics.trades2y < 150) {
    reasons.push(`Transakcji w 2 lata: ${metrics.trades2y ?? 0} (wymagane ≥150)`);
  }
  if (metrics.winRatio == null || metrics.winRatio < 60) {
    reasons.push(`Win ratio poniżej 60% (${fmtPct(metrics.winRatio)})`);
  }
  if (metrics.copiersGain == null || metrics.copiersGain <= 0) {
    reasons.push(`Kopiujący średnio na minusie (${fmtPct(metrics.copiersGain)})`);
  }
  return { username, meetsCriteria: reasons.length === 0, reasons, metrics };
}

export async function GET(request: Request) {
  try {
    await ensureSchema();
    const url = new URL(request.url);
    const forceRefresh = url.searchParams.get("refresh") === "1";
    const cached = await getStateWithTimestamp(CACHE_KEY).catch(() => null);
    if (!forceRefresh && cached && Date.now() - new Date(cached.updated_at).getTime() < CACHE_TTL_MS) {
      return Response.json(JSON.parse(cached.value) as InvestorQualityPayload, {
        headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
      });
    }

    const investors = await listInvestors();
    const results: InvestorQualityResult[] = [];
    const batches = chunkArray(investors, CONCURRENCY);
    for (let i = 0; i < batches.length; i++) {
      const batchResults = await Promise.all(batches[i].map(async (investor) => {
        const metrics = await fetchInvestorQualityMetrics(investor.username).catch(() => null);
        return evaluate(investor.username, metrics);
      }));
      results.push(...batchResults);
      if (i + 1 < batches.length) await pause(BATCH_PAUSE_MS);
    }

    const nullCount = results.filter((result) => result.metrics === null).length;
    const looksUnreliable = results.length > 0 && nullCount / results.length > UNRELIABLE_NULL_FRACTION;
    if (looksUnreliable && cached) {
      // Keep serving the last trustworthy sweep rather than overwrite it
      // with this one — cache timestamp is intentionally left untouched so
      // the next visit retries a fresh sweep instead of waiting out the TTL.
      return Response.json(JSON.parse(cached.value) as InvestorQualityPayload, {
        headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
      });
    }

    // A healthy-looking sweep can still leave a handful of genuinely new
    // accounts with no data — the per-investor endpoint just doesn't have
    // them indexed yet, verified separately from any rate-limit disruption
    // (that case was already ruled out above by looksUnreliable). The bulk
    // ranking pool these accounts were originally found through carries the
    // same fields, so one scan recovers all of them together rather than
    // leaving each permanently stuck on "no data".
    const stillMissing = results.filter((result) => result.metrics === null).map((result) => result.username);
    if (stillMissing.length) {
      await pause(FALLBACK_GAP_MS);
      const recovered = await fetchInvestorQualityMetricsFromPool(stillMissing).catch((error) => {
        console.error("[investor-quality] pool-scan fallback failed", error instanceof Error ? error.message : error);
        return new Map<string, InvestorQualityMetrics>();
      });
      if (recovered.size) {
        for (let i = 0; i < results.length; i++) {
          const metrics = recovered.get(results[i].username.toLowerCase());
          if (metrics) results[i] = evaluate(results[i].username, metrics);
        }
      }
    }

    const payload: InvestorQualityPayload = { computedAt: new Date().toISOString(), results };
    if (!looksUnreliable) await setState(CACHE_KEY, JSON.stringify(payload)).catch(() => {});
    return Response.json(payload, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Nie udało się sprawdzić wymagań inwestorów." },
      { status: 500 },
    );
  }
}
