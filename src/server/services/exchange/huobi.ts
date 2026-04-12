import ccxt, { type Exchange } from "ccxt";
import type {
  ExchangeAdapter,
  OpenParams,
  CloseParams,
  Order,
  SymbolInfo,
  FundingPayment,
} from "./types";
import type { FundingRate, Ticker, Balance, OHLCV } from "@/lib/types";

export class HuobiAdapter implements ExchangeAdapter {
  readonly name = "huobi" as const;
  private client: Exchange;

  constructor(apiKey: string, apiSecret: string) {
    this.client = new ccxt.huobi({
      apiKey,
      secret: apiSecret,
      options: { defaultType: "swap" },
    });
  }

  async getFundingRates(symbols: string[]): Promise<FundingRate[]> {
    const rates: FundingRate[] = [];
    for (const symbol of symbols) {
      const data = await this.client.fetchFundingRate(symbol);
      rates.push({
        exchange: "huobi",
        symbol,
        currentRate: data.fundingRate ?? 0,
        predictedRate: data.nextFundingRate ?? null,
        nextSettlement: new Date(data.fundingDatetime ?? Date.now()),
        intervalHours: 8,
        timestamp: new Date(data.datetime ?? Date.now()),
      });
    }
    return rates;
  }

  async getNextSettlementTime(symbol: string): Promise<Date> {
    const data = await this.client.fetchFundingRate(symbol);
    return new Date(data.fundingDatetime ?? Date.now());
  }

  async getPrice(symbol: string): Promise<Ticker> {
    const ticker = await this.client.fetchTicker(symbol);
    return {
      exchange: "huobi",
      symbol,
      last: ticker.last ?? 0,
      bid: ticker.bid ?? 0,
      ask: ticker.ask ?? 0,
      timestamp: new Date(ticker.timestamp ?? Date.now()),
    };
  }

  async getKline(
    symbol: string,
    timeframe: "1h" | "1d",
    limit: number,
  ): Promise<OHLCV[]> {
    const data = await this.client.fetchOHLCV(symbol, timeframe, undefined, limit);
    return data.map(([ts, o, h, l, c, v]) => ({
      timestamp: ts!,
      open: o!,
      high: h!,
      low: l!,
      close: c!,
      volume: v!,
    }));
  }

  async getBalances(): Promise<Balance[]> {
    const balance = (await this.client.fetchBalance()) as any;
    return Object.entries(balance.total as Record<string, number>)
      .filter(([, total]) => total > 0)
      .map(([currency, total]) => ({
        currency,
        total,
        free: (balance.free[currency] as number) ?? 0,
        used: (balance.used[currency] as number) ?? 0,
      }));
  }

  async openPosition(params: OpenParams): Promise<Order> {
    const ccxtSide = params.side === "long" ? "buy" : "sell";
    await this.client.setLeverage(params.leverage, params.symbol);

    const order = await this.client.createOrder(
      params.symbol,
      "limit",
      ccxtSide,
      params.size,
      undefined,
      {
        clientOrderId: params.clientOrderId,
        timeInForce: "IOC",
      },
    );

    return this.mapOrder(order, params.side);
  }

  async closePosition(params: CloseParams): Promise<Order> {
    const ccxtSide = params.side === "long" ? "sell" : "buy";

    const order = await this.client.createOrder(
      params.symbol,
      "market",
      ccxtSide,
      params.size,
      undefined,
      {
        clientOrderId: params.clientOrderId,
        reduceOnly: true,
      },
    );

    return this.mapOrder(order, params.side);
  }

  async getOrder(orderId: string): Promise<Order> {
    const order = await this.client.fetchOrder(orderId);
    const side = order.side === "buy" ? "long" : "short";
    return this.mapOrder(order, side);
  }

  async getSymbols(): Promise<SymbolInfo[]> {
    const markets = await this.client.loadMarkets();
    return Object.values(markets)
      .filter((m: any) => m.swap && m.quote === "USDT")
      .map((m: any) => ({
        symbol: m.symbol,
        baseCurrency: m.base,
        quoteCurrency: m.quote,
        minSize: m.limits?.amount?.min ?? 0,
        pricePrecision: m.precision?.price ?? 2,
        sizePrecision: m.precision?.amount ?? 3,
      }));
  }

  async getFeeRate(): Promise<number> {
    return 0.0005; // Huobi USDT-M perpetual taker fee
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.client.fetchBalance();
      return true;
    } catch {
      return false;
    }
  }

  async getFundingHistory(symbol: string, since: Date): Promise<FundingPayment[]> {
    try {
      const entries = await (this.client as any).fetchFundingHistory(
        symbol,
        since.getTime(),
      );
      return (entries as any[]).map((e) => ({
        symbol: e.symbol ?? symbol,
        amount: e.amount ?? 0,
        fundingRate: e.info?.fundingRate ? Number(e.info.fundingRate) : 0,
        settledAt: new Date(e.timestamp ?? Date.now()),
        exchangeSettlementId: e.id,
      }));
    } catch (err) {
      if ((err as Error)?.message?.includes("not supported")) {
        throw new Error("not implemented");
      }
      throw err;
    }
  }

  private mapOrder(order: any, side: "long" | "short"): Order {
    const filled = order.filled ?? 0;
    let status: Order["status"] = "failed";
    if (filled > 0 && filled >= (order.amount ?? 0)) status = "filled";
    else if (filled > 0) status = "partial";

    return {
      id: order.id,
      clientOrderId: order.clientOrderId ?? "",
      symbol: order.symbol,
      side,
      price: order.average ?? order.price ?? 0,
      filledSize: filled,
      fee: order.fee?.cost ?? 0,
      status,
      timestamp: new Date(order.timestamp ?? Date.now()),
    };
  }
}
