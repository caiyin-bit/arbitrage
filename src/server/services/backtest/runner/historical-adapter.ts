import { prisma } from "@/server/db/client";
import type {
  ExchangeAdapter,
  OpenParams,
  CloseParams,
  Order,
  SymbolInfo,
  FundingPayment,
} from "@/server/services/exchange/types";
import type { FundingRate, Ticker, Balance, OHLCV } from "@/lib/types";
import type { ExchangeName } from "@/lib/constants";
import type { Clock } from "@/server/services/executor/types";
import type { FailureInjector } from "./failure-injector";
import { applySlippage } from "./slippage";

export class HistoricalAdapter implements ExchangeAdapter {
  readonly name: string;

  constructor(
    private readonly exchangeName: string,
    private readonly clock: Clock,
    private readonly failure: FailureInjector,
    private readonly slippageBps: number,
  ) {
    this.name = exchangeName;
  }

  private async lastKline(symbol: string) {
    const row = await prisma.ohlcvSnapshot.findFirst({
      where: {
        exchange: { name: this.exchangeName },
        symbol,
        openTime: { lte: this.clock.now() },
      },
      orderBy: { openTime: "desc" },
    });
    if (!row) {
      throw new Error(
        `no historical data for ${this.exchangeName} ${symbol} @ ${this.clock.now().toISOString()}`,
      );
    }
    return row;
  }

  async openPosition(params: OpenParams): Promise<Order> {
    if (this.failure.shouldFail("open")) {
      throw new Error(`Simulated open failure ${params.clientOrderId}`);
    }
    const k = await this.lastKline(params.symbol);
    const execPrice = applySlippage(Number(k.close), params.side, this.slippageBps);
    return {
      id: `backtest-${params.clientOrderId}`,
      clientOrderId: params.clientOrderId,
      symbol: params.symbol,
      side: params.side,
      status: "filled",
      price: execPrice,
      filledSize: params.size,
      fee: execPrice * params.size * 0.0005,
      timestamp: this.clock.now(),
    };
  }

  async closePosition(params: CloseParams): Promise<Order> {
    if (this.failure.shouldFail("close")) {
      throw new Error(`Simulated close failure ${params.clientOrderId}`);
    }
    const k = await this.lastKline(params.symbol);
    // Closing a long sells at bid (slippage goes against the closer), closing a short buys at ask.
    // Reverse the side so slippage works against the position being closed.
    const closeSide = params.side === "long" ? "short" : "long";
    const execPrice = applySlippage(Number(k.close), closeSide, this.slippageBps);
    return {
      id: `backtest-${params.clientOrderId}`,
      clientOrderId: params.clientOrderId,
      symbol: params.symbol,
      side: params.side,
      status: "filled",
      price: execPrice,
      filledSize: params.size,
      fee: execPrice * params.size * 0.0005,
      timestamp: this.clock.now(),
    };
  }

  async getPrice(symbol: string): Promise<Ticker> {
    const k = await this.lastKline(symbol);
    const last = Number(k.close);
    return {
      exchange: this.exchangeName as ExchangeName,
      symbol,
      last,
      bid: last,
      ask: last,
      timestamp: k.openTime,
    };
  }

  async getKline(symbol: string, timeframe: "1h" | "1d", limit: number): Promise<OHLCV[]> {
    const rows = await prisma.ohlcvSnapshot.findMany({
      where: {
        exchange: { name: this.exchangeName },
        symbol,
        timeframe,
        openTime: { lte: this.clock.now() },
      },
      orderBy: { openTime: "desc" },
      take: limit,
    });
    return rows
      .reverse()
      .map((r) => ({
        timestamp: r.openTime.getTime(),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      }));
  }

  async getOrder(_orderId: string): Promise<Order> {
    throw new Error("getOrder: not supported in backtest");
  }

  async getFundingRates(_symbols: string[]): Promise<FundingRate[]> {
    throw new Error("getFundingRates: not supported in backtest");
  }

  async getNextSettlementTime(_symbol: string): Promise<Date> {
    throw new Error("getNextSettlementTime: not supported in backtest");
  }

  async getBalances(): Promise<Balance[]> {
    throw new Error("getBalances: not supported in backtest");
  }

  async getSymbols(): Promise<SymbolInfo[]> {
    throw new Error("getSymbols: not supported in backtest");
  }

  async getFeeRate(): Promise<number> {
    return 0.0005;
  }

  async testConnection(): Promise<boolean> {
    return true;
  }

  async getFundingHistory(_symbol: string, _since: Date): Promise<FundingPayment[]> {
    throw new Error("getFundingHistory: not supported in backtest");
  }
}
