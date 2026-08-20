import type { CurrentPortfolioPosition } from "./types";

export type ConsolidatedPosition = CurrentPortfolioPosition & { mergedCount: number; firstOpenTimestamp: string };

// Mirrors lib/etoro.ts's priceChange() — duplicated rather than imported so
// this stays a small, dependency-free client function instead of pulling in
// etoro.ts's server-only eToro API client code into the browser bundle.
function priceChange(openRate: number | null, currentRate: number | null) {
  if (openRate == null || currentRate == null || openRate === 0) {
    return { priceChangePct: null as number | null, priceDirection: "unknown" as const };
  }
  const priceChangePct = ((currentRate - openRate) / openRate) * 100;
  const priceDirection = Math.abs(priceChangePct) < 0.005
    ? ("flat" as const)
    : priceChangePct > 0 ? ("up" as const) : ("down" as const);
  return { priceChangePct, priceDirection };
}

// Same instrument, same direction (long vs short kept separate — merging
// them would hide a hedge as if it netted out) gets combined into one row:
// average entry price and average return weighted by each position's
// portfolio share (investmentPct) — the standard "average cost / weighted
// return" a broker's own portfolio view shows, rather than every single
// trade listed as its own line.
export function consolidatePositions(positions: CurrentPortfolioPosition[]): ConsolidatedPosition[] {
  const groups = new Map<string, CurrentPortfolioPosition[]>();
  for (const position of positions) {
    const key = `${position.instrumentId}:${position.isBuy}`;
    const list = groups.get(key);
    if (list) list.push(position);
    else groups.set(key, [position]);
  }
  const consolidated = [...groups.values()].map((group) => {
    if (group.length === 1) return { ...group[0], mergedCount: 1, firstOpenTimestamp: group[0].openTimestamp };
    const weightOf = (position: CurrentPortfolioPosition) => position.investmentPct ?? 1;
    const weightedAverage = (getValue: (position: CurrentPortfolioPosition) => number | null) => {
      let weightedSum = 0;
      let weightTotal = 0;
      for (const position of group) {
        const value = getValue(position);
        if (value == null) continue;
        const weight = weightOf(position);
        weightedSum += value * weight;
        weightTotal += weight;
      }
      return weightTotal > 0 ? weightedSum / weightTotal : null;
    };
    const totalInvestmentPct = group.reduce((sum, position) => sum + (position.investmentPct ?? 0), 0);
    const newestOpen = group.reduce((latest, position) =>
      new Date(position.openTimestamp) > new Date(latest.openTimestamp) ? position : latest);
    const oldestOpen = group.reduce((earliest, position) =>
      new Date(position.openTimestamp) < new Date(earliest.openTimestamp) ? position : earliest);
    const mergedOpenRate = weightedAverage((position) => position.openRate);
    // currentRate/currentRateAt/quoteStatus are per-instrument (from the
    // shared market quote), so identical across every position in this
    // group and safe to keep from group[0] — but priceChangePct/priceDirection
    // are each individual position's OWN openRate compared to that quote, so
    // just keeping group[0]'s would show a price move computed from one
    // arbitrary sub-position's entry price while netProfit/openRate above
    // reflect the whole group's weighted average — recomputed here so both
    // agree with the same weighted openRate.
    const { priceChangePct, priceDirection } = priceChange(mergedOpenRate, group[0].currentRate);
    return {
      ...group[0],
      positionId: group.map((position) => position.positionId).join(","),
      openTimestamp: newestOpen.openTimestamp,
      firstOpenTimestamp: oldestOpen.openTimestamp,
      openRate: mergedOpenRate,
      netProfit: weightedAverage((position) => position.netProfit),
      investmentPct: totalInvestmentPct || null,
      mergedCount: group.length,
      priceChangePct,
      priceDirection,
    };
  });
  consolidated.sort((a, b) => new Date(b.openTimestamp).getTime() - new Date(a.openTimestamp).getTime());
  return consolidated;
}
