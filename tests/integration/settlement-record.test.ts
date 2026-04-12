import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/server/db/client";
import { encrypt } from "@/server/services/crypto/encryption";

const mockAdapter = {
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
  getFundingHistory: vi.fn(),
};

vi.mock("@/server/services/exchange/factory", () => ({
  createAdapter: vi.fn(() => mockAdapter),
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

describe("scanSettlements — idempotent ingest", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetDB();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("inserts new settlements on first scan, skips duplicates on second", async () => {
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
    const pos = await prisma.position.create({
      data: {
        opportunityId: opp.id,
        symbol: "BTC/USDT:USDT",
        longExchangeId: bin.id,
        longSize: 1,
        longAvgEntryPrice: 70000,
        shortExchangeId: okx.id,
        shortSize: 1,
        shortAvgEntryPrice: 70000,
        status: "OPEN",
        openedAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });

    const settledAt1 = new Date(Date.now() - 5 * 60 * 1000);
    const settledAt2 = new Date(Date.now() - 2 * 60 * 1000);

    mockAdapter.getFundingHistory.mockResolvedValue([
      {
        symbol: "BTC/USDT:USDT",
        amount: 2.5,
        fundingRate: 0.0002,
        settledAt: settledAt1,
      },
      {
        symbol: "BTC/USDT:USDT",
        amount: -1.8,
        fundingRate: -0.00015,
        settledAt: settledAt2,
      },
    ]);

    const { scanSettlements } = await import("@/server/services/monitor/settlement");

    await scanSettlements();

    let settlements = await prisma.settlement.findMany({ where: { positionId: pos.id } });
    // 2 funding payments * 2 sides (long+short both query adapter) = 4 rows
    expect(settlements).toHaveLength(4);

    // Second scan — same payments — should insert 0
    await scanSettlements();
    settlements = await prisma.settlement.findMany({ where: { positionId: pos.id } });
    expect(settlements).toHaveLength(4);
  });

  it("skips exchange when adapter returns 'not implemented'", async () => {
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
    await prisma.position.create({
      data: {
        opportunityId: opp.id,
        symbol: "BTC/USDT:USDT",
        longExchangeId: bin.id,
        longSize: 1,
        longAvgEntryPrice: 70000,
        shortExchangeId: okx.id,
        shortSize: 1,
        shortAvgEntryPrice: 70000,
        status: "OPEN",
        openedAt: new Date(),
      },
    });

    mockAdapter.getFundingHistory.mockRejectedValue(new Error("not implemented"));

    const { scanSettlements } = await import("@/server/services/monitor/settlement");
    await scanSettlements();

    const settlements = await prisma.settlement.findMany();
    expect(settlements).toHaveLength(0);
  });
});
