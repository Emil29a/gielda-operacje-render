import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const trackedInvestors = sqliteTable("tracked_investors", {
  slot: integer("slot").primaryKey(),
  username: text("username").notNull().unique(),
  cid: integer("cid").notNull(),
  fullName: text("full_name").notNull(),
  avatarUrl: text("avatar_url"),
  riskScore: integer("risk_score"),
  dailyGain: real("daily_gain"),
  gainYtd: real("gain_ytd"),
  gainTwoYears: real("gain_two_years"),
  copiers: integer("copiers"),
  updatedAt: text("updated_at").notNull(),
});

export const currentPositions = sqliteTable(
  "current_positions",
  {
    username: text("username").notNull(),
    positionId: text("position_id").notNull(),
    openTimestamp: text("open_timestamp").notNull(),
    openRate: real("open_rate"),
    instrumentId: integer("instrument_id").notNull(),
    symbol: text("symbol").notNull(),
    displayName: text("display_name").notNull(),
    exchangeId: integer("exchange_id"),
    exchangeName: text("exchange_name"),
    isBuy: integer("is_buy", { mode: "boolean" }).notNull(),
    leverage: real("leverage"),
    investmentPct: real("investment_pct"),
    netProfit: real("net_profit"),
    takeProfitRate: real("take_profit_rate"),
    stopLossRate: real("stop_loss_rate"),
    observedAt: text("observed_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.username, table.positionId] }),
    index("idx_current_positions_username").on(table.username),
  ],
);

export const tradeEvents = sqliteTable(
  "trade_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    username: text("username").notNull(),
    eventType: text("event_type").notNull(),
    occurredAt: text("occurred_at").notNull(),
    detectedAt: text("detected_at").notNull(),
    positionId: text("position_id").notNull(),
    instrumentId: integer("instrument_id").notNull(),
    symbol: text("symbol").notNull(),
    displayName: text("display_name").notNull(),
    exchangeId: integer("exchange_id"),
    exchangeName: text("exchange_name"),
    isBuy: integer("is_buy", { mode: "boolean" }).notNull(),
    openRate: real("open_rate"),
    leverage: real("leverage"),
    investmentPct: real("investment_pct"),
    netProfit: real("net_profit"),
    precision: text("precision").notNull(),
    note: text("note").notNull(),
  },
  (table) => [
    index("idx_trade_events_occurred_at").on(table.occurredAt),
    index("idx_trade_events_username_occurred_at").on(table.username, table.occurredAt),
  ],
);

export const appState = sqliteTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});
