import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { prisma } from "@/server/db/client";
import { runBacktest } from "@/server/services/backtest/runner/runner";
import { writeReport } from "@/server/services/backtest/reporter/reporter";
import { DEFAULT_CONFIG } from "@/server/services/backtest/types";

async function reset() {
  await prisma.settlement.deleteMany();
  await prisma.tradeLog.deleteMany();
  await prisma.position.deleteMany();
  await prisma.opportunity.deleteMany();
  await prisma.ohlcvSnapshot.deleteMany();
  await prisma.fundingRateSnapshot.deleteMany();
  await prisma.exchange.deleteMany();
}

describe("backtest end-to-end", () => {
  beforeEach(reset);

  it("runs a 2-day backtest with seeded data and produces 4 report files", async () => {
    const bin = await prisma.exchange.create({ data: { name: "binance", apiKey: "", apiSecret: "" } });
    const okx = await prisma.exchange.create({ data: { name: "okx", apiKey: "", apiSecret: "" } });
    const t0 = Date.UTC(2025, 0, 1);

    for (let h = 0; h < 48; h++) {
      for (const ex of [bin, okx]) {
        await prisma.ohlcvSnapshot.create({
          data: {
            exchangeId: ex.id, symbol: "BTC/USDT:USDT", timeframe: "1h",
            openTime: new Date(t0 + h * 3600_000),
            open: 100, high: 105, low: 95, close: 100 + (h % 5),
            volume: 1000,
          },
        });
      }
    }
    for (const h of [8, 16, 24, 32, 40]) {
      const at = new Date(t0 + h * 3600_000);
      await prisma.fundingRateSnapshot.create({
        data: {
          exchangeId: bin.id, symbol: "BTC/USDT:USDT",
          currentRate: 0.001, collectedAt: at,
          intervalHours: 8, nextSettlement: new Date(at.getTime() + 8 * 3600_000),
        },
      });
      await prisma.fundingRateSnapshot.create({
        data: {
          exchangeId: okx.id, symbol: "BTC/USDT:USDT",
          currentRate: -0.0005, collectedAt: at,
          intervalHours: 8, nextSettlement: new Date(at.getTime() + 8 * 3600_000),
        },
      });
    }

    const result = await runBacktest({
      ...DEFAULT_CONFIG,
      from: new Date(t0),
      to: new Date(t0 + 48 * 3600_000),
      failureRate: 0,
    });

    expect(result.equityCurve.length).toBeGreaterThan(0);

    const out = await mkdtemp(path.join(tmpdir(), "bt-"));
    const dir = await writeReport(result, out);
    expect(existsSync(path.join(dir, "report.html"))).toBe(true);
    expect(existsSync(path.join(dir, "report.md"))).toBe(true);
    expect(existsSync(path.join(dir, "trades.csv"))).toBe(true);
    expect(existsSync(path.join(dir, "daily.csv"))).toBe(true);
  }, 60_000);
});
