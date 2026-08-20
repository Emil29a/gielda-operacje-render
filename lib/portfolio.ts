import type { CurrentPortfolioPosition } from "./types";

export type ConsolidatedPosition = CurrentPortfolioPosition & { mergedCount: number; firstOpenTimestamp: string };

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
    return {
      ...group[0],
      positionId: group.map((position) => position.positionId).join(","),
      openTimestamp: newestOpen.openTimestamp,
      firstOpenTimestamp: oldestOpen.openTimestamp,
      openRate: weightedAverage((position) => position.openRate),
      netProfit: weightedAverage((position) => position.netProfit),
      investmentPct: totalInvestmentPct || null,
      mergedCount: group.length,
    };
  });
  consolidated.sort((a, b) => new Date(b.openTimestamp).getTime() - new Date(a.openTimestamp).getTime());
  return consolidated;
}
