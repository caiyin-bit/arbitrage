import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/server/db/client";
import { loadFundingRateHistory } from "@/server/services/backtest/data-loader/funding-rate-loader";

async function reset() {
  await prisma.tradeLog.deleteMany();
  await prisma.settlement.deleteMany();
  await prisma.position.deleteMany();
  await prisma.opportunity.deleteMany();
  await prisma.fundingRateSnapshot.deleteMany();
  await prisma.exchange.deleteMany();
}

describe("funding-rate-loader", () => {
  beforeEach(reset);

  it("inserts ccxt batches, paginates via since cursor, respects 'to' bound", async () => {
    const ex = await prisma.exchange.create({
      data: { name: "binance", apiKey: "x", apiSecret: "y" },
    });
    const fromTs = Date.UTC(2025, 9, 1);
    const toTs = Date.UTC(2025, 9, 2);

    const pages = [
      [
        { symbol: "BTC/USDT:USDT", fundingRate: 0.0001, timestamp: fromTs + 1_000 },
        { symbol: "BTC/USDT:USDT", fundingRate: 0.00012, timestamp: fromTs + 8 * 3600_000 },
      ],
      [
        { symbol: "BTC/USDT:USDT", fundingRate: -0.0002, timestamp: fromTs + 16 * 3600_000 },
      ],
      [],
    ];
    const fetch = vi.fn(async () => pages.shift()!);
    const adapter = { fetchFundingRateHistory: fetch, rateLimit: 0 } as unknown as import("ccxt").Exchange;

    const result = await loadFundingRateHistory(adapter, ex.id, "BTC/USDT:USDT", new Date(fromTs), new Date(toTs));
    expect(result.inserted).toBe(3);
    expect(result.skipped).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(3);

    const rows = await prisma.fundingRateSnapshot.findMany();
    expect(rows).toHaveLength(3);
  });

  it("skipDuplicates: re-loading the same range leaves the same row count", async () => {
    const ex = await prisma.exchange.create({ data: { name: "okx", apiKey: "x", apiSecret: "y" } });
    const ts = Date.UTC(2025, 9, 1);
    const page = [
      { symbol: "ETH/USDT:USDT", fundingRate: 0.0001, timestamp: ts + 1_000 },
    ];
    const fetch = vi.fn()
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([]);
    const adapter = { fetchFundingRateHistory: fetch, rateLimit: 0 } as unknown as import("ccxt").Exchange;

    const r1 = await loadFundingRateHistory(adapter, ex.id, "ETH/USDT:USDT", new Date(ts), new Date(ts + 3600_000));
    expect(r1.inserted).toBe(1);

    const r2 = await loadFundingRateHistory(adapter, ex.id, "ETH/USDT:USDT", new Date(ts), new Date(ts + 3600_000));
    expect(r2.inserted).toBe(0);
    expect(r2.skipped).toBe(1);

    expect(await prisma.fundingRateSnapshot.count()).toBe(1);
  });
});
