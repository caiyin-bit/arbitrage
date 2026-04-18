import type { ExchangeName } from "@/lib/constants";

export interface BacktestConfig {
  from: Date;
  to: Date;
  initialCapital: number;
  positionSize: number;
  maxConcurrent: number;
  minSpread: number;
  minApy: number;
  slippageBps: number;
  failureRate: number;
  seed: string;
  healthIntervalSec: number;
  exchanges?: ExchangeName[];
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
