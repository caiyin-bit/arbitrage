import type { ExchangeName } from "@/lib/constants";
import type { Position, TradeLog, Settlement, Prisma } from "@prisma/client";
import type { ExchangeAdapter } from "@/server/services/exchange/types";

export interface OpenHedgedRequest {
  /** Caller-supplied UUID generated once per user confirmation (see idempotency protocol) */
  idempotencyKey: string;
  opportunityId: string;
  symbol: string;
  longExchange: ExchangeName;
  shortExchange: ExchangeName;
  size: number;
  leverage: number;
}

export interface CloseHedgedRequest {
  idempotencyKey: string;
  positionId: string;
  reason: "manual" | "rate_reversal" | "take_profit" | "risk_control";
}

export type RescueReason =
  | "orphan_long"        // short side failed completely
  | "orphan_short"       // long side failed completely
  | "excess_long"        // long filled more than short
  | "excess_short";

export interface ExecutionResult {
  status: "filled" | "partial" | "rescued" | "failed";
  positionId: string;
  executionId: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Plan 4 — dependency injection for backtest support
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Date;
}

export interface RedisLike {
  set(key: string, value: string, ...args: (string | number)[]): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

export interface PositionStore {
  createPosition(data: Prisma.PositionUncheckedCreateInput): Promise<Position>;
  updatePosition(id: string, data: Prisma.PositionUncheckedUpdateInput): Promise<Position>;
  findPosition(id: string): Promise<Position | null>;
  findPositionOrThrow(
    where: Prisma.PositionWhereUniqueInput,
    include?: Prisma.PositionInclude,
  ): Promise<Position>;
  listOpenPositions(): Promise<Position[]>;

  createTradeLog(data: Prisma.TradeLogUncheckedCreateInput): Promise<TradeLog>;
  findTradeLogOrThrow(where: Prisma.TradeLogWhereUniqueInput): Promise<TradeLog>;
  updateTradeLogByClientOrderId(
    clientOrderId: string,
    data: Prisma.TradeLogUncheckedUpdateInput,
  ): Promise<TradeLog>;
  listTradeLogs(executionId: string): Promise<TradeLog[]>;
  findManyTradeLogs(where: Prisma.TradeLogWhereInput): Promise<TradeLog[]>;

  createSettlement(data: Prisma.SettlementUncheckedCreateInput): Promise<Settlement>;

  findExchangeByName(name: string): Promise<{ id: string; name: string } | null>;

  transaction<T>(fn: (tx: PositionStore) => Promise<T>): Promise<T>;
}

export interface ExecutorContext {
  store: PositionStore;
  redis: RedisLike;
  adapterFor: (exchangeName: string) => Promise<ExchangeAdapter>;
  clock: Clock;
  random: () => number;
  log: (msg: string, meta?: Record<string, unknown>) => void;
}
