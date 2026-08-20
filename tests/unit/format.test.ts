import assert from "node:assert/strict";
import test from "node:test";
import { betterThanPct, formatPrice } from "../../lib/format";

test("betterThanPct: first place beats everyone", () => {
  assert.equal(betterThanPct(1, 100), 99);
});

test("betterThanPct: last place beats nobody", () => {
  assert.equal(betterThanPct(100, 100), 0);
});

test("betterThanPct: matches the manually-verified real-world case (484 of 566)", () => {
  // Verified against leszekfx's actual eToro rankings position this session.
  assert.equal(betterThanPct(484, 566), 14);
});

test("betterThanPct: never goes negative for a position beyond the pool size", () => {
  assert.equal(betterThanPct(999, 566), 0);
});

test("betterThanPct: the sole member of a pool of 1 beats nobody, so scores 0", () => {
  assert.equal(betterThanPct(1, 1), 0);
});

test("formatPrice: null renders as the Polish placeholder", () => {
  assert.equal(formatPrice(null), "brak");
});

test("formatPrice: formats using Polish locale grouping", () => {
  assert.equal(formatPrice(1234.5), "1234,5");
});
