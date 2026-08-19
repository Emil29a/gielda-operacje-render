export type Investor = {
  slot: number;
  username: string;
  cid: number;
  fullName: string;
  avatarUrl: string | null;
  riskScore: number | null;
  dailyGain: number | null;
  gainYtd: number | null;
  gainTwoYears: number | null;
  copiers: number | null;
  updatedAt: string;
  openPositions?: number;
};

export type PortfolioPosition = {
  positionId: string;
  openTimestamp: string;
  openRate: number | null;
  instrumentId: number;
  isBuy: boolean;
  leverage: number | null;
  investmentPct: number | null;
  netProfit: number | null;
  takeProfitRate: number | null;
  stopLossRate: number | null;
};

export type Instrument = {
  instrumentId: number;
  symbol: string;
  displayName: string;
  exchangeId: number | null;
  exchangeName: string | null;
  logoUrl: string | null;
};

export type MarketRate = {
  instrumentId: number;
  bid: number | null;
  ask: number | null;
  lastExecution: number | null;
  currentRate: number | null;
  rateAt: string | null;
};

export type HistoricalPosition = {
  positionId: string;
  openTimestamp: string;
  openRate: number | null;
  instrumentId: number;
  isBuy: boolean;
  leverage: number | null;
  closeTimestamp: string;
  closeRate: number | null;
  netProfit: number | null;
};

export type CurrentPortfolioPosition = PortfolioPosition & Instrument & {
  username: string;
  observedAt: string;
  currentRate: number | null;
  currentRateAt: string | null;
  priceChangePct: number | null;
  priceDirection: "up" | "down" | "flat" | "unknown";
  quoteStatus: "today" | "previous" | "unavailable";
};

export type TradeEvent = {
  id: number;
  username: string;
  eventType: "OPEN" | "CLOSE" | "UPDATE";
  occurredAt: string;
  detectedAt: string;
  positionId: string;
  instrumentId: number;
  symbol: string;
  displayName: string;
  exchangeId: number | null;
  exchangeName: string | null;
  logoUrl: string | null;
  isBuy: boolean;
  openRate: number | null;
  leverage: number | null;
  investmentPct: number | null;
  netProfit: number | null;
  closeRate: number | null;
  precision: "exact" | "detected";
  note: string;
  currentRate: number | null;
  currentRateAt: string | null;
  priceChangePct: number | null;
  priceDirection: "up" | "down" | "flat" | "unknown";
  quoteStatus: "today" | "previous" | "unavailable";
  rateKind: "current" | "closing";
};

export type DashboardPayload = {
  mode: "unconfigured" | "live";
  timezone: "Europe/Warsaw";
  selectedDate: string;
  lastSync: string | null;
  investors: Investor[];
  events: TradeEvent[];
  recentEvents: TradeEvent[];
  positions: CurrentPortfolioPosition[];
  notice: string;
};

export type GainPoint = {
  date: string;
  gain: number;
};

export type InvestorExtendedStats = {
  winRatio: number | null;
  trades: number | null;
  totalTradedInstruments: number | null;
  activeWeeksPct: number | null;
  longPosPct: number | null;
  avgPosSize: number | null;
  annualizedReturn: number | null;
  topTradedInstrumentId: number | null;
  topTradedInstrumentSymbol: string | null;
  topTradedInstrumentPct: number | null;
  topTradedAssetClass: string | null;
  monthlyGains: GainPoint[];
  yearlyGains: GainPoint[];
};
