import type {
  ExchangeAdapter,
  OpenParams,
  CloseParams,
  Order,
  SymbolInfo,
  FundingPayment,
} from "./types";
import type { FundingRate, Ticker, Balance, OHLCV } from "@/lib/types";

// Dev-only synthetic adapter. Produces deterministic fake data so the
// opportunity detector, position open/close flow, and settlement pipeline
// can be exercised end-to-end against a local OKX account without a second
// real venue. Trade methods return plausible fake-filled orders so the UI
// flow completes; no real network requests are made.
export class MockBinanceAdapter implements ExchangeAdapter {
  readonly name = "mock-binance";

  constructor(
    _apiKey: string,
    _apiSecret: string,
    _passphrase?: string,
  ) {
    // Unused — constructor signature matches the other adapters for
    // factory compatibility.
  }

  async getFundingRates(_symbols: string[]): Promise<FundingRate[]> {
    // Rates for mock-binance are synthesized from real rates in the
    // collector's post-processing step (see funding-rate.ts).
    return [];
  }

  async getNextSettlementTime(_symbol: string): Promise<Date> {
    return new Date(Math.ceil(Date.now() / 28_800_000) * 28_800_000);
  }

  async getPrice(symbol: string): Promise<Ticker> {
    return {
      exchange: "mock-binance" as any,
      symbol,
      last: 0,
      bid: 0,
      ask: 0,
      timestamp: new Date(),
    };
  }

  async getKline(): Promise<OHLCV[]> {
    return [];
  }

  async getBalances(): Promise<Balance[]> {
    return [{ currency: "USDT", total: 100_000, free: 100_000, used: 0 }];
  }

  async openPosition(params: OpenParams): Promise<Order> {
    return {
      id: `mock-${Date.now()}`,
      clientOrderId: params.clientOrderId,
      symbol: params.symbol,
      side: params.side,
      price: 0,
      filledSize: params.size,
      fee: 0,
      status: "filled",
      timestamp: new Date(),
    };
  }

  async closePosition(params: CloseParams): Promise<Order> {
    return {
      id: `mock-${Date.now()}`,
      clientOrderId: params.clientOrderId,
      symbol: params.symbol,
      side: params.side,
      price: 0,
      filledSize: params.size,
      fee: 0,
      status: "filled",
      timestamp: new Date(),
    };
  }

  async getOrder(orderId: string): Promise<Order> {
    return {
      id: orderId,
      clientOrderId: orderId,
      symbol: "BTC/USDT:USDT",
      side: "long",
      price: 0,
      filledSize: 0,
      fee: 0,
      status: "filled",
      timestamp: new Date(),
    };
  }

  async getSymbols(): Promise<SymbolInfo[]> {
    return [];
  }

  async getFeeRate(): Promise<number> {
    return 0.0004;
  }

  async testConnection(): Promise<boolean> {
    return true;
  }

  async getFundingHistory(
    _symbol: string,
    _since: Date,
  ): Promise<FundingPayment[]> {
    return [];
  }
}
