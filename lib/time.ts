const WARSAW_TIMEZONE = "Europe/Warsaw" as const;

export function warsawDateKey(value: string | Date = new Date()) {
  const date = typeof value === "string" ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: WARSAW_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function isValidDateKey(value: string | null) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

export function shiftDateKey(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12));
  return shifted.toISOString().slice(0, 10);
}

export function isWeekendDateKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

export function previousOrSameBusinessDateKey(value: string) {
  let result = value;
  while (isWeekendDateKey(result)) result = shiftDateKey(result, -1);
  return result;
}

export function shiftBusinessDateKey(value: string, days: number) {
  let result = value;
  let remaining = Math.abs(days);
  const step = days >= 0 ? 1 : -1;
  while (remaining > 0) {
    result = shiftDateKey(result, step);
    if (!isWeekendDateKey(result)) remaining -= 1;
  }
  return result;
}

export function formatWarsawMoment(value: string | null) {
  if (!value) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("pl-PL", {
    timeZone: WARSAW_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return `${parts.day}.${parts.month}.${parts.year}, ${parts.hour}:${parts.minute}:${parts.second}`;
}

export { WARSAW_TIMEZONE };
