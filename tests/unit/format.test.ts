import assert from "node:assert/strict";
import test from "node:test";
import { formatPrice } from "../../lib/format";

test("formatPrice: null renders as the Polish placeholder", () => {
  assert.equal(formatPrice(null), "brak");
});

test("formatPrice: formats using Polish locale grouping", () => {
  assert.equal(formatPrice(1234.5), "1234,5");
});
