import assert from "node:assert/strict";
import test from "node:test";
import { protectTickers, restoreTickers } from "../../lib/etoro";

test("protects a single cashtag and restores it unchanged", () => {
  const { text, tickers } = protectTickers("I am bullish on $AAPL this quarter.");
  assert.equal(tickers.length, 1);
  assert.equal(tickers[0], "$AAPL");
  assert.doesNotMatch(text, /\$AAPL/);
  assert.equal(restoreTickers(text, tickers), "I am bullish on $AAPL this quarter.");
});

test("protects multiple cashtags including a dotted one (BRK.B) in order", () => {
  const original = "$SKHY $WDC $MU $SNDK $AMD $BRK.B all moved today.";
  const { text, tickers } = protectTickers(original);
  assert.deepEqual(tickers, ["$SKHY", "$WDC", "$MU", "$SNDK", "$AMD", "$BRK.B"]);
  assert.equal(restoreTickers(text, tickers), original);
});

test("leaves text with no cashtags untouched", () => {
  const original = "No tickers mentioned in this sentence at all.";
  const { text, tickers } = protectTickers(original);
  assert.equal(tickers.length, 0);
  assert.equal(text, original);
  assert.equal(restoreTickers(text, tickers), original);
});

test("survives a round trip even if translation reorders placeholder tokens", () => {
  const { text, tickers } = protectTickers("$AAPL is up, $GOOGL is down.");
  // simulate translation moving the second placeholder before the first
  const reordered = text.replace("⟦0⟧", "‹A›").replace("⟦1⟧", "⟦0⟧").replace("‹A›", "⟦1⟧");
  const restored = restoreTickers(reordered, tickers);
  assert.match(restored, /\$GOOGL/);
  assert.match(restored, /\$AAPL/);
});
