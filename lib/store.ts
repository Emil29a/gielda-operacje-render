import { getD1 } from "../db";
import type { LibsqlD1Adapter, LibsqlPreparedStatement } from "../db/libsql-d1-adapter";
import { formatWarsawDate } from "./time";
import { formatPrice } from "./format";
import type { Instrument, Investor, PortfolioPosition, TradeEvent } from "./types";

type PositionRow = PortfolioPosition & {
  username: string;
  observedAt: string;
  symbol: string;
  displayName: string;
  exchangeId: number | null;
  exchangeName: string | null;
};

export type StoredPosition = PositionRow;

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS tracked_investors (
    slot INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    cid INTEGER NOT NULL,
    full_name TEXT NOT NULL,
    avatar_url TEXT,
    risk_score INTEGER,
    daily_gain REAL,
    gain_ytd REAL,
    gain_two_years REAL,
    copiers INTEGER,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS current_positions (
    username TEXT NOT NULL,
    position_id TEXT NOT NULL,
    open_timestamp TEXT NOT NULL,
    open_rate REAL,
    instrument_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    display_name TEXT NOT NULL,
    exchange_id INTEGER,
    exchange_name TEXT,
    is_buy INTEGER NOT NULL,
    leverage REAL,
    investment_pct REAL,
    net_profit REAL,
    take_profit_rate REAL,
    stop_loss_rate REAL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (username, position_id)
  )`,
  `CREATE TABLE IF NOT EXISTS trade_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    position_id TEXT NOT NULL,
    instrument_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    display_name TEXT NOT NULL,
    exchange_id INTEGER,
    exchange_name TEXT,
    is_buy INTEGER NOT NULL,
    open_rate REAL,
    leverage REAL,
    investment_pct REAL,
    net_profit REAL,
    precision TEXT NOT NULL,
    note TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_trade_events_occurred_at
    ON trade_events(occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_trade_events_username_occurred_at
    ON trade_events(username, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_current_positions_username
    ON current_positions(username)`,
];

export async function ensureSchema() {
  const d1 = getD1();
  await d1.batch(schemaStatements.map((statement) => d1.prepare(statement)));
  const columns = await d1
    .prepare("PRAGMA table_info(tracked_investors)")
    .all<{ name: string }>();
  const columnNames = new Set(columns.results.map((column) => column.name));
  const additions: LibsqlPreparedStatement[] = [];
  if (!columnNames.has("gain_ytd")) {
    additions.push(d1.prepare("ALTER TABLE tracked_investors ADD COLUMN gain_ytd REAL"));
  }
  if (!columnNames.has("gain_two_years")) {
    additions.push(
      d1.prepare("ALTER TABLE tracked_investors ADD COLUMN gain_two_years REAL"),
    );
  }
  if (!columnNames.has("active_since")) {
    additions.push(d1.prepare("ALTER TABLE tracked_investors ADD COLUMN active_since TEXT"));
  }
  if (!columnNames.has("annualized_return")) {
    additions.push(d1.prepare("ALTER TABLE tracked_investors ADD COLUMN annualized_return REAL"));
  }
  if (!columnNames.has("rank_position")) {
    additions.push(d1.prepare("ALTER TABLE tracked_investors ADD COLUMN rank_position INTEGER"));
  }
  if (!columnNames.has("rank_pool_size")) {
    additions.push(d1.prepare("ALTER TABLE tracked_investors ADD COLUMN rank_pool_size INTEGER"));
  }
  if (additions.length) await d1.batch(additions);

  const positionColumns = await d1
    .prepare("PRAGMA table_info(current_positions)")
    .all<{ name: string }>();
  const positionColumnNames = new Set(positionColumns.results.map((column) => column.name));
  const eventColumns = await d1
    .prepare("PRAGMA table_info(trade_events)")
    .all<{ name: string }>();
  const eventColumnNames = new Set(eventColumns.results.map((column) => column.name));
  const marketAdditions: LibsqlPreparedStatement[] = [];
  if (!positionColumnNames.has("exchange_id")) marketAdditions.push(d1.prepare("ALTER TABLE current_positions ADD COLUMN exchange_id INTEGER"));
  if (!positionColumnNames.has("exchange_name")) marketAdditions.push(d1.prepare("ALTER TABLE current_positions ADD COLUMN exchange_name TEXT"));
  if (!eventColumnNames.has("exchange_id")) marketAdditions.push(d1.prepare("ALTER TABLE trade_events ADD COLUMN exchange_id INTEGER"));
  if (!eventColumnNames.has("exchange_name")) marketAdditions.push(d1.prepare("ALTER TABLE trade_events ADD COLUMN exchange_name TEXT"));
  if (marketAdditions.length) await d1.batch(marketAdditions);
}

export async function listInvestors(): Promise<Investor[]> {
  const result = await getD1()
    .prepare(
      `SELECT i.slot, i.username, i.cid, i.full_name, i.avatar_url,
        i.risk_score, i.daily_gain, i.gain_ytd, i.gain_two_years,
        i.copiers, i.updated_at, i.active_since,
        i.annualized_return, i.rank_position, i.rank_pool_size,
        COUNT(p.position_id) AS open_positions
      FROM tracked_investors i
      LEFT JOIN current_positions p ON p.username = i.username
      GROUP BY i.slot, i.username, i.cid, i.full_name, i.avatar_url,
        i.risk_score, i.daily_gain, i.gain_ytd, i.gain_two_years,
        i.copiers, i.updated_at, i.active_since,
        i.annualized_return, i.rank_position, i.rank_pool_size
      ORDER BY i.slot`,
    )
    .all<Record<string, unknown>>();
  return result.results.map((row) => ({
    slot: Number(row.slot),
    username: String(row.username),
    cid: Number(row.cid),
    fullName: String(row.full_name),
    avatarUrl: row.avatar_url ? String(row.avatar_url) : null,
    riskScore: row.risk_score == null ? null : Number(row.risk_score),
    dailyGain: row.daily_gain == null ? null : Number(row.daily_gain),
    gainYtd: row.gain_ytd == null ? null : Number(row.gain_ytd),
    gainTwoYears: row.gain_two_years == null ? null : Number(row.gain_two_years),
    copiers: row.copiers == null ? null : Number(row.copiers),
    updatedAt: String(row.updated_at),
    activeSince: row.active_since ? String(row.active_since) : null,
    annualizedReturn: row.annualized_return == null ? null : Number(row.annualized_return),
    rankPosition: row.rank_position == null ? null : Number(row.rank_position),
    rankPoolSize: row.rank_pool_size == null ? null : Number(row.rank_pool_size),
    openPositions: Number(row.open_positions ?? 0),
  }));
}

export async function replaceInvestors(investors: Investor[], clearHistory = false) {
  const d1 = getD1();
  const cleanup = [
    d1.prepare("DELETE FROM current_positions"),
    d1.prepare("DELETE FROM tracked_investors"),
  ];
  if (clearHistory) {
    cleanup.push(
      d1.prepare("DELETE FROM trade_events"),
      d1.prepare("DELETE FROM app_state WHERE key = 'last_sync'"),
    );
  }
  await d1.batch(cleanup);
  await d1.batch(
    investors.map((investor, index) =>
      d1
        .prepare(
          `INSERT INTO tracked_investors
          (slot, username, cid, full_name, avatar_url, risk_score, daily_gain,
           gain_ytd, gain_two_years, copiers, updated_at, active_since,
           annualized_return, rank_position, rank_pool_size)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          index + 1,
          investor.username,
          investor.cid,
          investor.fullName,
          investor.avatarUrl,
          investor.riskScore,
          investor.dailyGain,
          investor.gainYtd,
          investor.gainTwoYears,
          investor.copiers,
          investor.updatedAt,
          investor.activeSince ?? null,
          investor.annualizedReturn ?? null,
          investor.rankPosition ?? null,
          investor.rankPoolSize ?? null,
        ),
    ),
  );
}

export async function updateInvestors(investors: Investor[]) {
  const d1 = getD1();
  await d1.batch(
    investors.map((investor) =>
      d1
        .prepare(
          // slot (the primary key) is deliberately not updated here: it's
          // assigned once when a row is first seeded and must never change
          // afterward. Callers resolving a small subset of investors (e.g.
          // synchronizePositionsOnly's paced identity/profile batches) only
          // know each investor's position *within that batch*, not their
          // true slot among all tracked investors — writing that batch-local
          // number over the real slot risked colliding with another
          // investor's slot (both being a small number like 0-5), which
          // fails on tracked_investors' UNIQUE/PRIMARY KEY constraint.
          // active_since/annualized_return/rank_position/rank_pool_size all
          // use COALESCE(new, existing): the cheap identity-only resolve
          // (resolveInvestorIdentities) doesn't fetch any of this, so it
          // always passes null here — without COALESCE, running it for an
          // investor who'd already gone through a full resolve would wipe
          // out data that call already had.
          `UPDATE tracked_investors
          SET cid = ?, full_name = ?, avatar_url = ?, risk_score = ?,
              daily_gain = ?, gain_ytd = ?, gain_two_years = ?, copiers = ?, updated_at = ?,
              active_since = COALESCE(?, active_since),
              annualized_return = COALESCE(?, annualized_return),
              rank_position = COALESCE(?, rank_position),
              rank_pool_size = COALESCE(?, rank_pool_size)
          WHERE LOWER(username) = LOWER(?)`,
        )
        .bind(
          investor.cid,
          investor.fullName,
          investor.avatarUrl,
          investor.riskScore,
          investor.dailyGain,
          investor.gainYtd,
          investor.gainTwoYears,
          investor.copiers,
          investor.updatedAt,
          investor.activeSince ?? null,
          investor.annualizedReturn ?? null,
          investor.rankPosition ?? null,
          investor.rankPoolSize ?? null,
          investor.username,
        ),
    ),
  );
}

export async function getState(key: string) {
  const row = await getD1()
    .prepare("SELECT value FROM app_state WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function getStateWithTimestamp(key: string) {
  const row = await getD1()
    .prepare("SELECT value, updated_at FROM app_state WHERE key = ?")
    .bind(key)
    .first<{ value: string; updated_at: string }>();
  return row ?? null;
}

export async function setState(key: string, value: string) {
  const now = new Date().toISOString();
  await getD1()
    .prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, now)
    .run();
}

function toPosition(row: Record<string, unknown>): PositionRow {
  return {
    username: String(row.username),
    positionId: String(row.position_id),
    openTimestamp: String(row.open_timestamp),
    openRate: row.open_rate == null ? null : Number(row.open_rate),
    instrumentId: Number(row.instrument_id),
    symbol: String(row.symbol),
    displayName: String(row.display_name),
    exchangeId: row.exchange_id == null ? null : Number(row.exchange_id),
    exchangeName: row.exchange_name == null ? null : String(row.exchange_name),
    isBuy: Boolean(row.is_buy),
    leverage: row.leverage == null ? null : Number(row.leverage),
    investmentPct: row.investment_pct == null ? null : Number(row.investment_pct),
    netProfit: row.net_profit == null ? null : Number(row.net_profit),
    takeProfitRate: row.take_profit_rate == null ? null : Number(row.take_profit_rate),
    stopLossRate: row.stop_loss_rate == null ? null : Number(row.stop_loss_rate),
    observedAt: String(row.observed_at),
  };
}

function buildEventStatement(
  d1: LibsqlD1Adapter,
  investor: Investor,
  eventType: "OPEN" | "CLOSE" | "UPDATE",
  position: PortfolioPosition,
  instrument: Instrument,
  observedAt: string,
  occurredAt: string,
  precision: "exact" | "detected",
  note: string,
): LibsqlPreparedStatement {
  return d1
    .prepare(
      `INSERT INTO trade_events
      (username, event_type, occurred_at, detected_at, position_id, instrument_id,
       symbol, display_name, exchange_id, exchange_name, is_buy, open_rate, leverage, investment_pct, net_profit,
       precision, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      investor.username,
      eventType,
      occurredAt,
      observedAt,
      position.positionId,
      position.instrumentId,
      instrument.symbol,
      instrument.displayName,
      instrument.exchangeId,
      instrument.exchangeName,
      position.isBuy ? 1 : 0,
      position.openRate,
      position.leverage,
      position.investmentPct,
      position.netProfit,
      precision,
      note,
    );
}

// Returns a human-readable description of what changed between two
// snapshots of the same position (e.g. "dźwignia: 2x → 3x"), or null if
// nothing crossed the tolerance threshold — this doubles as both the
// "did anything change" check and the UPDATE event's note text, so the
// journal can say specifically what happened instead of just "zmienił
// pozycję" with no further detail.
export function describeChange(previous: PositionRow, current: PortfolioPosition): string | null {
  // A field going from unset to set (or vice versa) — e.g. a take-profit
  // being added or removed — is itself a real change, not something to
  // silently ignore just because only one side has a number to diff against.
  const diff = (a: number | null, b: number | null, tolerance = 0.01) => {
    if (a == null && b == null) return false;
    if (a == null || b == null) return true;
    return Math.abs(a - b) >= tolerance;
  };
  const formatPct = (value: number | null) => value == null ? "—" : `${value.toFixed(2)}%`;
  const formatLeverage = (value: number | null) => value == null ? "—" : `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(2)}x`;
  const formatRate = (value: number | null) => value == null ? "brak" : value.toFixed(4);

  const parts: string[] = [];
  if (diff(previous.investmentPct, current.investmentPct, 0.05)) {
    parts.push(`wielkość pozycji: ${formatPct(previous.investmentPct)} → ${formatPct(current.investmentPct)}`);
  }
  if (diff(previous.leverage, current.leverage)) {
    parts.push(`dźwignia: ${formatLeverage(previous.leverage)} → ${formatLeverage(current.leverage)}`);
  }
  if (diff(previous.takeProfitRate, current.takeProfitRate)) {
    parts.push(`take-profit: ${formatRate(previous.takeProfitRate)} → ${formatRate(current.takeProfitRate)}`);
  }
  if (diff(previous.stopLossRate, current.stopLossRate)) {
    parts.push(`stop-loss: ${formatRate(previous.stopLossRate)} → ${formatRate(current.stopLossRate)}`);
  }
  if (!parts.length) return null;
  return `Zmieniono ${parts.join(", ")}.`;
}

// D1 counts every prepared statement executed as its own request against the
// free plan's ~50-per-invocation cap, but a single d1.batch() call — however
// many statements it carries — counts as just one. syncInvestorPositions used
// to run 2-3 awaited statements per investor (plus one more per detected
// event), so syncing all 27 tracked investors could burn 100+ requests in one
// invocation — worst of all on the very first sync, when every open position
// is "new" and gets its own event insert. This batches the whole chunk's
// reads/writes into a couple of requests regardless of investor or event
// count.
const D1_BATCH_STATEMENT_CHUNK = 200;

export async function syncPositionsForInvestors(
  portfolios: { investor: Investor; positions: PortfolioPosition[] }[],
  instruments: Map<number, Instrument>,
  observedAt: string,
) {
  const d1 = getD1();
  const usernames = portfolios.map(({ investor }) => investor.username);
  if (!usernames.length) return;

  const priorByUsername = new Map<string, PositionRow[]>();
  for (const usernameChunk of chunk(usernames, SQL_IN_CHUNK_SIZE)) {
    const placeholders = usernameChunk.map(() => "?").join(",");
    const result = await d1
      .prepare(`SELECT * FROM current_positions WHERE username IN (${placeholders})`)
      .bind(...usernameChunk)
      .all<Record<string, unknown>>();
    for (const row of result.results.map(toPosition)) {
      const list = priorByUsername.get(row.username) ?? [];
      list.push(row);
      priorByUsername.set(row.username, list);
    }
  }

  const resolveInstrument = (instrumentId: number): Instrument =>
    instruments.get(instrumentId) ?? {
      instrumentId,
      symbol: `#${instrumentId}`,
      displayName: `Instrument ${instrumentId}`,
      exchangeId: null,
      exchangeName: null,
      logoUrl: null,
    };

  const statements: LibsqlPreparedStatement[] = [];
  for (const { investor, positions } of portfolios) {
    const prior = priorByUsername.get(investor.username) ?? [];
    const priorMap = new Map(prior.map((position) => [position.positionId, position]));
    const nextMap = new Map(positions.map((position) => [position.positionId, position]));

    for (const position of positions) {
      const before = priorMap.get(position.positionId);
      const instrument = resolveInstrument(position.instrumentId);
      if (!before) {
        statements.push(buildEventStatement(
          d1, investor, "OPEN", position, instrument, observedAt, position.openTimestamp,
          "exact", "Czas otwarcia pochodzi bezpośrednio z bieżącego portfela eToro.",
        ));
      } else {
        const description = describeChange(before, position);
        if (description) {
          statements.push(buildEventStatement(
            d1, investor, "UPDATE", position, instrument, observedAt, observedAt,
            "detected", description,
          ));
        }
      }
    }

    for (const position of prior) {
      if (nextMap.has(position.positionId)) continue;
      statements.push(buildEventStatement(
        d1, investor, "CLOSE", position, {
          instrumentId: position.instrumentId,
          symbol: position.symbol,
          displayName: position.displayName,
          exchangeId: position.exchangeId,
          exchangeName: position.exchangeName,
        }, observedAt, observedAt,
        "detected", `Otwarta ${formatWarsawDate(position.openTimestamp)} po kursie ${formatPrice(position.openRate)}. Pozycja zniknęła z publicznego portfela; podany czas jest czasem wykrycia.`,
      ));
    }

    statements.push(d1.prepare("DELETE FROM current_positions WHERE username = ?").bind(investor.username));
    for (const position of positions) {
      const instrument = resolveInstrument(position.instrumentId);
      statements.push(
        d1
          .prepare(
            `INSERT INTO current_positions
            (username, position_id, open_timestamp, open_rate, instrument_id, symbol,
             display_name, exchange_id, exchange_name, is_buy, leverage, investment_pct, net_profit, take_profit_rate,
             stop_loss_rate, observed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            investor.username,
            position.positionId,
            position.openTimestamp,
            position.openRate,
            position.instrumentId,
            instrument.symbol,
            instrument.displayName,
            instrument.exchangeId,
            instrument.exchangeName,
            position.isBuy ? 1 : 0,
            position.leverage,
            position.investmentPct,
            position.netProfit,
            position.takeProfitRate,
            position.stopLossRate,
            observedAt,
          ),
      );
    }
  }

  for (const statementChunk of chunk(statements, D1_BATCH_STATEMENT_CHUNK)) {
    await d1.batch(statementChunk);
  }
}

function toTradeEvent(row: Record<string, unknown>): TradeEvent {
  return {
    id: Number(row.id),
    username: String(row.username),
    eventType: String(row.event_type) as TradeEvent["eventType"],
    occurredAt: String(row.occurred_at),
    detectedAt: String(row.detected_at),
    positionId: String(row.position_id),
    instrumentId: Number(row.instrument_id),
    symbol: String(row.symbol),
    displayName: String(row.display_name),
    exchangeId: row.exchange_id == null ? null : Number(row.exchange_id),
    exchangeName: row.exchange_name == null ? null : String(row.exchange_name),
    isBuy: Boolean(row.is_buy),
    openRate: row.open_rate == null ? null : Number(row.open_rate),
    leverage: row.leverage == null ? null : Number(row.leverage),
    investmentPct: row.investment_pct == null ? null : Number(row.investment_pct),
    netProfit: row.net_profit == null ? null : Number(row.net_profit),
    closeRate: null,
    precision: String(row.precision) as TradeEvent["precision"],
    note: String(row.note),
    currentRate: null,
    currentRateAt: null,
    priceChangePct: null,
    priceDirection: "unknown",
    quoteStatus: "unavailable",
    rateKind: "current",
  };
}

export async function listEvents(): Promise<TradeEvent[]> {
  const result = await getD1()
    .prepare("SELECT * FROM trade_events ORDER BY occurred_at DESC, id DESC LIMIT 1000")
    .all<Record<string, unknown>>();
  return result.results.map(toTradeEvent);
}

// Unlike listEvents (capped at 1000 for the single-day journal view), this
// pulls every event since a given timestamp uncapped — used for the
// recent-activity summary, which aggregates across several days and would
// silently under-count buyers/sellers for busy instruments if truncated.
export async function listEventsSince(sinceIso: string): Promise<TradeEvent[]> {
  const result = await getD1()
    .prepare("SELECT * FROM trade_events WHERE occurred_at >= ? ORDER BY occurred_at DESC, id DESC")
    .bind(sinceIso)
    .all<Record<string, unknown>>();
  return result.results.map(toTradeEvent);
}

export async function listCurrentPositions(): Promise<StoredPosition[]> {
  const result = await getD1()
    .prepare("SELECT * FROM current_positions ORDER BY username, open_timestamp DESC")
    .all<Record<string, unknown>>();
  return result.results.map(toPosition);
}

type KnownInstrument = {
  symbol: string;
  displayName: string;
  exchangeId: number | null;
  exchangeName: string | null;
};

// D1 rejects a bound-parameter count much above 100, so any IN (...) lookup
// over an id list must be chunked rather than sent as one query.
const SQL_IN_CHUNK_SIZE = 50;
function chunk<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, index * size + size),
  );
}

// eToro's own instrument metadata is effectively static, so a symbol/name we
// already captured for this instrument on any past event or open position —
// for any investor, any day — is still accurate today. This lets an
// instrument that appears in today's history but couldn't be resolved live
// (e.g. eToro's rate limit) still show its real name instead of a
// "#id · Instrument id" placeholder, without any additional API call.
export async function findKnownInstruments(
  instrumentIds: number[],
): Promise<Map<number, KnownInstrument>> {
  const ids = [...new Set(instrumentIds)].filter(Number.isFinite);
  if (!ids.length) return new Map();
  const d1 = getD1();
  const idChunks = chunk(ids, SQL_IN_CHUNK_SIZE);
  const rowSets = await Promise.all(idChunks.flatMap((idChunk) => {
    const placeholders = idChunk.map(() => "?").join(",");
    return [
      d1.prepare(
        `SELECT instrument_id, symbol, display_name, exchange_id, exchange_name
         FROM trade_events WHERE instrument_id IN (${placeholders})`,
      ).bind(...idChunk).all<Record<string, unknown>>(),
      d1.prepare(
        `SELECT instrument_id, symbol, display_name, exchange_id, exchange_name
         FROM current_positions WHERE instrument_id IN (${placeholders})`,
      ).bind(...idChunk).all<Record<string, unknown>>(),
    ];
  }));
  const result = new Map<number, KnownInstrument>();
  for (const row of rowSets.flatMap((rowSet) => rowSet.results)) {
    const instrumentId = Number(row.instrument_id);
    if (result.has(instrumentId)) continue;
    const symbol = String(row.symbol);
    const displayName = String(row.display_name);
    // A row can itself carry the "#id" / "Instrument id" placeholder — sync
    // wrote it that way at the time because a live lookup failed then (rate
    // limit, transient error). Treating that placeholder as "known good"
    // would permanently poison fetchInstruments' D1 cache with it (it's
    // cached indefinitely once found "known"), so any instrument whose only
    // stored occurrences are placeholders is skipped here and falls through
    // to a real live lookup instead.
    if (symbol === `#${instrumentId}` && displayName === `Instrument ${instrumentId}`) continue;
    result.set(instrumentId, {
      symbol,
      displayName,
      exchangeId: row.exchange_id == null ? null : Number(row.exchange_id),
      exchangeName: row.exchange_name == null ? null : String(row.exchange_name),
    });
  }
  return result;
}

export async function findKnownExchangeNames(
  exchangeIds: number[],
): Promise<Map<number, string>> {
  const ids = [...new Set(exchangeIds)].filter(Number.isFinite);
  if (!ids.length) return new Map();
  const d1 = getD1();
  const idChunks = chunk(ids, SQL_IN_CHUNK_SIZE);
  const rowSets = await Promise.all(idChunks.flatMap((idChunk) => {
    const placeholders = idChunk.map(() => "?").join(",");
    return [
      d1.prepare(
        `SELECT exchange_id, exchange_name FROM trade_events
         WHERE exchange_id IN (${placeholders}) AND exchange_name IS NOT NULL`,
      ).bind(...idChunk).all<Record<string, unknown>>(),
      d1.prepare(
        `SELECT exchange_id, exchange_name FROM current_positions
         WHERE exchange_id IN (${placeholders}) AND exchange_name IS NOT NULL`,
      ).bind(...idChunk).all<Record<string, unknown>>(),
    ];
  }));
  const result = new Map<number, string>();
  for (const row of rowSets.flatMap((rowSet) => rowSet.results)) {
    const exchangeId = Number(row.exchange_id);
    if (!result.has(exchangeId) && row.exchange_name) {
      result.set(exchangeId, String(row.exchange_name));
    }
  }
  return result;
}
