import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import crypto from "crypto";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import { encrypt } from "@/server/services/crypto/encryption";

// Each adapter gets its own independent mocks so call counting works correctly
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
  getFundingHistory: vi.fn(async () => []),
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
  getFundingHistory: vi.fn(async () => []),
};

vi.mock("@/server/services/exchange/factory", () => ({
  createAdapter: vi.fn((name: string) =>
    name === "binance" ? longAdapter : shortAdapter,
  ),
}));

async function resetDB() {
  await prisma.$transaction([
    prisma.settlement.deleteMany(),
    prisma.tradeLog.deleteMany(),
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

describe("openHedgedPosition — rescue path", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetDB();
    const stale = await redis.keys("idem:*");
    if (stale.length > 0) await redis.del(...stale);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await redis.quit();
  });

  it("orphan rescue: long fills, short returns 0 → long position market-closed, status CLOSED, cooldown set", async () => {
    const { opp } = await seedExchangesAndOpportunity();

    // Long leg fills normally
    longAdapter.openPosition.mockResolvedValue({
      id: "o1",
      clientOrderId: "c1",
      symbol: "BTC/USDT:USDT",
      side: "long",
      price: 70000,
      filledSize: 1,
      fee: 28,
      status: "filled",
      timestamp: new Date(),
    });
    longAdapter.getOrder.mockResolvedValue({
      id: "o1",
      clientOrderId: "c1",
      symbol: "BTC/USDT:USDT",
      side: "long",
      price: 70000,
      filledSize: 1,
      fee: 28,
      status: "filled",
      timestamp: new Date(),
    });

    // Short leg: openPosition "succeeds" at API level but filled=0 (IOC didn't match)
    shortAdapter.openPosition.mockResolvedValue({
      id: "o2",
      clientOrderId: "c2",
      symbol: "BTC/USDT:USDT",
      side: "short",
      price: 70100,
      filledSize: 0,
      fee: 0,
      status: "failed",
      timestamp: new Date(),
    });
    shortAdapter.getOrder.mockResolvedValue({
      id: "o2",
      clientOrderId: "c2",
      symbol: "BTC/USDT:USDT",
      side: "short",
      price: 70100,
      filledSize: 0,
      fee: 0,
      status: "failed",
      timestamp: new Date(),
    });

    // Rescue closePosition on long leg — market closes the 1 BTC
    longAdapter.closePosition.mockResolvedValue({
      id: "o3",
      clientOrderId: "c3",
      symbol: "BTC/USDT:USDT",
      side: "long",
      price: 69995,
      filledSize: 1,
      fee: 28,
      status: "filled",
      timestamp: new Date(),
    });

    const { openHedgedPosition } = await import(
      "@/server/services/executor/execute-open"
    );

    const result = await openHedgedPosition({
      idempotencyKey: crypto.randomUUID(),
      opportunityId: opp.id,
      symbol: "BTC/USDT:USDT",
      longExchange: "binance",
      shortExchange: "okx",
      size: 1,
      leverage: 2,
    });

    // Result should be "rescued"
    expect(result.status).toBe("rescued");

    // Three trade logs: long open (filled +1), short open (failed 0), long rescue (-1)
    const logs = await prisma.tradeLog.findMany({
      where: { positionId: result.positionId },
      orderBy: { createdAt: "asc" },
    });
    expect(logs).toHaveLength(3);

    const longOpen = logs.find(
      (l) => l.side === "LONG" && l.action === "OPEN",
    )!;
    expect(longOpen.status).toBe("FILLED");
    expect(Number(longOpen.signedQty)).toBe(1);

    const shortOpen = logs.find(
      (l) => l.side === "SHORT" && l.action === "OPEN",
    )!;
    expect(shortOpen.status).toBe("FAILED");

    const rescueLog = logs.find((l) => l.action === "RESCUE")!;
    expect(rescueLog).toBeDefined();
    expect(rescueLog.side).toBe("LONG");
    expect(Number(rescueLog.signedQty)).toBe(-1);

    // Position should be CLOSED (longSize=0 after rescue, shortSize=0 from the start)
    const position = await prisma.position.findUniqueOrThrow({
      where: { id: result.positionId },
    });
    expect(position.status).toBe("CLOSED");
    expect(Number(position.longSize)).toBe(0);
    expect(Number(position.shortSize)).toBe(0);
    expect(position.closedAt).not.toBeNull();

    // Opportunity cooldown set ~30 min out
    const updatedOpp = await prisma.opportunity.findUniqueOrThrow({
      where: { id: opp.id },
    });
    expect(updatedOpp.cooldownUntil).not.toBeNull();
    const cooldownMs = updatedOpp.cooldownUntil!.getTime() - Date.now();
    expect(cooldownMs).toBeGreaterThan(25 * 60 * 1000);
    expect(cooldownMs).toBeLessThan(35 * 60 * 1000);

    // Verify the exchange mocks were called as expected
    expect(longAdapter.openPosition).toHaveBeenCalledTimes(1);
    expect(shortAdapter.openPosition).toHaveBeenCalledTimes(1);
    expect(longAdapter.closePosition).toHaveBeenCalledTimes(1);
  });
});
