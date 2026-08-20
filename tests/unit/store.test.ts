import assert from "node:assert/strict";
import test from "node:test";
import { describeChange } from "../../lib/store";
import type { StoredPosition } from "../../lib/store";
import type { PortfolioPosition } from "../../lib/types";

function stored(overrides: Partial<StoredPosition> = {}): StoredPosition {
  return {
    positionId: "1",
    openTimestamp: "2026-01-01T00:00:00.000Z",
    openRate: 100,
    instrumentId: 1,
    isBuy: true,
    leverage: 2,
    investmentPct: 5,
    netProfit: 0,
    takeProfitRate: null,
    stopLossRate: null,
    username: "trader",
    observedAt: "2026-01-01T00:00:00.000Z",
    symbol: "TEST",
    displayName: "Test Instrument",
    exchangeId: null,
    exchangeName: null,
    ...overrides,
  };
}

function current(overrides: Partial<PortfolioPosition> = {}): PortfolioPosition {
  return {
    positionId: "1",
    openTimestamp: "2026-01-01T00:00:00.000Z",
    openRate: 100,
    instrumentId: 1,
    isBuy: true,
    leverage: 2,
    investmentPct: 5,
    netProfit: 0,
    takeProfitRate: null,
    stopLossRate: null,
    ...overrides,
  };
}

test("returns null when nothing crosses tolerance", () => {
  assert.equal(describeChange(stored(), current()), null);
});

test("ignores investmentPct noise below the 0.05 tolerance", () => {
  assert.equal(describeChange(stored({ investmentPct: 5 }), current({ investmentPct: 5.04 })), null);
});

test("reports investmentPct once it crosses the 0.05 tolerance", () => {
  const result = describeChange(stored({ investmentPct: 5 }), current({ investmentPct: 7.2 }));
  assert.match(result ?? "", /wielkość pozycji: 5\.00% → 7\.20%/);
});

test("reports a leverage change", () => {
  const result = describeChange(stored({ leverage: 2 }), current({ leverage: 3 }));
  assert.match(result ?? "", /dźwignia: 2x → 3x/);
});

test("reports a take-profit change with 4-decimal rate formatting", () => {
  const result = describeChange(
    stored({ takeProfitRate: 19.47 }),
    current({ takeProfitRate: 21 }),
  );
  assert.match(result ?? "", /take-profit: 19\.4700 → 21\.0000/);
});

test("reports a stop-loss change", () => {
  const result = describeChange(stored({ stopLossRate: null }), current({ stopLossRate: 15.5 }));
  assert.match(result ?? "", /stop-loss: brak → 15\.5000/);
});

test("reports a stop-loss being removed (value to null), not just null to value", () => {
  const result = describeChange(stored({ stopLossRate: 15.5 }), current({ stopLossRate: null }));
  assert.match(result ?? "", /stop-loss: 15\.5000 → brak/);
});

test("combines multiple simultaneous changes into one sentence", () => {
  const result = describeChange(
    stored({ leverage: 2, investmentPct: 5 }),
    current({ leverage: 3, investmentPct: 8 }),
  );
  assert.match(result ?? "", /wielkość pozycji:.*dźwignia:/);
  assert.ok(result?.startsWith("Zmieniono "));
  assert.ok(result?.endsWith("."));
});

test("does not fire on a leverage change smaller than the default 0.01 tolerance", () => {
  assert.equal(describeChange(stored({ leverage: 2 }), current({ leverage: 2.005 })), null);
});
