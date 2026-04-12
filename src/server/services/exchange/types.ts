import type { FundingRate, Ticker, Balance, OHLCV } from "@/lib/types";

export interface OpenParams {
  symbol: string;
  side: "long" | "short";
  size: number;
  leverage: number;
  clientOrderId: string;
}

export interface CloseParams {
  symbol: string;
  side: "long" | "short";
  size: number;
  clientOrderId: string;
}

export interface Order {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: "long" | "short";
  price: number;
  filledSize: number;
  fee: number;
  status: "filled" | "partial" | "failed";
  timestamp: Date;
}

export interface SymbolInfo {
  symbol: string;
  baseCurrency: string;
  quoteCurrency: string;
  minSize: number;
  pricePrecision: number;
  sizePrecision: number;
}

export interface ExchangeAdapter {
  readonly name: string;

  // Funding rates
  getFundingRates(symbols: string[]): Promise<FundingRate[]>;
  getNextSettlementTime(symbol: string): Promise<Date>;

  // Market data
  getPrice(symbol: string): Promise<Ticker>;
  getKline(
    symbol: string,
    timeframe: "1h" | "1d",
    limit: number,
  ): Promise<OHLCV[]>;

  // Account
  getBalances(): Promise<Balance[]>;

  // Trading
  openPosition(params: OpenParams): Promise<Order>;
  closePosition(params: CloseParams): Promise<Order>;
  getOrder(orderId: string): Promise<Order>;

  // Metadata
  getSymbols(): Promise<SymbolInfo[]>;
  getFeeRate(): Promise<number>;

  // Connection test
  testConnection(): Promise<boolean>;
}
