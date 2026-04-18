import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import crypto from "crypto";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import { encrypt } from "@/server/services/crypto/encryption";

// Mock the factory; encryption is REAL
const longAdapter = {
  name: "binance",
  openPosition: vi.fn(),
  closePosition: vi.fn(),
  getOrder: vi.fn(),
  getBalances: vi.fn(async () => []),
  getFundingRates: vi.fn(async () => []),
  getNextSettlementTime: vi.fn(),
  getPrice: vi.fn(),
  getKline: vi.fn(),
  getSymbols: vi.fn(async () => []),
  getFeeRate: vi.fn(async () => 0.0004),
  testConnection: vi.fn(async () => true),
};
const shortAdapter = {
  name: "okx",
  openPosition: vi.fn(),
  closePosition: vi.fn(),
  getOrder: vi.fn(),
  getBalances: vi.fn(async () => []),
  getFundingRates: vi.fn(async () => []),
  getNextSettlementTime: vi.fn(),
  getPrice: vi.fn(),
  getKline: vi.fn(),
  getSymbols: vi.fn(async () => []),
  getFeeRate: vi.fn(async () => 0.0005),
  testConnection: vi.fn(async () => true),
};

vi.mock("@/server/services/exchange/factory", () => ({
  createAdapter: vi.fn((name: string) =>
    name === "binance" ? longAdapter : shortAdapter,
  ),
}));

async function resetDB() {
  await prisma.$transaction([
    prisma.tradeLog.deleteMany(),
    prisma.settlement.deleteMany(),
    prisma.position.deleteMany(),
    prisma.opportunity.deleteMany(),
    prisma.exchange.deleteMany(),
  ]);
}

async function seedExchangesAndOpportunity() {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "a".repeat(64);
  const bin = await prisma.exchange.create({
    data: {
      name: "binance",
      apiKey: encrypt("k1"),
      apiSecret: encrypt("s1"),
      isEnabled: true,
      feeRate: 0.0004,
    },
  });
  const okx = await prisma.exchange.create({
    data: {
      name: "okx",
      apiKey: encrypt("k2"),
      apiSecret: encrypt("s2"),
      passphrase: encrypt("p"),
      isEnabled: true,
      feeRate: 0.0005,
    },
  });
  const opp = await prisma.opportunity.create({
    data: {
      symbol: "BTC/USDT:USDT",
      longExchangeId: bin.id,
      shortExchangeId: okx.id,
      longRate: 0.0001,
      shortRate: 0.0003,
      rateSpread: 0.0002,
      annualizedYield: 0.2,
      suggestedSize: 1,
      status: "DETECTED",
      detectedAt: new Date(),
    },
  });
  return { bin, okx, opp };
}

describe("openHedgedPosition — full integration", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetDB();
    // Clean Redis idempotency state
    const stale = await redis.keys("idem:*");
    if (stale.length > 0) await redis.del(...stale);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await redis.quit();
  });

  it("happy path: both legs fill, position status becomes OPEN", async () => {
    const { opp } = await seedExchangesAndOpportunity();

    longAdapter.openPosition.mockResolvedValue({
      id: "o1", clientOrderId: "c1", symbol: "BTC/USDT:USDT", side: "long",
      price: 70000, filledSize: 1, fee: 28, status: "filled", timestamp: new Date(),
    });
    longAdapter.getOrder.mockResolvedValue({
      id: "o1", clientOrderId: "c1", symbol: "BTC/USDT:USDT", side: "long",
      price: 70000, filledSize: 1, fee: 28, status: "filled", timestamp: new Date(),
    });
    shortAdapter.openPosition.mockResolvedValue({
      id: "o2", clientOrderId: "c2", symbol: "BTC/USDT:USDT", side: "short",
      price: 70100, filledSize: 1, fee: 35, status: "filled", timestamp: new Date(),
    });
    shortAdapter.getOrder.mockResolvedValue({
      id: "o2", clientOrderId: "c2", symbol: "BTC/USDT:USDT", side: "short",
      price: 70100, filledSize: 1, fee: 35, status: "filled", timestamp: new Date(),
    });

    const { openHedgedPosition } = await import("@/server/services/executor/execute-open");
    const { buildProdContext } = await import("@/server/services/executor/context-prod");
    const ctx = buildProdContext();
    const result = await openHedgedPosition(ctx, {
      idempotencyKey: crypto.randomUUID(),
      opportunityId: opp.id,
      symbol: "BTC/USDT:USDT",
      longExchange: "binance",
      shortExchange: "okx",
      size: 1,
      leverage: 2,
    });

    expect(result.status).toBe("filled");

    const position = await prisma.position.findUniqueOrThrow({ where: { id: result.positionId } });
    expect(position.status).toBe("OPEN");
    expect(Number(position.longSize)).toBe(1);
    expect(Number(position.shortSize)).toBe(1);
    expect(Number(position.longAvgEntryPrice)).toBe(70000);
    expect(Number(position.shortAvgEntryPrice)).toBe(70100);

    const logs = await prisma.tradeLog.findMany({ where: { positionId: result.positionId } });
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.status === "FILLED")).toBe(true);
  });

  it("duplicate call with same idempotencyKey replays cached result", async () => {
    const { opp } = await seedExchangesAndOpportunity();

    longAdapter.openPosition.mockResolvedValue({
      id: "o1", clientOrderId: "c1", symbol: "BTC/USDT:USDT", side: "long",
      price: 70000, filledSize: 1, fee: 28, status: "filled", timestamp: new Date(),
    });
    longAdapter.getOrder.mockResolvedValue({
      id: "o1", clientOrderId: "c1", symbol: "BTC/USDT:USDT", side: "long",
      price: 70000, filledSize: 1, fee: 28, status: "filled", timestamp: new Date(),
    });
    shortAdapter.openPosition.mockResolvedValue({
      id: "o2", clientOrderId: "c2", symbol: "BTC/USDT:USDT", side: "short",
      price: 70000, filledSize: 1, fee: 28, status: "filled", timestamp: new Date(),
    });
    shortAdapter.getOrder.mockResolvedValue({
      id: "o2", clientOrderId: "c2", symbol: "BTC/USDT:USDT", side: "short",
      price: 70000, filledSize: 1, fee: 28, status: "filled", timestamp: new Date(),
    });

    const { openHedgedPosition } = await import("@/server/services/executor/execute-open");
    const { buildProdContext } = await import("@/server/services/executor/context-prod");
    const ctx = buildProdContext();
    const idempotencyKey = crypto.randomUUID();
    const payload = {
      idempotencyKey,
      opportunityId: opp.id,
      symbol: "BTC/USDT:USDT",
      longExchange: "binance" as const,
      shortExchange: "okx" as const,
      size: 1,
      leverage: 2,
    };

    const first = await openHedgedPosition(ctx, payload);
    const second = await openHedgedPosition(ctx, payload);

    expect(second.positionId).toBe(first.positionId);
    expect(second.executionId).toBe(first.executionId);

    // Each adapter's openPosition called exactly once
    expect(longAdapter.openPosition).toHaveBeenCalledTimes(1);
    expect(shortAdapter.openPosition).toHaveBeenCalledTimes(1);

    // Exactly one position + two trade_logs
    const positions = await prisma.position.findMany();
    expect(positions).toHaveLength(1);
    const logs = await prisma.tradeLog.findMany();
    expect(logs).toHaveLength(2);

    const locks = await redis.keys("idem:lock:*");
    expect(locks).toHaveLength(0);
    const resultCached = await redis.get(`idem:result:${idempotencyKey}`);
    expect(resultCached).not.toBeNull();
  });
});
