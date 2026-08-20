// Shared with app/Dashboard.tsx's own formatRate — same rounding convention,
// so a price quoted in a backend-generated note (e.g. an UPDATE/CLOSE
// event's description) reads identically to the same price shown elsewhere
// in the UI.
export function formatPrice(value: number | null): string {
  if (value == null) return "brak";
  return new Intl.NumberFormat("pl-PL", { maximumSignificantDigits: 8 }).format(value);
}

// "483rd of 566 by gain" is easy to misread as good even when it's near the
// bottom of the pool — this instead expresses it as "better than X% of
// peers", where the direction can't be misread. position is 1-based (1 =
// best); the investor at the very back of the pool (position === poolSize)
// scores 0%.
export function betterThanPct(position: number, poolSize: number): number {
  if (poolSize <= 0) return 0;
  return Math.max(0, Math.round((1 - position / poolSize) * 100));
}
