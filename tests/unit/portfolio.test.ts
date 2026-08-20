import assert from "node:assert/strict";
import test from "node:test";
import { consolidatePositions } from "../../lib/portfolio";
import type { CurrentPortfolioPosition } from "../../lib/types";

function position(overrides: Partial<CurrentPortfolioPosition> & { positionId: string }): CurrentPortfolioPosition {
  return {
    positionId: overrides.positionId,
    openTimestamp: "2026-01-01T00:00:00.000Z",
    openRate: 100,
    instrumentId: 1,
    isBuy: true,
    leverage: 1,
    investmentPct: 10,
    netProfit: 0,
    takeProfitRate: null,
    stopLossRate: null,
    symbol: "TEST",
    displayName: "Test Instrument",
    exchangeId: null,
    exchangeName: null,
    logoUrl: null,
    username: "trader",
    observedAt: "2026-01-01T00:00:00.000Z",
    currentRate: null,
    currentRateAt: null,
    priceChangePct: null,
    priceDirection: "unknown",
    quoteStatus: "unavailable",
    ...overrides,
  };
}

test("leaves a lone position untouched with mergedCount 1", () => {
  const [result] = consolidatePositions([position({ positionId: "1" })]);
  assert.equal(result.mergedCount, 1);
  assert.equal(result.positionId, "1");
  assert.equal(result.firstOpenTimestamp, result.openTimestamp);
});

test("merges same instrument + same direction, weighting the average entry price by investmentPct", () => {
  const [result] = consolidatePositions([
    position({ positionId: "a", openRate: 100, investmentPct: 10, openTimestamp: "2026-01-01T00:00:00.000Z" }),
    position({ positionId: "b", openRate: 200, investmentPct: 30, openTimestamp: "2026-01-05T00:00:00.000Z" }),
  ]);
  assert.equal(result.mergedCount, 2);
  // weighted average: (100*10 + 200*30) / (10+30) = 175
  assert.equal(result.openRate, 175);
  assert.equal(result.investmentPct, 40);
});

test("keeps the newest open as the headline date and the oldest as firstOpenTimestamp", () => {
  const [result] = consolidatePositions([
    position({ positionId: "a", openTimestamp: "2026-01-01T00:00:00.000Z" }),
    position({ positionId: "b", openTimestamp: "2026-03-01T00:00:00.000Z" }),
    position({ positionId: "c", openTimestamp: "2026-02-01T00:00:00.000Z" }),
  ]);
  assert.equal(result.openTimestamp, "2026-03-01T00:00:00.000Z");
  assert.equal(result.firstOpenTimestamp, "2026-01-01T00:00:00.000Z");
});

test("keeps long and short positions in the same instrument as separate rows", () => {
  const result = consolidatePositions([
    position({ positionId: "long", instrumentId: 5, isBuy: true }),
    position({ positionId: "short", instrumentId: 5, isBuy: false }),
  ]);
  assert.equal(result.length, 2);
  assert.ok(result.every((row) => row.mergedCount === 1));
});

test("skips a null-valued field instead of treating it as zero in the weighted average", () => {
  const [result] = consolidatePositions([
    position({ positionId: "a", netProfit: 10, investmentPct: 10 }),
    position({ positionId: "b", netProfit: null, investmentPct: 10 }),
  ]);
  // only the non-null entry should count toward the average
  assert.equal(result.netProfit, 10);
});

test("recomputes priceChangePct/priceDirection from the weighted openRate instead of copying group[0]'s", () => {
  const [result] = consolidatePositions([
    // group[0]: opened far from the current price — if its own priceChangePct/
    // priceDirection were kept as-is (the bug), the merged row would show a
    // number that doesn't correspond to the weighted openRate below it.
    position({ positionId: "a", openRate: 50, investmentPct: 10, currentRate: 100, priceChangePct: 100, priceDirection: "up" }),
    position({ positionId: "b", openRate: 150, investmentPct: 10, currentRate: 100, priceChangePct: -33.33, priceDirection: "down" }),
  ]);
  // weighted openRate: (50*10 + 150*10) / 20 = 100, vs currentRate 100 → 0% change, flat
  assert.equal(result.openRate, 100);
  assert.equal(result.priceChangePct, 0);
  assert.equal(result.priceDirection, "flat");
});

test("sorts the consolidated output by most recent open date first", () => {
  const result = consolidatePositions([
    position({ positionId: "a", instrumentId: 1, openTimestamp: "2026-01-01T00:00:00.000Z" }),
    position({ positionId: "b", instrumentId: 2, openTimestamp: "2026-03-01T00:00:00.000Z" }),
    position({ positionId: "c", instrumentId: 3, openTimestamp: "2026-02-01T00:00:00.000Z" }),
  ]);
  assert.deepEqual(result.map((row) => row.instrumentId), [2, 3, 1]);
});
