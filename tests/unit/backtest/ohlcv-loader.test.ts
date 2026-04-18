import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/server/db/client";
import { loadOhlcvHistory } from "@/server/services/backtest/data-loader/ohlcv-loader";

async function reset() {
  await prisma.ohlcvSnapshot.deleteMany();
  await prisma.exchange.deleteMany();
}

describe("ohlcv-loader", () => {
  beforeEach(reset);

  it("inserts ccxt OHLCV arrays paginated by since cursor", async () => {
    const ex = await prisma.exchange.create({ data: { name: "binance", apiKey: "x", apiSecret: "y" } });
    const t0 = Date.UTC(2025, 9, 1);
    const page1: [number, number, number, number, number, number][] = [
      [t0, 100, 110, 95, 105, 1000],
      [t0 + 3600_000, 105, 115, 100, 110, 1100],
    ];
    const page2: [number, number, number, number, number, number][] = [
      [t0 + 2 * 3600_000, 110, 120, 108, 118, 1200],
    ];
    const fetch = vi.fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
      .mockResolvedValueOnce([]);
    const adapter = { fetchOHLCV: fetch, rateLimit: 0 } as unknown as import("ccxt").Exchange;

    const result = await loadOhlcvHistory(
      adapter, ex.id, "BTC/USDT:USDT", "1h",
      new Date(t0), new Date(t0 + 3 * 3600_000),
    );

    expect(result.inserted).toBe(3);
    const rows = await prisma.ohlcvSnapshot.findMany({ orderBy: { openTime: "asc" } });
    expect(rows).toHaveLength(3);
    expect(Number(rows[0].open)).toBe(100);
    expect(Number(rows[2].close)).toBe(118);
  });

  it("skipDuplicates on reload", async () => {
    const ex = await prisma.exchange.create({ data: { name: "bybit", apiKey: "x", apiSecret: "y" } });
    const t0 = Date.UTC(2025, 9, 1);
    const page: [number, number, number, number, number, number][] = [[t0, 1, 2, 0.5, 1.5, 100]];
    const fetch = vi.fn()
      .mockResolvedValueOnce(page).mockResolvedValueOnce([])
      .mockResolvedValueOnce(page).mockResolvedValueOnce([]);
    const adapter = { fetchOHLCV: fetch, rateLimit: 0 } as unknown as import("ccxt").Exchange;

    await loadOhlcvHistory(adapter, ex.id, "X/USDT:USDT", "1h", new Date(t0), new Date(t0 + 3600_000));
    const r2 = await loadOhlcvHistory(adapter, ex.id, "X/USDT:USDT", "1h", new Date(t0), new Date(t0 + 3600_000));

    expect(r2.skipped).toBe(1);
    expect(r2.inserted).toBe(0);
    expect(await prisma.ohlcvSnapshot.count()).toBe(1);
  });
});
