import type { ExchangeName } from "@/lib/constants";

export interface BacktestConfig {
  from: Date;
  to: Date;
  initialCapital: number;
  /**
   * Per-leg notional in USD. Runner converts to base-asset quantity at open
   * time via `positionSize / currentPrice` before calling openHedgedPosition.
   * (Production executor takes base-asset units; this conversion is a
   * backtest-only concern.)
   */
  positionSize: number;
  maxConcurrent: number;
  minSpread: number;
  minApy: number;
  slippageBps: number;
  failureRate: number;
  seed: string;
  healthIntervalSec: number;
  volatilityPauseEnabled: boolean;
  volatilityThreshold1h: number;   // default 0.05 — matches production seed
  volatilityThreshold24h: number;  // default 0.15 — matches production seed
  rateReversalExit: boolean;        // stub — not yet wired (no production code reads it)
  minHoldingPeriods: number;        // stub — not yet wired
  exchanges?: ExchangeName[];
}

export const DEFAULT_CONFIG: BacktestConfig = {
  from: new Date(Date.now() - 180 * 24 * 3600_000),
  to: new Date(),
  initialCapital: 10_000,
  positionSize: 500,
  maxConcurrent: 3,
  minSpread: 0.0005,
  minApy: 0.1,
  slippageBps: 3,
  failureRate: 0.02,
  seed: "plan4-default",
  healthIntervalSec: 300,
  volatilityPauseEnabled: true,
  volatilityThreshold1h: 0.05,
  volatilityThreshold24h: 0.15,
  rateReversalExit: true,
  minHoldingPeriods: 1,
};

export interface Phase0Opportunity {
  at: Date;
  symbol: string;
  longExchange: string;
  shortExchange: string;
  rateSpread: number;
  annualizedYield: number;
}

export interface Phase0Result {
  opportunities: Phase0Opportunity[];
  theoreticalPnl: number;
  verdict: "positive" | "weak" | "negative";
}

export interface ClosedTrade {
  positionId: string;
  symbol: string;
  longExchange: string;
  shortExchange: string;
  openedAt: Date;
  closedAt: Date;
  longEntry: number;
  shortEntry: number;
  longExit: number;
  shortExit: number;
  longSize: number;
  shortSize: number;
  grossPnl: number;
  fees: number;
  fundingPnl: number;
  netPnl: number;
  holdHours: number;
}

export interface EquityCurvePoint {
  date: Date;
  equity: number;
  grossPnl: number;
  netPnl: number;
  totalFees: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  startedAt: Date;
  finishedAt: Date;
  closedTrades: ClosedTrade[];
  equityCurve: EquityCurvePoint[];
}
