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
  await prisma.backtestRun.deleteMany();
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

    const { persistRun } = await import("@/server/services/backtest/reporter/persist-run");
    const runId = await persistRun(prisma, result);
    const row = await prisma.backtestRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.totalTrades).toBeGreaterThanOrEqual(0);
    expect((row.closedTrades as unknown[]).length).toBe(result.closedTrades.length);
    expect((row.equityCurve as unknown[]).length).toBe(result.equityCurve.length);
  }, 60_000);

  it("trades have real math: non-zero fees, netPnl = grossPnl + fundingPnl - fees", async () => {
    const bin = await prisma.exchange.create({ data: { name: "binance", apiKey: "", apiSecret: "", feeRate: 0.0005 } });
    const okx = await prisma.exchange.create({ data: { name: "okx", apiKey: "", apiSecret: "", feeRate: 0.0005 } });
    const t0 = Date.UTC(2025, 0, 1);

    for (let h = 0; h < 48; h++) {
      for (const ex of [bin, okx]) {
        await prisma.ohlcvSnapshot.create({
          data: {
            exchangeId: ex.id, symbol: "BTC/USDT:USDT", timeframe: "1h",
            openTime: new Date(t0 + h * 3600_000),
            open: 100, high: 100.5, low: 99.5, close: 100,
            volume: 1000,
          },
        });
      }
    }
    for (const h of [8, 16, 24, 32, 40]) {
      const at = new Date(t0 + h * 3600_000);
      await prisma.fundingRateSnapshot.create({
        data: { exchangeId: bin.id, symbol: "BTC/USDT:USDT", currentRate: 0.001, collectedAt: at, intervalHours: 8, nextSettlement: new Date(at.getTime() + 8 * 3600_000) },
      });
      await prisma.fundingRateSnapshot.create({
        data: { exchangeId: okx.id, symbol: "BTC/USDT:USDT", currentRate: -0.0005, collectedAt: at, intervalHours: 8, nextSettlement: new Date(at.getTime() + 8 * 3600_000) },
      });
    }

    const result = await runBacktest({
      ...DEFAULT_CONFIG,
      from: new Date(t0),
      to: new Date(t0 + 48 * 3600_000),
      failureRate: 0,
      volatilityPauseEnabled: false,
    });

    // 1. At least one trade opened and closed
    expect(result.closedTrades.length).toBeGreaterThan(0);

    // 2. Every closed trade has non-zero fees
    for (const t of result.closedTrades) {
      expect(t.fees).toBeGreaterThan(0);
    }

    // 3. Arithmetic identity: netPnl == grossPnl + fundingPnl - fees
    for (const t of result.closedTrades) {
      const expected = t.grossPnl + t.fundingPnl - t.fees;
      expect(Math.abs(t.netPnl - expected)).toBeLessThan(0.01);
    }

    // 4. EquityCurve non-flat: at least one data point differs from initialCapital
    const equities = result.equityCurve.map((p) => p.equity);
    const min = Math.min(...equities, DEFAULT_CONFIG.initialCapital);
    const max = Math.max(...equities, DEFAULT_CONFIG.initialCapital);
    expect(max - min).toBeGreaterThan(0.001);
  }, 60_000);

  it("failureRate=1.0 produces zero closed trades", async () => {
    const bin = await prisma.exchange.create({ data: { name: "binance", apiKey: "", apiSecret: "" } });
    const okx = await prisma.exchange.create({ data: { name: "okx", apiKey: "", apiSecret: "" } });
    const t0 = Date.UTC(2025, 0, 1);

    for (let h = 0; h < 48; h++) {
      for (const ex of [bin, okx]) {
        await prisma.ohlcvSnapshot.create({
          data: {
            exchangeId: ex.id, symbol: "BTC/USDT:USDT", timeframe: "1h",
            openTime: new Date(t0 + h * 3600_000),
            open: 100, high: 101, low: 99, close: 100, volume: 1000,
          },
        });
      }
    }
    for (const h of [8, 16, 24]) {
      const at = new Date(t0 + h * 3600_000);
      await prisma.fundingRateSnapshot.create({
        data: { exchangeId: bin.id, symbol: "BTC/USDT:USDT", currentRate: 0.001, collectedAt: at, intervalHours: 8, nextSettlement: new Date(at.getTime() + 8 * 3600_000) },
      });
      await prisma.fundingRateSnapshot.create({
        data: { exchangeId: okx.id, symbol: "BTC/USDT:USDT", currentRate: -0.0005, collectedAt: at, intervalHours: 8, nextSettlement: new Date(at.getTime() + 8 * 3600_000) },
      });
    }

    const result = await runBacktest({
      ...DEFAULT_CONFIG,
      from: new Date(t0),
      to: new Date(t0 + 48 * 3600_000),
      failureRate: 1.0,
      volatilityPauseEnabled: false,
    });

    // With 100% failure rate on opens, no positions ever reach OPEN status, so no closed trades.
    expect(result.closedTrades.length).toBe(0);
  }, 60_000);

  it("finalEquity - initialCapital equals sum(trades.netPnl) after force-close", async () => {
    const bin = await prisma.exchange.create({ data: { name: "binance", apiKey: "", apiSecret: "", feeRate: 0.0005 } });
    const okx = await prisma.exchange.create({ data: { name: "okx", apiKey: "", apiSecret: "", feeRate: 0.0005 } });
    const t0 = Date.UTC(2025, 0, 1);

    for (let h = 0; h < 72; h++) {
      for (const ex of [bin, okx]) {
        await prisma.ohlcvSnapshot.create({
          data: {
            exchangeId: ex.id, symbol: "BTC/USDT:USDT", timeframe: "1h",
            openTime: new Date(t0 + h * 3600_000),
            open: 100, high: 100.5, low: 99.5, close: 100,
            volume: 1000,
          },
        });
      }
    }
    for (const h of [8, 16, 24, 32, 40, 48, 56, 64]) {
      const at = new Date(t0 + h * 3600_000);
      await prisma.fundingRateSnapshot.create({
        data: { exchangeId: bin.id, symbol: "BTC/USDT:USDT", currentRate: 0.001, collectedAt: at, intervalHours: 8, nextSettlement: new Date(at.getTime() + 8 * 3600_000) },
      });
      await prisma.fundingRateSnapshot.create({
        data: { exchangeId: okx.id, symbol: "BTC/USDT:USDT", currentRate: -0.0005, collectedAt: at, intervalHours: 8, nextSettlement: new Date(at.getTime() + 8 * 3600_000) },
      });
    }

    const result = await runBacktest({
      ...DEFAULT_CONFIG,
      from: new Date(t0),
      to: new Date(t0 + 72 * 3600_000),
      failureRate: 0,
      volatilityPauseEnabled: false,
    });

    expect(result.closedTrades.length).toBeGreaterThan(0);

    const finalEquity = result.equityCurve[result.equityCurve.length - 1].equity;
    const netPnl = result.closedTrades.reduce((s, t) => s + t.netPnl, 0);
    expect(Math.abs((finalEquity - DEFAULT_CONFIG.initialCapital) - netPnl)).toBeLessThan(0.01);
  }, 60_000);

  it("positionSize is USD notional: runner opens base-asset quantity ≈ positionSize / price", async () => {
    const bin = await prisma.exchange.create({ data: { name: "binance", apiKey: "", apiSecret: "", feeRate: 0.0005 } });
    const okx = await prisma.exchange.create({ data: { name: "okx", apiKey: "", apiSecret: "", feeRate: 0.0005 } });
    const t0 = Date.UTC(2025, 0, 1);

    const BTC_PRICE = 50_000;
    for (let h = 0; h < 48; h++) {
      for (const ex of [bin, okx]) {
        await prisma.ohlcvSnapshot.create({
          data: {
            exchangeId: ex.id, symbol: "BTC/USDT:USDT", timeframe: "1h",
            openTime: new Date(t0 + h * 3600_000),
            open: BTC_PRICE, high: BTC_PRICE * 1.001, low: BTC_PRICE * 0.999,
            close: BTC_PRICE,
            volume: 1000,
          },
        });
      }
    }
    for (const h of [8, 16, 24, 32, 40]) {
      const at = new Date(t0 + h * 3600_000);
      await prisma.fundingRateSnapshot.create({
        data: { exchangeId: bin.id, symbol: "BTC/USDT:USDT", currentRate: 0.001, collectedAt: at, intervalHours: 8, nextSettlement: new Date(at.getTime() + 8 * 3600_000) },
      });
      await prisma.fundingRateSnapshot.create({
        data: { exchangeId: okx.id, symbol: "BTC/USDT:USDT", currentRate: -0.0005, collectedAt: at, intervalHours: 8, nextSettlement: new Date(at.getTime() + 8 * 3600_000) },
      });
    }

    const USD_NOTIONAL = 500;
    const result = await runBacktest({
      ...DEFAULT_CONFIG,
      from: new Date(t0),
      to: new Date(t0 + 48 * 3600_000),
      positionSize: USD_NOTIONAL,
      failureRate: 0,
      volatilityPauseEnabled: false,
    });

    expect(result.closedTrades.length).toBeGreaterThan(0);
    for (const t of result.closedTrades) {
      const notional = t.longSize * t.longEntry;
      expect(Math.abs(notional - USD_NOTIONAL)).toBeLessThan(USD_NOTIONAL * 0.01);
    }
  }, 60_000);
});
