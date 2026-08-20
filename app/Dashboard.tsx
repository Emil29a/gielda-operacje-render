"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssetAllocationSeries, CurrentPortfolioPosition, DashboardPayload, FeedPost, GainPoint, Investor, InvestorExtendedStats, TradeEvent } from "../lib/types";
import { consolidatePositions } from "../lib/portfolio";
import { betterThanPct } from "../lib/format";
import {
  formatWarsawMoment,
  isWeekendDateKey,
  previousOrSameBusinessDateKey,
  shiftBusinessDateKey,
  shiftDateKey,
  warsawDateKey,
} from "../lib/time";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "Nie udało się wykonać operacji.");
  return body;
}

function initials(value: string) {
  return value.split(/[\s_-]+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

function formatNumber(value: number | null | undefined) {
  return value == null
    ? "—"
    : new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 }).format(value);
}

function formatPercent(value: number | null | undefined, signed = false) {
  if (value == null) return "—";
  return `${signed && value > 0 ? "+" : ""}${new Intl.NumberFormat("pl-PL", {
    maximumFractionDigits: 2,
  }).format(value)}%`;
}

function formatRate(value: number | null | undefined) {
  if (value == null) return "—";
  return new Intl.NumberFormat("pl-PL", { maximumSignificantDigits: 8 }).format(value);
}

function formatRate2(value: number | null | undefined) {
  if (value == null) return "—";
  return new Intl.NumberFormat("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function formatTime(value: string | null, withSeconds = false) {
  if (!value) return "jeszcze nie";
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" as const } : {}),
  }).format(new Date(value));
}

function formatMoment(value: string | null) {
  return formatWarsawMoment(value) ?? "jeszcze nie";
}

function formatRecentMoment(value: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return `${parts.day}.${parts.month}.${parts.year}, ${parts.hour}:${parts.minute}`;
}

function formatQuickDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${day}.${month}.${year}`;
}

function formatDateOnly(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(value));
}

const POLISH_MONTHS = [
  "styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec",
  "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień",
];
const POLISH_WEEKDAYS = ["Pn", "Wt", "Śr", "Cz", "Pt"];

function shiftMonthKey(value: string, months: number) {
  const [year, month] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + months, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function PolishDatePicker({
  value,
  max,
  onChange,
}: {
  value: string;
  max: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => value.slice(0, 7));
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const [year, month] = visibleMonth.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const leadingEmptyDays = firstWeekday <= 4 ? firstWeekday : 0;
  const maxMonth = max.slice(0, 7);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function toggle() {
    setVisibleMonth(value.slice(0, 7));
    setOpen((current) => !current);
  }

  return (
    <div className="report-date-picker" ref={pickerRef}>
      <button
        type="button"
        className="report-date-trigger"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Wybierz datę dziennika. Obecnie ${formatQuickDate(value)}`}
      >
        <span>{formatQuickDate(value)}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 3v3M18 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1z" />
        </svg>
      </button>
      {open && (
        <div className="polish-calendar" role="dialog" aria-label="Kalendarz wyboru daty">
          <div className="calendar-heading">
            <button type="button" onClick={() => setVisibleMonth((current) => shiftMonthKey(current, -1))} aria-label="Poprzedni miesiąc">‹</button>
            <strong>{POLISH_MONTHS[month - 1]} {year}</strong>
            <button type="button" onClick={() => setVisibleMonth((current) => shiftMonthKey(current, 1))} disabled={visibleMonth >= maxMonth} aria-label="Następny miesiąc">›</button>
          </div>
          <div className="calendar-grid">
            {POLISH_WEEKDAYS.map((weekday) => <span className="calendar-weekday" key={weekday}>{weekday}</span>)}
            {Array.from({ length: leadingEmptyDays }, (_, index) => <span className="calendar-empty" key={`empty-${index}`} />)}
            {Array.from({ length: daysInMonth }, (_, index) => {
              const day = index + 1;
              const dateKey = `${visibleMonth}-${String(day).padStart(2, "0")}`;
              if (isWeekendDateKey(dateKey)) return null;
              return (
                <button
                  type="button"
                  key={dateKey}
                  className={dateKey === value ? "selected" : dateKey === max ? "today" : ""}
                  disabled={dateKey > max}
                  onClick={() => {
                    onChange(dateKey);
                    setOpen(false);
                  }}
                  aria-pressed={dateKey === value}
                  aria-label={`${day} ${POLISH_MONTHS[month - 1]} ${year}`}
                >
                  {day}
                </button>
              );
            })}
          </div>
          <button className="calendar-today" type="button" onClick={() => { onChange(max); setOpen(false); }}>Dzisiaj</button>
        </div>
      )}
    </div>
  );
}

function gainTone(value: number | null | undefined) {
  if (value == null) return "neutral";
  return value >= 0 ? "positive" : "negative";
}

function positionWord(count: number) {
  const lastTwo = count % 100;
  const last = count % 10;
  if (count === 1) return "pozycja";
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return "pozycje";
  return "pozycji";
}

type TradeEventGroup = {
  key: string;
  representative: TradeEvent;
  events: TradeEvent[];
};

type DaySummary = {
  key: string;
  event: TradeEvent;
  investors: Set<string>;
  positions: number;
  events: TradeEvent[];
};

type SummaryPerson = {
  username: string;
  events: TradeEvent[];
};

function groupTradeEvents(events: TradeEvent[]): TradeEventGroup[] {
  const groups = new Map<string, TradeEventGroup>();
  for (const event of events) {
    const key = [
      event.username.toLowerCase(),
      warsawDateKey(event.occurredAt),
      event.instrumentId,
      event.eventType,
      event.isBuy ? "buy" : "short",
    ].join(":");
    const group = groups.get(key);
    if (group) group.events.push(event);
    else groups.set(key, { key, representative: event, events: [event] });
  }
  return [...groups.values()];
}

function useScrollAvailability(
  ref: { current: HTMLDivElement | null },
  contentSize: number,
) {
  const [availability, setAvailability] = useState({ left: false, right: false });

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const update = () => {
      const maximum = Math.max(0, container.scrollWidth - container.clientWidth);
      const left = container.scrollLeft > 2;
      const right = container.scrollLeft < maximum - 2;
      setAvailability((previous) =>
        previous.left === left && previous.right === right ? previous : { left, right },
      );
    };
    const frame = window.requestAnimationFrame(update);
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(container);
    container.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      container.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [contentSize, ref]);

  return availability;
}

function InstrumentLogo({ logoUrl, symbol }: { logoUrl: string | null | undefined; symbol: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="instrument-logo" aria-hidden="true">
      {logoUrl && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" onError={() => setFailed(true)} />
      ) : <span>{symbol.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase()}</span>}
    </span>
  );
}

function TradeActionIcon({ event }: { event: TradeEvent }) {
  if (!event.isBuy) {
    return <span className="event-icon short" aria-hidden="true">S</span>;
  }
  if (event.eventType === "CLOSE") {
    return (
      <span className="event-icon sell" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M4 5.5h10l6 6-8.5 8.5-7.5-7.5z" />
          <circle cx="9" cy="10.5" r="1.25" />
          <path d="M11.5 15h5" />
        </svg>
      </span>
    );
  }
  if (event.eventType === "OPEN") {
    return (
      <span className="event-icon buy" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M3.5 4.5h2l2.1 10h9.2l2-7H6.2" />
          <path d="M12 7v5M9.5 9.5h5" />
          <circle cx="9" cy="18.5" r="1.2" /><circle cx="16" cy="18.5" r="1.2" />
        </svg>
      </span>
    );
  }
  return <span className="event-icon update" aria-hidden="true">↔</span>;
}

function PriceMovement({
  value,
  direction,
  currentRate,
  currentRateAt,
  quoteStatus,
  rateKind = "current",
  compact = false,
}: {
  value: number | null;
  direction: "up" | "down" | "flat" | "unknown";
  currentRate: number | null;
  currentRateAt: string | null;
  quoteStatus: "today" | "previous" | "unavailable";
  rateKind?: "current" | "closing";
  compact?: boolean;
}) {
  const isClosingRate = rateKind === "closing";
  const label = direction === "up"
    ? "Cena urosła"
    : direction === "down" ? "Cena spadła" : direction === "flat" ? "Bez zmiany" : "Brak kursu";
  return (
    <div className={`price-movement ${direction} ${compact ? "compact" : ""}`}>
      <small>{isClosingRate ? "Zmiana kursu do zamknięcia" : "Pomocnicza zmiana kursu"}</small>
      <strong>{formatPercent(value, true)}</strong>
      <span>{label}{currentRate != null ? ` · ${isClosingRate ? "kurs zamknięcia" : "teraz"} ${formatRate(currentRate)}` : ""}</span>
      {isClosingRate && currentRateAt && (
        <em className="quote-status closing">Zamknięto {formatMoment(currentRateAt)}</em>
      )}
      {!isClosingRate && quoteStatus === "today" && currentRateAt && (
        <em className="quote-status current">Kurs eToro z dzisiaj · {formatTime(currentRateAt, true)}</em>
      )}
      {!isClosingRate && quoteStatus === "previous" && currentRateAt && (
        <em className="quote-status closed">Rynek zamknięty lub brak dzisiejszego notowania · ostatni kurs {formatMoment(currentRateAt)}</em>
      )}
      {!isClosingRate && quoteStatus === "unavailable" && (
        <em className="quote-status closed">Brak aktualnego kursu z eToro — rynek może być zamknięty.</em>
      )}
    </div>
  );
}

function PositionReturn({
  value,
  closed = false,
  closedExact = false,
}: {
  value: number | null;
  closed?: boolean;
  closedExact?: boolean;
}) {
  return (
    <div className={`position-return ${gainTone(value)}`}>
      <small>{closedExact
        ? "Wynik zamknięcia według eToro"
        : closed ? "Ostatni wynik przed wykryciem zamknięcia" : "Wynik pozycji eToro (netProfit)"}</small>
      <strong>{formatPercent(value, true)}</strong>
      {closed && !closedExact && <span>Kurs i wynik dokładnie w chwili zamknięcia nie są dostępne w publicznym portfelu.</span>}
    </div>
  );
}

function GroupedPositionReturn({ events }: { events: TradeEvent[] }) {
  const event = events[0];
  return (
    <PositionReturn
      value={event.netProfit}
      closed={event.eventType === "CLOSE"}
      closedExact={event.eventType === "CLOSE" && event.precision === "exact" && event.closeRate != null}
    />
  );
}

function GroupedPriceMovement({ events }: { events: TradeEvent[] }) {
  const event = events[0];
  return (
    <PriceMovement
      value={event.priceChangePct}
      direction={event.priceDirection}
      currentRate={event.currentRate}
      currentRateAt={event.currentRateAt}
      quoteStatus={event.quoteStatus}
      rateKind={event.rateKind}
      compact
    />
  );
}

function eventLabel(event: TradeEvent) {
  if (!event.isBuy) {
    if (event.eventType === "OPEN") return "Otworzył short";
    if (event.eventType === "CLOSE") return "Zamknął short";
    return "Zmienił short";
  }
  if (event.eventType === "OPEN") return "Kupił";
  if (event.eventType === "CLOSE") return "Sprzedał";
  return "Zmienił pozycję";
}

function eventContext(event: TradeEvent) {
  // For CLOSE and UPDATE events, event.note carries real detail (when the
  // now-closed position was originally opened; exactly what changed for an
  // update) written by lib/store.ts and app/api/dashboard/route.ts — showing
  // that instead of a fixed generic label is the whole point of these
  // journal entries. OPEN events don't need it: the entry's own timestamp
  // already is the open date.
  if (!event.isBuy) {
    if (event.eventType === "OPEN") return "Otwarcie pozycji short";
    return event.note || (event.eventType === "CLOSE" ? "Zamknięcie pozycji short" : "Aktualizacja pozycji short");
  }
  if (event.eventType === "OPEN") return "Otwarcie pozycji";
  return event.note || (event.eventType === "CLOSE" ? "Zamknięcie pozycji" : "Aktualizacja pozycji");
}

function summaryAction(event: TradeEvent) {
  if (!event.isBuy) {
    if (event.eventType === "OPEN") return { label: "Short", tone: "short" };
    if (event.eventType === "CLOSE") return { label: "Zamknięcie shorta", tone: "short" };
    return { label: "Zmiana shorta", tone: "short" };
  }
  if (event.eventType === "OPEN") return { label: "Kupno", tone: "buy" };
  if (event.eventType === "CLOSE") return { label: "Sprzedaż", tone: "sell" };
  return { label: "Zmiana", tone: "update" };
}

function InvestorCard({
  investor,
  selected,
  onOpenPortfolio,
}: {
  investor: Investor;
  selected: boolean;
  onOpenPortfolio: () => void;
}) {
  const gainClass = (investor.dailyGain ?? 0) >= 0 ? "positive" : "negative";
  return (
    <article className={`investor-card ${selected ? "selected" : ""}`}>
      <button className="investor-main" type="button" onClick={onOpenPortfolio} aria-label={`Otwórz aktualny portfel ${investor.fullName}`}>
        <span className={`avatar avatar-${investor.slot}`}>
          {investor.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={investor.avatarUrl} alt={`Zdjęcie ${investor.fullName}`} />
          ) : <span aria-hidden="true">{initials(investor.username)}</span>}
        </span>
        <span className="investor-title">
          <span className="eyebrow">Inwestor {String(investor.slot).padStart(2, "0")}</span>
          <strong>@{investor.username}</strong>
          <span>{investor.fullName}</span>
        </span>
        <span className={`daily-gain ${gainClass}`}>
          {formatPercent(investor.dailyGain, true)}
          <small>ostatni dzień</small>
        </span>
      </button>
      <div className="investor-returns" aria-label={`Stopy zwrotu ${investor.fullName} według eToro`}>
        <span>
          <small>Od początku roku</small>
          <strong className={gainTone(investor.gainYtd)}>{formatPercent(investor.gainYtd, true)}</strong>
        </span>
        <span>
          <small>Ostatnie 2 lata</small>
          <strong className={gainTone(investor.gainTwoYears)}>{formatPercent(investor.gainTwoYears, true)}</strong>
        </span>
      </div>
      <div className="investor-stats">
        <span><small>Ryzyko</small><strong>{formatNumber(investor.riskScore)}/10</strong></span>
        <span><small>Otwarte</small><strong>{investor.openPositions ?? 0}</strong></span>
        <span><small>Liczba kopiujących</small><strong>{formatNumber(investor.copiers)}</strong></span>
        <span><small>Aktywny od</small><strong>{formatDateOnly(investor.activeSince)}</strong></span>
      </div>
      <div className="investor-actions">
        <button type="button" onClick={onOpenPortfolio}>Zobacz portfel</button>
        <a
          href={`https://www.etoro.com/pl/people/${encodeURIComponent(investor.username)}`}
          target="_blank"
          rel="noreferrer"
        >
          Profil ↗
        </a>
      </div>
    </article>
  );
}

function YearlyGainChart({ points }: { points: GainPoint[] }) {
  if (!points.length) return <span className="chart-empty">brak danych</span>;
  const maxAbs = Math.max(...points.map((point) => Math.abs(point.gain)), 1);
  const trackHeight = 90;
  const half = trackHeight / 2;
  return (
    <div className="gain-bars gain-bars-yearly">
      {points.map((point) => {
        const barHeight = Math.max(2, (Math.abs(point.gain) / maxAbs) * half);
        const top = point.gain >= 0 ? half - barHeight : half;
        return (
          <div className="gain-bar-col" key={point.date}>
            <span className={`gain-bar-value ${point.gain >= 0 ? "positive" : "negative"}`}>
              {formatPercent(point.gain, true)}
            </span>
            <div className="gain-bar-track" style={{ height: `${trackHeight}px` }}>
              <span className="gain-bar-zero" />
              <span
                className={`gain-bar ${point.gain >= 0 ? "positive" : "negative"}`}
                style={{ top: `${top}px`, height: `${barHeight}px` }}
              />
            </div>
            <span className="gain-bar-label">{point.date.slice(0, 4)}</span>
          </div>
        );
      })}
    </div>
  );
}

const MONTH_HEADS = ["Sty", "Lut", "Mar", "Kwi", "Maj", "Cze", "Lip", "Sie", "Wrz", "Paź", "Lis", "Gru"];

// A year-per-row × month-per-column grid instead of 74 individually labeled
// bars in a strip — the strip made every label collide or disappear
// (duplicated years, near-invisible 8px slivers). Each cell's fill opacity
// scales with |gain| relative to the biggest month on record, so strong
// months visually pop without needing to read every number; the exact
// figure is still one hover away, and shown as text directly wherever the
// cell is wide enough to hold it.
function MonthlyGainHeatmap({ points }: { points: GainPoint[] }) {
  if (!points.length) return <span className="chart-empty">brak danych</span>;
  const maxAbs = Math.max(...points.map((point) => Math.abs(point.gain)), 1);
  const byYear = new Map<string, Map<number, number>>();
  for (const point of points) {
    const year = point.date.slice(0, 4);
    const month = Number(point.date.slice(5, 7));
    if (!byYear.has(year)) byYear.set(year, new Map());
    byYear.get(year)!.set(month, point.gain);
  }
  const years = [...byYear.keys()].sort((a, b) => Number(b) - Number(a));
  return (
    <div className="gain-heatmap">
      <div className="gain-heatmap-row gain-heatmap-head">
        <span className="gain-heatmap-year" aria-hidden="true" />
        {MONTH_HEADS.map((label) => <span key={label} className="gain-heatmap-cell-label">{label}</span>)}
      </div>
      {years.map((year) => (
        <div className="gain-heatmap-row" key={year}>
          <span className="gain-heatmap-year">{year}</span>
          {MONTH_HEADS.map((_, index) => {
            const gain = byYear.get(year)?.get(index + 1);
            if (gain == null) return <span className="gain-heatmap-cell empty" key={index} />;
            const intensity = 0.16 + Math.min(1, Math.abs(gain) / maxAbs) * 0.72;
            const tint = gain >= 0 ? `rgba(11,122,90,${intensity})` : `rgba(201,95,66,${intensity})`;
            return (
              <span
                key={index}
                className={`gain-heatmap-cell ${intensity > 0.55 ? "on-dark" : ""}`}
                style={{ background: tint }}
                title={`${MONTH_HEADS[index]} ${year}: ${formatPercent(gain, true)}`}
              >
                {formatPercent(gain, true)}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

const ALLOCATION_CHART_COLORS = ["#637082", "#0b7a5a", "#28659f", "#c95f42", "#b94335", "#8a6fb0", "#c9a227", "#a9a397", "#3f8f8f", "#8a5a2e"];

function AssetAllocationChart({ series }: { series: AssetAllocationSeries }) {
  if (!series.points.length) return <span className="chart-empty">brak danych</span>;
  const lastDay = series.points[series.points.length - 1];
  const rawValues = lastDay.values.map((value) => Math.max(0, value));
  const total = rawValues.reduce((sum, value) => sum + value, 0) || 1;
  const size = 160;
  const center = size / 2;
  const radius = 58;
  const strokeWidth = 24;
  const circumference = 2 * Math.PI * radius;
  const dashes = series.labels.map((_, index) => (rawValues[index] / total) * circumference);
  const segments = series.labels.map((label, index) => ({
    label,
    pct: (rawValues[index] / total) * 100,
    dash: dashes[index],
    offset: dashes.slice(0, index).reduce((sum, value) => sum + value, 0),
    color: ALLOCATION_CHART_COLORS[index % ALLOCATION_CHART_COLORS.length],
  }));
  return (
    <div className="chart-block">
      <div className="donut-row">
        <svg viewBox={`0 0 ${size} ${size}`} className="assets-donut" role="img" aria-label="Skład portfela wg instrumentu">
          <circle cx={center} cy={center} r={radius} fill="none" stroke="var(--line)" strokeWidth={strokeWidth} />
          {segments.filter((segment) => segment.pct > 0.2).map((segment) => (
            <circle
              key={segment.label}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={segment.color}
              strokeWidth={strokeWidth}
              strokeDasharray={`${segment.dash} ${circumference - segment.dash}`}
              strokeDashoffset={-segment.offset}
              transform={`rotate(-90 ${center} ${center})`}
            />
          ))}
        </svg>
        <div className="chart-legend">
          {segments.map((segment) => (
            <span key={segment.label}>
              <i style={{ background: segment.color }} />
              {segment.label} <b>{formatPercent(segment.pct)}</b>
            </span>
          ))}
        </div>
      </div>
      <div className="chart-footnote"><span>Stan na {formatQuickDate(lastDay.date)}</span></div>
    </div>
  );
}

function ExtendedStatsSection({
  investor,
  loading,
  error,
  stats,
}: {
  investor: Investor;
  loading: boolean;
  error: string;
  stats: InvestorExtendedStats | null;
}) {
  return (
    <section className="extended-stats" aria-label="Statystyki rozszerzone">
      <div className="extended-stats-heading">
        <span className="section-kicker">Statystyki rozszerzone</span>
        {loading && (
          <span className="extended-stats-loading" role="status" aria-live="polite">
            <span className="loading-spinner small" aria-hidden="true" />
            Ładowanie…
          </span>
        )}
      </div>
      {!loading && error && (
        <div className="alert error compact" role="alert">Nie udało się pobrać statystyk rozszerzonych: {error}</div>
      )}
      {!loading && !error && stats && (
        <>
          <div className="extended-stats-grid">
            <span><small>Transakcje na plusie</small><strong>{formatPercent(stats.winRatio)}</strong></span>
            <span><small>Śr. zwrot rocznie</small><strong className={gainTone(investor.annualizedReturn)}>{formatPercent(investor.annualizedReturn, true)}</strong></span>
            <span>
              <small>Miejsce wśród Popularnych Inwestorów (rok)</small>
              <strong>
                {investor.rankPosition != null && investor.rankPoolSize != null
                  ? `${investor.rankPosition}. z ${investor.rankPoolSize} (lepszy niż ${betterThanPct(investor.rankPosition, investor.rankPoolSize)}%)`
                  : "—"}
              </strong>
            </span>
            <span><small>Śr. wielkość pozycji</small><strong>{formatPercent(stats.avgPosSize)}</strong></span>
            <span>
              <small>Najczęściej handlowany</small>
              <strong>
                {stats.topTradedInstrumentSymbol ?? (stats.topTradedInstrumentId != null ? `#${stats.topTradedInstrumentId}` : "—")}
                {stats.topTradedAssetClass && ` · ${stats.topTradedAssetClass}`}
                {stats.topTradedInstrumentPct != null && ` (${formatPercent(stats.topTradedInstrumentPct)})`}
              </strong>
            </span>
          </div>
          <p className="chart-explainer">
            Śr. zwrot rocznie: wynik przeliczony tak, jakby to samo tempo trwało cały rok. Popularny Inwestor (PI): odznaka eToro
            dla śledzonych, aktywnie kopiowanych inwestorów — ranking porównuje tylko do tej grupy, nie do wszystkich użytkowników eToro.
          </p>
          <div className="extended-stats-gains">
            <span><small>Wynik roczny</small><YearlyGainChart points={stats.yearlyGains} /></span>
            <span><small>Wynik miesięczny (cała historia)</small><MonthlyGainHeatmap points={stats.monthlyGains} /></span>
          </div>
        </>
      )}
    </section>
  );
}

function ExtendedStatsCharts({ stats }: { stats: InvestorExtendedStats | null }) {
  if (!stats) return null;
  return (
    <section className="extended-stats-charts" aria-label="Skład portfela">
      <span className="section-kicker">Skład portfela</span>
      <div className="extended-stats-charts-grid">
        <div><small>Skład portfela wg instrumentu</small><AssetAllocationChart series={stats.assetAllocationHistory} /></div>
      </div>
    </section>
  );
}

function truncateText(text: string, maxLength: number) {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > maxLength ? `${clean.slice(0, maxLength).trimEnd()}…` : clean;
}

function FeedList({ posts, emptyLabel }: { posts: FeedPost[]; emptyLabel: string }) {
  if (!posts.length) return <div className="feed-empty">{emptyLabel}</div>;
  return (
    <div className="feed-list">
      {posts.map((post) => (
        <article className="feed-post" key={post.id}>
          <span className="avatar feed-avatar">
            {post.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={post.avatarUrl} alt="" />
            ) : <span aria-hidden="true">{initials(post.username)}</span>}
          </span>
          <div>
            <div className="feed-post-heading">
              <strong>@{post.username}</strong>
              <time>{formatRecentMoment(post.createdAt)}</time>
              <small className="feed-post-translated">tłumaczenie automatyczne</small>
            </div>
            <p>{truncateText(post.text, 240)}</p>
          </div>
        </article>
      ))}
    </div>
  );
}

function FeedsSection({ stats, topInstrumentSymbol }: { stats: InvestorExtendedStats | null; topInstrumentSymbol: string | null }) {
  if (!stats) return null;
  return (
    <section className="extended-stats-feeds" aria-label="Posty">
      <span className="section-kicker">Posty eToro</span>
      <div className="extended-stats-feeds-grid">
        <div>
          <small>Posty inwestora</small>
          <FeedList posts={stats.userPosts} emptyLabel="Ten inwestor nie opublikował żadnych postów." />
        </div>
        <div>
          <small>Dyskusja: {topInstrumentSymbol ?? "najczęściej handlowany instrument"}</small>
          <FeedList posts={stats.instrumentPosts} emptyLabel="Brak postów na temat tego instrumentu." />
        </div>
      </div>
    </section>
  );
}

function PortfolioDialog({
  investor,
  positions,
  events,
  recentTradesLoading,
  recentTradesError,
  onClose,
}: {
  investor: Investor;
  positions: CurrentPortfolioPosition[];
  events: TradeEvent[];
  recentTradesLoading: boolean;
  recentTradesError: string;
  onClose: () => void;
}) {
  const [sideFilter, setSideFilter] = useState<"all" | "buy" | "short">("all");
  const consolidatedPositions = useMemo(() => consolidatePositions(positions), [positions]);
  const visiblePositions = consolidatedPositions.filter((position) =>
    sideFilter === "all" || (sideFilter === "buy" ? position.isBuy : !position.isBuy),
  );
  const buyCount = positions.filter((position) => position.isBuy).length;
  const shortCount = positions.length - buyCount;
  const instrumentCount = new Set(positions.map((position) => position.instrumentId)).size;
  const groupedEvents = useMemo(() => groupTradeEvents(events), [events]);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    document.body.classList.add("modal-open");
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.body.classList.remove("modal-open");
    };
  }, [onClose]);

  // Extended stats (win ratio, top traded instrument, monthly/yearly gain
  // history) cost 3 extra eToro requests, so they're only fetched once this
  // dialog is actually open for this investor — never preloaded for all 27.
  const [extendedStats, setExtendedStats] = useState<InvestorExtendedStats | null>(null);
  const [extendedStatsError, setExtendedStatsError] = useState("");
  const [extendedStatsLoading, setExtendedStatsLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    api<InvestorExtendedStats>(`/api/investor-stats?username=${encodeURIComponent(investor.username)}`)
      .then((data) => { if (!cancelled) setExtendedStats(data); })
      .catch((error) => { if (!cancelled) setExtendedStatsError(error instanceof Error ? error.message : "Nie udało się pobrać statystyk."); })
      .finally(() => { if (!cancelled) setExtendedStatsLoading(false); });
    return () => { cancelled = true; };
  }, [investor.username]);

  return (
    // The backdrop is intentionally mouse-only; the dialog has a native close button and Escape support.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div className="portfolio-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="portfolio-dialog" role="dialog" aria-modal="true" aria-labelledby="portfolio-title">
        <header className="portfolio-dialog-header">
          <div className="portfolio-person">
            <span className={`avatar avatar-${investor.slot}`}>
              {investor.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={investor.avatarUrl} alt="" />
              ) : <span aria-hidden="true">{initials(investor.username)}</span>}
            </span>
            <div>
              <span className="section-kicker">Aktualny publiczny portfel</span>
              <h2 id="portfolio-title">{investor.fullName}</h2>
              <p>
                @{investor.username} · eToro CID {investor.cid} · <strong>{formatNumber(investor.copiers)}</strong> kopiujących
                {" · "}Aktywny od <strong>{formatDateOnly(investor.activeSince)}</strong>
                {" · "}
                <a
                  href={`https://www.etoro.com/pl/people/${encodeURIComponent(investor.username)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Profil eToro ↗
                </a>
              </p>
            </div>
          </div>
          <button className="dialog-close" type="button" onClick={onClose} aria-label="Zamknij portfel">×</button>
        </header>
        <div className="portfolio-dialog-body">
        <div className="portfolio-summary">
          <span><small>Od początku roku</small><strong className={gainTone(investor.gainYtd)}>{formatPercent(investor.gainYtd, true)}</strong></span>
          <span><small>Ostatnie 2 lata</small><strong className={gainTone(investor.gainTwoYears)}>{formatPercent(investor.gainTwoYears, true)}</strong></span>
          <span><small>Otwarte pozycje</small><strong>{positions.length}</strong></span>
          <span><small>Instrumenty w portfelu</small><strong>{instrumentCount}</strong></span>
        </div>
        <ExtendedStatsSection investor={investor} loading={extendedStatsLoading} error={extendedStatsError} stats={extendedStats} />
        <section className="portfolio-recent" aria-labelledby="recent-trades-title">
          <div className="portfolio-recent-heading">
            <span>
              <small>Pozycje otwarte i zamknięte</small>
              <strong id="recent-trades-title">Ostatnio handlowane</strong>
            </span>
            <b>wpisy: {groupedEvents.length} · pozycje: {events.length}</b>
          </div>
          {recentTradesLoading && (
            <div className="portfolio-recent-loading" role="status" aria-live="polite">
              <span className="loading-spinner small" aria-hidden="true" />
              Pobieram zamknięte pozycje z eToro…
            </div>
          )}
          {!recentTradesLoading && recentTradesError && (
            <div className="alert error" role="alert">
              Nie udało się dociągnąć pełnej historii zamkniętych pozycji: {recentTradesError} Lista poniżej może być niekompletna.
            </div>
          )}
          {events.length ? (
            <div className="portfolio-recent-list">
              {groupedEvents.map(({ key, representative: event, events: mergedEvents }) => (
                <article className="portfolio-recent-trade" key={key}>
                  <div className="recent-trade-name">
                    <InstrumentLogo logoUrl={event.logoUrl} symbol={event.symbol} />
                    <strong>{event.symbol}</strong>
                    <span>{event.displayName}</span>
                  </div>
                  <div className="recent-trade-status">
                    <span className={summaryAction(event).tone}>{eventLabel(event)}</span>
                    <time>· {formatRecentMoment(event.occurredAt)}</time>
                    {mergedEvents.length > 1 && <em>pozycje: {mergedEvents.length}</em>}
                  </div>
                  <small>{event.exchangeName ?? `Instrument eToro #${event.instrumentId}`}</small>
                  <GroupedPositionReturn events={mergedEvents} />
                  <GroupedPriceMovement events={mergedEvents} />
                </article>
              ))}
            </div>
          ) : (
            <div className="portfolio-recent-empty">Brak ostatnich pozycji udostępnionych przez eToro.</div>
          )}
        </section>
        <p className="portfolio-truth-note">
          „Zmiana ceny” porównuje kurs otwarcia pozycji z najnowszym kursem instrumentu. Nie uwzględnia spreadu, opłat ani kierunku pozycji, więc nie jest wynikiem rachunku inwestora.
        </p>
        <div className="portfolio-filters" role="group" aria-label="Filtr operacji w portfelu">
          <span>
            Aktualny portfel inwestora: <strong>{instrumentCount}</strong> instrumentów
            {positions.length !== consolidatedPositions.length && <> ({positions.length} pozycji łącznie)</>}
          </span>
          <div>
            <button type="button" className={sideFilter === "all" ? "active" : ""} onClick={() => setSideFilter("all")}>Wszystkie ({positions.length})</button>
            <button type="button" className={`buy-filter ${sideFilter === "buy" ? "active" : ""}`} onClick={() => setSideFilter("buy")}>Kupił ({buyCount})</button>
            <button type="button" className={`short-filter ${sideFilter === "short" ? "active" : ""}`} onClick={() => setSideFilter("short")}>Short ({shortCount})</button>
          </div>
        </div>
        <div className="portfolio-position-list">
          {visiblePositions.length ? visiblePositions.map((position) => (
            <article className="portfolio-position" key={`${position.username}-${position.positionId}`}>
              <div className="position-name">
                <InstrumentLogo logoUrl={position.logoUrl} symbol={position.symbol} />
                <span className="position-identity">
                  {!position.isBuy && <span className="position-side short">Short</span>}
                  <strong>{position.symbol}</strong>
                  {position.mergedCount > 1 && <em>{position.mergedCount}×</em>}
                  <span className="position-display-name">{position.displayName}</span>
                </span>
                <span className="position-exchange">{position.exchangeName ?? "Rynek nieopisany przez eToro"} · instrument eToro #{position.instrumentId}</span>
              </div>
              <div className="position-facts">
                {position.mergedCount > 1 ? (
                  <span><small>Pierwsze / ostatnie otwarcie</small><strong>{formatMoment(position.firstOpenTimestamp)} → {formatMoment(position.openTimestamp)}</strong></span>
                ) : (
                  <span><small>Otwarcie</small><strong>{formatMoment(position.openTimestamp)}</strong></span>
                )}
                <span><small>{position.mergedCount > 1 ? "Śr. kurs otwarcia" : "Kurs otwarcia"}</small><strong>{position.mergedCount > 1 ? formatRate2(position.openRate) : formatRate(position.openRate)}</strong></span>
                {position.investmentPct != null && <span><small>Udział portfela</small><strong>{formatPercent(position.investmentPct)}</strong></span>}
              </div>
              <PositionReturn value={position.netProfit} />
              <PriceMovement value={position.priceChangePct} direction={position.priceDirection} currentRate={position.currentRate} currentRateAt={position.currentRateAt} quoteStatus={position.quoteStatus} compact />
            </article>
          )) : <div className="portfolio-empty">Brak pozycji pasujących do wybranego filtra.</div>}
        </div>
        <ExtendedStatsCharts stats={extendedStats} />
        <FeedsSection stats={extendedStats} topInstrumentSymbol={extendedStats?.topTradedInstrumentSymbol ?? null} />
        </div>
      </section>
    </div>
  );
}

function findOppositeSameDayEvent(
  allEvents: TradeEvent[],
  reference: TradeEvent,
  username: string,
): TradeEvent | null {
  const oppositeType = reference.eventType === "OPEN"
    ? "CLOSE"
    : reference.eventType === "CLOSE" ? "OPEN" : null;
  if (!oppositeType) return null;
  return allEvents.find((event) =>
    event.instrumentId === reference.instrumentId
    && event.isBuy === reference.isBuy
    && event.eventType === oppositeType
    && event.username.toLowerCase() === username.toLowerCase(),
  ) ?? null;
}

function SummaryDialog({
  summary,
  people,
  investors,
  allEvents,
  date,
  onClose,
  onOpenInvestor,
}: {
  summary: DaySummary;
  people: SummaryPerson[];
  investors: Investor[];
  allEvents: TradeEvent[];
  date: string;
  onClose: () => void;
  onOpenInvestor: (username: string) => void;
}) {
  const [query, setQuery] = useState("");
  const action = summaryAction(summary.event);
  const visiblePeople = people.filter(({ username }) => {
    const investor = investors.find((current) => current.username.toLowerCase() === username.toLowerCase());
    const haystack = `${investor?.fullName ?? ""} ${username}`.toLocaleLowerCase("pl");
    return haystack.includes(query.trim().toLocaleLowerCase("pl"));
  });
  const averages = useMemo(() => {
    const matched = people.flatMap(({ username }) => {
      const investor = investors.find((current) => current.username.toLowerCase() === username.toLowerCase());
      return investor ? [investor] : [];
    });
    const average = (getValue: (investor: Investor) => number | null) => {
      const values = matched.flatMap((investor) => {
        const value = getValue(investor);
        return value == null ? [] : [value];
      });
      return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    };
    return {
      copiers: average((investor) => investor.copiers),
      gainYtd: average((investor) => investor.gainYtd),
      gainTwoYears: average((investor) => investor.gainTwoYears),
    };
  }, [people, investors]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    document.body.classList.add("modal-open");
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.body.classList.remove("modal-open");
    };
  }, [onClose]);

  return (
    // The backdrop is intentionally mouse-only; the dialog has a native close button and Escape support.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div className="portfolio-backdrop summary-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`portfolio-dialog summary-dialog ${action.tone}`} role="dialog" aria-modal="true" aria-labelledby="summary-dialog-title">
        <header className="portfolio-dialog-header summary-dialog-header">
          <div className="summary-dialog-identity">
            <InstrumentLogo logoUrl={summary.event.logoUrl} symbol={summary.event.symbol} />
            <div>
              <span className="section-kicker">Operacje z {formatQuickDate(date)}</span>
              <h2 id="summary-dialog-title">{summary.event.symbol} · {summary.event.displayName}</h2>
              <p>{people.length} {people.length === 1 ? "inwestor" : "inwestorów"} · {summary.positions} {positionWord(summary.positions)}</p>
            </div>
          </div>
          <span className={`summary-dialog-action ${action.tone}`}>{action.label}</span>
          <button className="dialog-close" type="button" onClick={onClose} aria-label="Zamknij listę inwestorów">×</button>
        </header>
        <div className="summary-dialog-averages">
          <span><small>Śr. liczba kopiujących</small><strong>{formatNumber(averages.copiers)}</strong></span>
          <span><small>Śr. wynik od roku</small><strong className={gainTone(averages.gainYtd)}>{formatPercent(averages.gainYtd, true)}</strong></span>
          <span><small>Śr. wynik za 2 lata</small><strong className={gainTone(averages.gainTwoYears)}>{formatPercent(averages.gainTwoYears, true)}</strong></span>
        </div>
        <div className="summary-dialog-toolbar">
          <span><strong>{people.length}</strong><small>{people.length === 1 ? "inwestor" : "inwestorów"}</small></span>
          <label>
            <span className="sr-only">Szukaj inwestora</span>
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Szukaj inwestora…" />
          </label>
        </div>
        <div className="summary-dialog-list">
          {visiblePeople.map(({ username, events }) => {
            const investor = investors.find(
              (current) => current.username.toLowerCase() === username.toLowerCase(),
            );
            const oppositeEvent = findOppositeSameDayEvent(allEvents, summary.event, username);
            return (
              <button
                type="button"
                className="summary-dialog-person"
                key={username}
                onClick={() => onOpenInvestor(investor?.username ?? username)}
              >
                <span className={`avatar summary-dialog-avatar avatar-${investor?.slot ?? 1}`}>
                  {investor?.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={investor.avatarUrl} alt="" />
                  ) : <span aria-hidden="true">{initials(username)}</span>}
                </span>
                <span className="summary-dialog-person-name">
                  <strong>{investor?.fullName ?? username}</strong>
                  <small>@{username}</small>
                  {oppositeEvent && (
                    <small className="summary-dialog-flip-note">
                      Tego dnia też: {eventLabel(oppositeEvent).toLowerCase()} · {formatTime(oppositeEvent.occurredAt, true)}
                    </small>
                  )}
                </span>
                <span className="summary-dialog-operation">
                  <small>{events.length} {positionWord(events.length)}</small>
                  <time dateTime={events[0].occurredAt}>{formatTime(events[0].occurredAt, true)}</time>
                </span>
                <span className="summary-dialog-copiers">
                  <small>Kopiujących</small>
                  <b>{formatNumber(investor?.copiers)}</b>
                </span>
                <span className="summary-dialog-return">
                  <small>Od roku</small>
                  <b className={gainTone(investor?.gainYtd)}>{formatPercent(investor?.gainYtd, true)}</b>
                </span>
                <span className="summary-dialog-return">
                  <small>2 lata</small>
                  <b className={gainTone(investor?.gainTwoYears)}>{formatPercent(investor?.gainTwoYears, true)}</b>
                </span>
                <span className="summary-dialog-open" aria-hidden="true">›</span>
              </button>
            );
          })}
          {!visiblePeople.length && <div className="summary-dialog-empty">Nie znaleziono inwestora.</div>}
        </div>
      </section>
    </div>
  );
}

function EmptyState({
  date,
  configured,
}: {
  date: string;
  configured: boolean;
}) {
  return (
    <div className="empty-state">
      <span aria-hidden="true">○</span>
      <h3>{configured ? "Spokojny dzień" : "Oczekiwanie na eToro"}</h3>
      <p>
        {configured
          ? `Nie wykryto transakcji ani zmian pozycji dla daty ${formatQuickDate(date)}.`
          : "Uzupełnij lokalny plik .env.local własnymi kluczami API z uprawnieniem Read."}
      </p>
    </div>
  );
}

export function Dashboard() {
  const [selectedDate, setSelectedDate] = useState(() => warsawDateKey());
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [dataLoadedAt, setDataLoadedAt] = useState<string | null>(null);
  const [selectedInvestor, setSelectedInvestor] = useState("all");
  const [investorSort, setInvestorSort] = useState<"slot" | "gain" | "risk" | "activity">("gain");
  const [portfolioUsername, setPortfolioUsername] = useState<string | null>(null);
  const [recentTrades, setRecentTrades] = useState<TradeEvent[]>([]);
  const [livePositions, setLivePositions] = useState<CurrentPortfolioPosition[]>([]);
  const [recentTradesOwner, setRecentTradesOwner] = useState<string | null>(null);
  const [recentTradesError, setRecentTradesError] = useState("");
  const [selectedSummaryKey, setSelectedSummaryKey] = useState<string | null>(null);
  const [dateWindowEnd, setDateWindowEnd] = useState(() => warsawDateKey());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const activeLoad = useRef<AbortController | null>(null);
  const skipNextDateLoad = useRef(false);
  const investorStripRef = useRef<HTMLDivElement | null>(null);
  const companyStripRef = useRef<HTMLDivElement | null>(null);
  const activeRecentTradesLoad = useRef<AbortController | null>(null);

  const load = useCallback(async (date: string, quiet = false) => {
    activeLoad.current?.abort();
    const controller = new AbortController();
    activeLoad.current = controller;
    if (!quiet) setBusy(true);
    setError("");
    try {
      // Today's transactions always load plainly here — refreshing investor
      // profiles/portfolios is a distinct, explicit action (the "Odśwież
      // teraz" button, or opening a specific investor's profile), never
      // implicit just because the page opened or a date was picked.
      const nextData = await api<DashboardPayload>(
        `/api/dashboard?date=${encodeURIComponent(date)}`,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) {
        setData(nextData);
        setDataLoadedAt(new Date().toISOString());
      }
    } catch (currentError) {
      if (!controller.signal.aborted) {
        setError(currentError instanceof Error ? currentError.message : "Błąd panelu.");
      }
    } finally {
      if (activeLoad.current === controller) {
        activeLoad.current = null;
        setBusy(false);
      }
    }
  }, []);

  useEffect(() => () => activeLoad.current?.abort(), []);
  useEffect(() => () => activeRecentTradesLoad.current?.abort(), []);

  useEffect(() => {
    // Loading on a date change is the external synchronization performed by this effect.
    if (skipNextDateLoad.current) {
      skipNextDateLoad.current = false;
      return;
    }
    void load(selectedDate, false);
  }, [load, selectedDate]);

  useEffect(() => {
    companyStripRef.current?.scrollTo({ left: 0, behavior: "auto" });
  }, [selectedDate]);

  useEffect(() => {
    // Once the load for the new date lands, the list is replaced and the
    // browser's scroll-anchoring can silently drag scrollLeft away from 0.
    if (!busy) companyStripRef.current?.scrollTo({ left: 0, behavior: "auto" });
  }, [busy, selectedDate]);

  const loadRecentTrades = useCallback(async (username: string) => {
    activeRecentTradesLoad.current?.abort();
    const controller = new AbortController();
    activeRecentTradesLoad.current = controller;
    try {
      const result = await api<{ events: TradeEvent[]; positions: CurrentPortfolioPosition[] }>(
        `/api/investor-recent?username=${encodeURIComponent(username)}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setRecentTrades(result.events);
      setLivePositions(result.positions);
      setRecentTradesOwner(username);
      setRecentTradesError("");
    } catch (currentError) {
      if (controller.signal.aborted) return;
      setRecentTrades([]);
      setLivePositions([]);
      setRecentTradesOwner(username);
      setRecentTradesError(
        currentError instanceof Error ? currentError.message : "Nie udało się pobrać danych inwestora.",
      );
    }
  }, []);

  useEffect(() => {
    // No cleanup needed when the dialog closes: it isn't rendered without a
    // portfolioUsername, and the next open re-fetches before showing anything.
    // Same abort-aware fetch-on-effect shape as `load` above, which the same
    // lint rule doesn't flag; this is a false positive on an identical pattern.
    if (!portfolioUsername) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRecentTrades(portfolioUsername);
  }, [portfolioUsername, loadRecentTrades]);

  const visibleEvents = useMemo(
    () => (data?.events ?? []).filter(
      (event) => selectedInvestor === "all" || event.username === selectedInvestor,
    ),
    [data?.events, selectedInvestor],
  );
  const groupedVisibleEvents = useMemo(() => groupTradeEvents(visibleEvents), [visibleEvents]);
  const sortedInvestors = useMemo(() => {
    const investors = data?.investors ?? [];
    if (investorSort === "slot") return investors;
    const sorted = [...investors];
    if (investorSort === "gain") sorted.sort((a, b) => (b.gainYtd ?? -Infinity) - (a.gainYtd ?? -Infinity));
    else if (investorSort === "risk") sorted.sort((a, b) => (a.riskScore ?? Infinity) - (b.riskScore ?? Infinity));
    else if (investorSort === "activity") sorted.sort((a, b) => (b.openPositions ?? 0) - (a.openPositions ?? 0));
    return sorted;
  }, [data?.investors, investorSort]);
  const openedCount = groupedVisibleEvents.filter((group) => group.representative.eventType === "OPEN").length;
  const closedCount = groupedVisibleEvents.filter((group) => group.representative.eventType === "CLOSE").length;
  const shortCount = groupedVisibleEvents.filter((group) => !group.representative.isBuy).length;
  const daySummary = useMemo(() => {
    const summaries = new Map<string, DaySummary>();
    for (const event of data?.events ?? []) {
      const action = !event.isBuy
        ? event.eventType === "OPEN" ? "SHORT_OPEN" : event.eventType === "CLOSE" ? "SHORT_CLOSE" : "SHORT_UPDATE"
        : event.eventType;
      const key = `${event.instrumentId}:${action}`;
      const summary = summaries.get(key);
      if (summary) {
        summary.investors.add(event.username.toLowerCase());
        summary.positions += 1;
        summary.events.push(event);
      } else {
        summaries.set(key, {
          key,
          event,
          investors: new Set([event.username.toLowerCase()]),
          positions: 1,
          events: [event],
        });
      }
    }
    return [...summaries.values()].sort((a, b) =>
      b.investors.size - a.investors.size
      || b.positions - a.positions
      || a.event.displayName.localeCompare(b.event.displayName, "pl")
      || a.event.symbol.localeCompare(b.event.symbol, "pl")
      || a.event.eventType.localeCompare(b.event.eventType),
    );
  }, [data?.events]);
  const selectedSummary = daySummary.find((summary) => summary.key === selectedSummaryKey) ?? null;
  const selectedSummaryPeople = selectedSummary
    ? [...selectedSummary.events.reduce((people, event) => {
        const username = event.username.toLowerCase();
        const existing = people.get(username);
        if (existing) existing.events.push(event);
        else people.set(username, { username: event.username, events: [event] });
        return people;
      }, new Map<string, { username: string; events: TradeEvent[] }>()).values()].sort((a, b) => {
        const investorA = data?.investors.find((investor) => investor.username.toLowerCase() === a.username.toLowerCase());
        const investorB = data?.investors.find((investor) => investor.username.toLowerCase() === b.username.toLowerCase());
        return (investorA?.fullName ?? a.username).localeCompare(investorB?.fullName ?? b.username, "pl");
      })
    : [];
  const investorScroll = useScrollAvailability(investorStripRef, data?.investors.length ?? 0);
  const companyScroll = useScrollAvailability(companyStripRef, daySummary.length);
  const todayDate = warsawDateKey();
  const quickDates = useMemo(() => {
    const anchor = previousOrSameBusinessDateKey(dateWindowEnd);
    const dates = [anchor];
    let cursor = anchor;
    for (let index = 1; index < 7; index += 1) {
      cursor = shiftBusinessDateKey(cursor, -1);
      dates.unshift(cursor);
    }
    return dates;
  }, [dateWindowEnd]);
  const portfolioInvestor = data?.investors.find((investor) => investor.username === portfolioUsername) ?? null;
  const recentTradesLoading = portfolioUsername != null
    && recentTradesOwner?.toLowerCase() !== portfolioUsername.toLowerCase();
  // Prefer the just-fetched live positions for the open profile; the batch
  // snapshot from the last sync only fills the brief moment before that
  // live fetch resolves.
  const portfolioPositions = recentTradesLoading
    ? (data?.positions ?? []).filter((position) => position.username === portfolioUsername)
    : livePositions;
  // The journal ("Dziennik zmian") for the selected date is the proven,
  // already-correct source of truth, so it always wins over the separate
  // on-demand 90-day fetch — a position closed today must show up here even
  // if that slower, wider fetch hasn't (yet, or due to a rate limit)
  // picked it up.
  const portfolioEvents = useMemo(() => {
    const byPosition = new Map<string, TradeEvent>();
    const matchesInvestor = (event: TradeEvent) =>
      event.username.toLowerCase() === portfolioUsername?.toLowerCase();
    for (const event of (data?.recentEvents ?? []).filter(matchesInvestor)) {
      byPosition.set(`${event.positionId}:${event.eventType}`, event);
    }
    if (!recentTradesLoading) {
      for (const event of recentTrades) {
        byPosition.set(`${event.positionId}:${event.eventType}`, event);
      }
    }
    for (const event of (data?.events ?? []).filter(matchesInvestor)) {
      byPosition.set(`${event.positionId}:${event.eventType}`, event);
    }
    return [...byPosition.values()];
  }, [data?.recentEvents, data?.events, recentTrades, recentTradesLoading, portfolioUsername]);

  function selectDate(date: string) {
    setSelectedDate(date);
    if (date > quickDates.at(-1)! || date < quickDates[0]) {
      setDateWindowEnd(date);
    }
  }

  function changeDay(days: number) {
    const nextDate = shiftBusinessDateKey(selectedDate, days);
    if (nextDate <= todayDate) selectDate(nextDate);
  }

  function changeWeek(weeks: number) {
    const nextEnd = shiftDateKey(dateWindowEnd, weeks * 7);
    const boundedEnd = nextEnd > todayDate ? previousOrSameBusinessDateKey(todayDate) : nextEnd;
    setDateWindowEnd(boundedEnd);
    setSelectedDate(boundedEnd);
  }

  function scrollStrip(ref: { current: HTMLDivElement | null }, direction: -1 | 1) {
    const container = ref.current;
    if (!container) return;
    const positions = [...container.children].map(
      (item) => (item as HTMLElement).offsetLeft - container.offsetLeft,
    );
    const current = container.scrollLeft;
    const target = direction > 0
      ? positions.find((position) => position > current + 2) ?? positions.at(-1) ?? current
      : [...positions].reverse().find((position) => position < current - 2) ?? 0;
    container.scrollTo({ left: target, behavior: "smooth" });
  }

  async function sync() {
    const currentDate = warsawDateKey();
    setBusy(true);
    setError("");
    try {
      await api("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } catch (currentError) {
      // A failed sync (e.g. eToro's cooldown) shouldn't block reloading the
      // dashboard — whatever is already stored is still worth showing.
      setError(currentError instanceof Error ? currentError.message : "Błąd synchronizacji.");
    }
    setSelectedInvestor("all");
    if (selectedDate !== currentDate) skipNextDateLoad.current = true;
    setSelectedDate(currentDate);
    setDateWindowEnd(currentDate);
    await load(currentDate, false);
    setBusy(false);
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Giełda Operacje — strona główna">
          <span className="brand-mark" aria-hidden="true">↗</span><span>Giełda Operacje</span>
        </a>
        <div className="topbar-meta">
          <span className={`mode-pill ${data?.mode === "live" ? "live" : "setup"}`}>
            <i aria-hidden="true" />{data?.mode === "live" ? "Prawdziwe dane eToro" : "Brak kluczy API"}
          </span>
        </div>
      </header>

      <section className="activity-section" id="top" aria-labelledby="activity-title">
        <div className="activity-heading">
          <div>
            <span className="section-kicker">Dziennik zmian</span>
            <h1 id="activity-title">Transakcje i zmiany — {formatQuickDate(selectedDate)}</h1>
          </div>
          <div className="live-refresh" aria-live="polite">
            <span>
              <small>Dziennik zmian zaktualizowany</small>
              <strong>{formatMoment(dataLoadedAt)}</strong>
            </span>
            <button type="button" onClick={() => void sync()} disabled={busy || data?.mode !== "live"}>
              <span aria-hidden="true">↻</span> {busy ? "Pobieram…" : "Odśwież teraz"}
            </button>
          </div>
        </div>
        {error && <div className="alert error" role="alert">{error}</div>}
        {data?.notice && <div className="alert notice"><span aria-hidden="true">i</span>{data.notice}</div>}
        <div className="activity-controls">
          <div className="report-date">
            <span>Data dziennika</span>
            <PolishDatePicker value={selectedDate} max={todayDate} onChange={selectDate} />
          </div>
          <div className="date-stepper" role="group" aria-label="Szybka zmiana daty">
            <button type="button" onClick={() => changeDay(-1)} aria-label="Poprzedni dzień">←</button>
            <button type="button" onClick={() => selectDate(todayDate)} disabled={selectedDate === todayDate}>Dziś</button>
            <button type="button" onClick={() => changeDay(1)} disabled={selectedDate >= todayDate} aria-label="Następny dzień">→</button>
          </div>
          <div className="summary-chips" aria-label="Podsumowanie transakcji">
            <span><b>{openedCount}</b> otwarcia</span><span><b>{closedCount}</b> zamknięcia</span><span><b>{shortCount}</b> short</span><span><b>{groupedVisibleEvents.length}</b> razem</span>
          </div>
        </div>
        <div className="quick-dates-nav">
          <button className="week-step" type="button" onClick={() => changeWeek(-1)} aria-label="Pokaż poprzednie siedem dni">← 7 dni</button>
          <div className="quick-dates" role="group" aria-label="Wybrane siedem dni">
            {quickDates.map((date) => (
              <button
                type="button"
                key={date}
                className={selectedDate === date ? "active" : ""}
                onClick={() => selectDate(date)}
                aria-pressed={selectedDate === date}
              >
                {date === todayDate ? "Dziś" : formatQuickDate(date)}
              </button>
            ))}
          </div>
          <button className="week-step" type="button" onClick={() => changeWeek(1)} disabled={dateWindowEnd >= todayDate} aria-label="Pokaż następne siedem dni">7 dni →</button>
        </div>
        {daySummary.length > 0 && (
          <section className={`day-summary ${busy ? "is-loading" : ""}`} aria-labelledby="day-summary-title" aria-busy={busy}>
            <div className="day-summary-heading">
              <span className="section-kicker">W skrócie</span>
              <strong id="day-summary-title">
                Co wydarzyło się {formatQuickDate(selectedDate)}
                {" "}<span className="day-summary-count">({groupedVisibleEvents.length} {groupedVisibleEvents.length === 1 ? "operacja" : "operacji"})</span>
              </strong>
              {busy && (
                <span className="day-summary-updating" role="status" aria-live="polite">
                  <span className="loading-spinner small" aria-hidden="true" />
                  Aktualizuję…
                </span>
              )}
            </div>
            <div className="scroll-strip-shell company-strip">
              <button className={`strip-arrow ${companyScroll.left ? "" : "is-hidden"}`} type="button" onClick={() => scrollStrip(companyStripRef, -1)} disabled={!companyScroll.left} aria-label="Pokaż wcześniejsze spółki">‹</button>
              <div className={`day-summary-list ${busy ? "is-updating" : ""}`} ref={companyStripRef}>
                {daySummary.map(({ key, event, investors, positions }) => {
                  const action = summaryAction(event);
                  return (
                    <button
                      type="button"
                      className={`summary-card ${action.tone} ${selectedSummaryKey === key ? "active" : ""}`}
                      key={key}
                      onClick={() => setSelectedSummaryKey((current) => current === key ? null : key)}
                      aria-expanded={selectedSummaryKey === key}
                    >
                      <InstrumentLogo logoUrl={event.logoUrl} symbol={event.symbol} />
                      <span className="summary-company"><strong>{event.symbol}</strong><small>{event.displayName}</small></span>
                      <span className="summary-investors"><strong>{investors.size}</strong><small>{investors.size === 1 ? "inwestor" : "inwestorów"}</small></span>
                      <span className="summary-footer">
                        <b className={`summary-action ${action.tone}`}>{action.label}</b>
                      </span>
                      {positions > investors.size && <small className="summary-positions">pozycji: {positions}</small>}
                    </button>
                  );
                })}
              </div>
              <button className={`strip-arrow ${companyScroll.right ? "" : "is-hidden"}`} type="button" onClick={() => scrollStrip(companyStripRef, 1)} disabled={!companyScroll.right} aria-label="Pokaż kolejne spółki">›</button>
            </div>
          </section>
        )}
        <div className={`activity-card ${busy ? "is-loading" : ""}`} aria-busy={busy}>
          {busy && (
            <div className="activity-loading" role="status" aria-live="polite">
              <span className="loading-spinner" aria-hidden="true" />
              <span>
                <strong>Pobieram dane z eToro…</strong>
                <small>Aktualizuję dziennik dla {formatQuickDate(selectedDate)}. Proszę chwilę poczekać.</small>
              </span>
            </div>
          )}
          <div className={`activity-content ${busy ? "is-updating" : ""}`}>
          {groupedVisibleEvents.length ? (
            <div className="event-list">
              {groupedVisibleEvents.map(({ key, representative: event, events: mergedEvents }) => {
                const investor = data?.investors.find(
                  (current) => current.username.toLowerCase() === event.username.toLowerCase(),
                );
                return (
                  <article className="event-row" key={key}>
                    <time dateTime={event.occurredAt}>
                      <strong>{formatTime(event.occurredAt, true)}</strong>
                      <small>{event.precision === "exact" ? "transakcja" : "wykrycie"}</small>
                    </time>
                    <TradeActionIcon event={event} />
                    <button
                      className="event-investor"
                      type="button"
                      onClick={() => setPortfolioUsername(investor?.username ?? event.username)}
                      aria-label={`Otwórz portfel ${investor?.fullName ?? event.username}`}
                    >
                      <div className="event-investor-name">
                        <span className={`avatar event-avatar avatar-${investor?.slot ?? 1}`}>
                          {investor?.avatarUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={investor.avatarUrl} alt="" />
                          ) : <span aria-hidden="true">{initials(event.username)}</span>}
                        </span>
                        <span>
                          <strong>{investor?.fullName ?? event.username}</strong>
                          <small>@{event.username}</small>
                        </span>
                      </div>
                      <div className="event-performance" aria-label={`Wyniki ${investor?.fullName ?? event.username} według eToro`}>
                        <span><small>Od roku</small><b className={gainTone(investor?.gainYtd)}>{formatPercent(investor?.gainYtd, true)}</b></span>
                        <span><small>2 lata</small><b className={gainTone(investor?.gainTwoYears)}>{formatPercent(investor?.gainTwoYears, true)}</b></span>
                        <span><small>Aktywny od</small><b>{formatDateOnly(investor?.activeSince ?? null)}</b></span>
                        <span><small>Śr. zwrot rocznie</small><b className={gainTone(investor?.annualizedReturn)}>{formatPercent(investor?.annualizedReturn, true)}</b></span>
                        <span>
                          <small>Miejsce wśród PI (rok)</small>
                          <b>
                            {investor?.rankPosition != null && investor?.rankPoolSize != null
                              ? `${investor.rankPosition}. z ${investor.rankPoolSize}`
                              : "—"}
                          </b>
                        </span>
                      </div>
                    </button>
                    <div className="event-main">
                      <div className="event-title">
                        <InstrumentLogo logoUrl={event.logoUrl} symbol={event.symbol} />
                        <span className={`event-badge ${event.eventType.toLowerCase()} ${!event.isBuy ? "short" : ""}`}>{eventLabel(event)}</span>
                        <strong>{event.symbol}</strong><span>{event.displayName}</span>
                      </div>
                      <div className="event-details">
                        <span>{eventContext(event)}</span>
                        <span>{event.exchangeName ?? "Rynek nieopisany przez eToro"} · instrument #{event.instrumentId}</span>
                        {event.investmentPct != null && <span>{formatPercent(event.investmentPct)} portfela</span>}
                        {mergedEvents.length > 1 && <span><strong>{mergedEvents.length} pozycje połączone w jeden wpis</strong></span>}
                      </div>
                      {mergedEvents.some((item) => item.netProfit != null) && <GroupedPositionReturn events={mergedEvents} />}
                    </div>
                    <GroupedPriceMovement events={mergedEvents} />
                  </article>
                );
              })}
            </div>
          ) : <EmptyState date={selectedDate} configured={data?.mode === "live"} />}
          </div>
        </div>
        <div className="scroll-strip-shell investor-filter-strip">
          <button className={`strip-arrow ${investorScroll.left ? "" : "is-hidden"}`} type="button" onClick={() => scrollStrip(investorStripRef, -1)} disabled={!investorScroll.left} aria-label="Pokaż wcześniejszych inwestorów">‹</button>
          <div className="filter-row" ref={investorStripRef} role="group" aria-label="Filtr inwestora">
            <button type="button" className={`all-investors ${selectedInvestor === "all" ? "active" : ""}`} onClick={() => setSelectedInvestor("all")}>Wszyscy</button>
            {data?.investors.map((investor) => (
              <button type="button" key={investor.username} className={selectedInvestor === investor.username ? "active" : ""} onClick={() => setSelectedInvestor(investor.username)}>
                <span className="filter-investor-name">
                  <strong>{investor.fullName}</strong>
                  <small>@{investor.username}</small>
                </span>
                <span className="filter-investor-gains">
                  <small>Od roku <b className={gainTone(investor.gainYtd)}>{formatPercent(investor.gainYtd, true)}</b></small>
                  <small>2 lata <b className={gainTone(investor.gainTwoYears)}>{formatPercent(investor.gainTwoYears, true)}</b></small>
                </span>
              </button>
            ))}
          </div>
          <button className={`strip-arrow ${investorScroll.right ? "" : "is-hidden"}`} type="button" onClick={() => scrollStrip(investorStripRef, 1)} disabled={!investorScroll.right} aria-label="Pokaż kolejnych inwestorów">›</button>
        </div>
      </section>

      <section className="investors-section" aria-labelledby="investors-title">
        <div className="section-heading">
          <div><span className="section-kicker">Profile i wyniki</span><h2 id="investors-title">Obserwowani inwestorzy{data?.investors.length ? ` (${data.investors.length})` : ""}</h2></div>
          <div className="sort-controls" role="group" aria-label="Sortowanie inwestorów">
            <button type="button" className={investorSort === "slot" ? "active" : ""} onClick={() => setInvestorSort("slot")}>Domyślnie</button>
            <button type="button" className={investorSort === "gain" ? "active" : ""} onClick={() => setInvestorSort("gain")}>Zysk (rok)</button>
            <button type="button" className={investorSort === "risk" ? "active" : ""} onClick={() => setInvestorSort("risk")}>Ryzyko</button>
            <button type="button" className={investorSort === "activity" ? "active" : ""} onClick={() => setInvestorSort("activity")}>Aktywność</button>
          </div>
        </div>
        <div className="investor-grid">
          {data?.investors.length ? sortedInvestors.map((investor) => (
            <InvestorCard
              key={investor.username}
              investor={investor}
              selected={selectedInvestor === investor.username}
              onOpenPortfolio={() => setPortfolioUsername(investor.username)}
            />
          )) : [1, 2, 3].map((value) => <div className="card-loading" key={value} />)}
        </div>
        <p className="returns-note">
          Stopy zwrotu są wartościami pola <code>gain</code> zwróconymi przez eToro:
          od początku roku (<code>CurrYear</code>) i za ostatnie 2 lata
          (<code>LastTwoYears</code>). Giełda Operacje ich nie przelicza.
        </p>
      </section>

      {portfolioInvestor && (
        <PortfolioDialog
          key={portfolioInvestor.username}
          investor={portfolioInvestor}
          positions={portfolioPositions}
          events={portfolioEvents}
          recentTradesLoading={recentTradesLoading}
          recentTradesError={recentTradesError}
          onClose={() => setPortfolioUsername(null)}
        />
      )}

      {selectedSummary && (
        <SummaryDialog
          summary={selectedSummary}
          people={selectedSummaryPeople}
          investors={data?.investors ?? []}
          allEvents={data?.events ?? []}
          date={selectedDate}
          onClose={() => setSelectedSummaryKey(null)}
          onOpenInvestor={(username) => {
            setSelectedSummaryKey(null);
            setPortfolioUsername(username);
          }}
        />
      )}

      <footer>
        <p>Giełda Operacje jest narzędziem wyłącznie informacyjnym. Nie posiada funkcji kopiowania ani wykonywania transakcji.</p>
        <span>Strefa czasu: Europe/Warsaw</span>
      </footer>
    </main>
  );
}
