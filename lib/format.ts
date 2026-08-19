// Shared with app/Dashboard.tsx's own formatRate — same rounding convention,
// so a price quoted in a backend-generated note (e.g. an UPDATE/CLOSE
// event's description) reads identically to the same price shown elsewhere
// in the UI.
export function formatPrice(value: number | null): string {
  if (value == null) return "brak";
  return new Intl.NumberFormat("pl-PL", { maximumSignificantDigits: 8 }).format(value);
}
