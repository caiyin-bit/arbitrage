import type { ExchangeName } from "./constants";

export interface FundingRate {
  exchange: ExchangeName;
  symbol: string;
  currentRate: number;
  predictedRate: number | null;
  nextSettlement: Date;
  intervalHours: number;
  timestamp: Date;
}

export interface OpportunitySignal {
  symbol: string;
  longExchange: ExchangeName;
  shortExchange: ExchangeName;
  longRate: number;
  shortRate: number;
  rateSpread: number;
  annualizedYield: number;
  suggestedSize: number;
}

export interface Ticker {
  exchange: ExchangeName;
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  timestamp: Date;
}

export interface Balance {
  currency: string;
  total: number;
  free: number;
  used: number;
}

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
