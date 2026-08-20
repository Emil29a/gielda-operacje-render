import assert from "node:assert/strict";
import test from "node:test";
import { resolveReliableRank } from "../../lib/etoro";

const PAGE_SIZE = 100;

// Builds a fake 566-investor pool (matching the real pool size observed
// this session) with strictly descending gains, split into pages the same
// way the real API does, so the binary search under test sees the exact
// page-boundary shape it has to handle in production.
function fakePool(size: number) {
  const gains = Array.from({ length: size }, (_, i) => Math.round((size - i) * 10) / 10);
  return async (page: number) => {
    const start = (page - 1) * PAGE_SIZE;
    return {
      gains: gains.slice(start, start + PAGE_SIZE),
      totalItems: size,
    };
  };
}

test("finds position 1 for a gain at or above the very top", async () => {
  const result = await resolveReliableRank(9999, fakePool(566));
  assert.deepEqual(result, { position: 1, poolSize: 566 });
});

test("finds the exact position for a gain within the first page", async () => {
  // gains[49] = 566 - 49 = 517 -> position 50
  const result = await resolveReliableRank(517, fakePool(566));
  assert.deepEqual(result, { position: 50, poolSize: 566 });
});

test("finds a position on a middle page via binary search", async () => {
  // page 3 covers positions 201-300; gains[250] = 566-250 = 316 -> position 251
  const result = await resolveReliableRank(316, fakePool(566));
  assert.deepEqual(result, { position: 251, poolSize: 566 });
});

test("finds a position on the last (partial, 66-row) page", async () => {
  // gains[565] = 566-565 = 1 -> last position, 566
  const result = await resolveReliableRank(1, fakePool(566));
  assert.deepEqual(result, { position: 566, poolSize: 566 });
});

test("a gain below everyone in the pool ranks last", async () => {
  const result = await resolveReliableRank(-100, fakePool(566));
  assert.deepEqual(result, { position: 566, poolSize: 566 });
});

test("a tied gain resolves to the first matching row", async () => {
  const pool = async (page: number) => {
    if (page === 1) return { gains: [10, 8, 8, 8, 5], totalItems: 5 };
    return { gains: [], totalItems: 5 };
  };
  // three-way tie at 8, spanning positions 2-4 -> ties resolve to position 2
  const result = await resolveReliableRank(8, pool);
  assert.deepEqual(result, { position: 2, poolSize: 5 });
});

test("returns null when the pool can't be fetched at all", async () => {
  const failing = async () => { throw new Error("network down"); };
  const result = await resolveReliableRank(50, failing);
  assert.equal(result, null);
});
