import { fetchInvestorQualityMetrics } from "../../../lib/etoro";
import type { InvestorQualityMetrics } from "../../../lib/etoro";
import { ensureSchema, getStateWithTimestamp, listInvestors, setState } from "../../../lib/store";
import { mapWithConcurrency } from "../../../lib/concurrency";

export const dynamic = "force-dynamic";

const CACHE_KEY = "investor_quality_v1";
const CACHE_TTL_MS = 60 * 60 * 1000;
// Two eToro requests per investor (see fetchInvestorQualityMetrics), paced
// at this concurrency — the same order of magnitude as resolveInvestors'
// own per-investor fan-out, not the much heavier full-pool page scan that
// tripped the rate limiter earlier. Cached for an hour so repeat visits
// during that window are free D1 reads, not a live eToro round trip.
const CONCURRENCY = 4;

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
    const results = await mapWithConcurrency(investors, CONCURRENCY, async (investor) => {
      const metrics = await fetchInvestorQualityMetrics(investor.username).catch(() => null);
      return evaluate(investor.username, metrics);
    });

    const payload: InvestorQualityPayload = { computedAt: new Date().toISOString(), results };
    await setState(CACHE_KEY, JSON.stringify(payload)).catch(() => {});
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
