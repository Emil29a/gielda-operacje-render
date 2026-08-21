import assert from "node:assert/strict";
import test from "node:test";
import { findExactRank } from "../../lib/etoro";

const PAGE_SIZE = 100;

// Builds a fake pool of `size` real members (username u0..u{size-1}, strictly
// descending gains) split into pages the same way the real API does.
function fakePool(size: number) {
  const rows = Array.from({ length: size }, (_, i) => {
    const gain = Math.round((size - i) * 10) / 10;
    return {
      username: `u${i}`,
      gain,
      annualizedReturn: gain,
      fiveYearGain: gain * 2,
      weeksSinceRegistration: 300,
    };
  });
  return async (page: number) => {
    const start = (page - 1) * PAGE_SIZE;
    return { rows: rows.slice(start, start + PAGE_SIZE), totalItems: size };
  };
}

test("finds a member on the first page without needing to scan further", () => {
  const calls: number[] = [];
  const tracked = async (page: number) => { calls.push(page); return fakePool(566)(page); };
  return findExactRank("u49", tracked).then((result) => {
    assert.deepEqual(result, { position: 50, poolSize: 566, annualizedReturn: 517, fiveYearGain: 1034 });
    assert.deepEqual(calls, [1]);
  });
});

test("finds a member on a later page by scanning forward", async () => {
  const result = await findExactRank("u250", fakePool(566));
  assert.deepEqual(result, { position: 251, poolSize: 566, annualizedReturn: 316, fiveYearGain: 632 });
});

test("finds a member on the last (partial, 66-row) page", async () => {
  const result = await findExactRank("u565", fakePool(566));
  assert.deepEqual(result, { position: 566, poolSize: 566, annualizedReturn: 1, fiveYearGain: 2 });
});

test("is case-insensitive on username matching", async () => {
  const result = await findExactRank("U49", fakePool(566));
  assert.deepEqual(result, { position: 50, poolSize: 566, annualizedReturn: 517, fiveYearGain: 1034 });
});

test("nulls out fiveYearGain for an account under 5 years old", async () => {
  const rows = [{ username: "newbie", gain: 10, annualizedReturn: 10, fiveYearGain: 999, weeksSinceRegistration: 12 }];
  const getPage = async () => ({ rows, totalItems: 1 });
  const result = await findExactRank("newbie", getPage);
  assert.deepEqual(result, { position: 1, poolSize: 1, annualizedReturn: 10, fiveYearGain: null });
});

test("returns null (not a fabricated position) for a username never in the pool", async () => {
  const result = await findExactRank("not-a-real-member", fakePool(566));
  assert.equal(result, null);
});

test("two different non-members both return null instead of colliding on the same fake position", async () => {
  const pool = fakePool(566);
  const [a, b] = await Promise.all([
    findExactRank("infinity-ai-fake", pool),
    findExactRank("mrmoire-fake", pool),
  ]);
  assert.equal(a, null);
  assert.equal(b, null);
});

test("returns null when the pool can't be fetched at all", async () => {
  const failing = async () => { throw new Error("network down"); };
  const result = await findExactRank("u1", failing);
  assert.equal(result, null);
});
