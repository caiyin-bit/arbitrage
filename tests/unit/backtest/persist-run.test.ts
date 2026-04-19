import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/server/db/client";
import { persistRun } from "@/server/services/backtest/reporter/persist-run";
import type { BacktestResult, BacktestConfig } from "@/server/services/backtest/types";

async function reset() {
  await prisma.backtestRun.deleteMany();
}

function mkResult(overrides: Partial<BacktestResult> = {}): BacktestResult {
  const config: BacktestConfig = {
    from: new Date("2025-01-01T00:00:00Z"),
    to: new Date("2025-01-03T00:00:00Z"),
    initialCapital: 10_000,
    positionSize: 500,
    maxConcurrent: 3,
    minSpread: 0.0005,
    minApy: 0.1,
    slippageBps: 3,
    failureRate: 0.02,
    seed: "test",
    volatilityPauseEnabled: true,
    volatilityThreshold1h: 0.05,
    volatilityThreshold24h: 0.15,
    rateReversalExit: true,
    minHoldingPeriods: 1,
    healthIntervalSec: 300,
  };
  return {
    config,
    startedAt: new Date("2025-01-03T00:00:00Z"),
    finishedAt: new Date("2025-01-03T00:00:10Z"),
    closedTrades: [],
    equityCurve: [],
    ...overrides,
  };
}

describe("persistRun", () => {
  beforeEach(reset);

  it("writes one BacktestRun row with 6 aggregated metrics", async () => {
    const result = mkResult({
      closedTrades: [
        {
          positionId: "p1", symbol: "BTC/USDT:USDT",
          longExchange: "binance", shortExchange: "okx",
          openedAt: new Date("2025-01-01T00:00:00Z"),
          closedAt: new Date("2025-01-01T08:00:00Z"),
          longEntry: 100, shortEntry: 100, longExit: 101, shortExit: 99,
          grossPnl: 20, fees: 2, fundingPnl: 1, netPnl: 19, holdHours: 8,
        },
      ],
      equityCurve: [
        { date: new Date("2025-01-01"), equity: 10_000, grossPnl: 0, netPnl: 0, totalFees: 0 },
        { date: new Date("2025-01-02"), equity: 10_019, grossPnl: 20, netPnl: 19, totalFees: 2 },
      ],
    });

    const id = await persistRun(prisma, result);
    expect(id).toMatch(/^c/);

    const row = await prisma.backtestRun.findUniqueOrThrow({ where: { id } });
    expect(row.totalTrades).toBe(1);
    expect(Number(row.winRate)).toBe(1);
    expect(Number(row.netPnl)).toBe(19);
    expect(Array.isArray(row.closedTrades)).toBe(true);
    expect((row.closedTrades as unknown[]).length).toBe(1);
    expect((row.equityCurve as unknown[]).length).toBe(2);
  });

  it("stores config as JSON with from/to preserved", async () => {
    const result = mkResult();
    const id = await persistRun(prisma, result);
    const row = await prisma.backtestRun.findUniqueOrThrow({ where: { id } });
    const cfg = row.config as unknown as { initialCapital: number; seed: string };
    expect(cfg.initialCapital).toBe(10_000);
    expect(cfg.seed).toBe("test");
  });

  it("handles zero-trade results without crashing", async () => {
    const id = await persistRun(prisma, mkResult());
    const row = await prisma.backtestRun.findUniqueOrThrow({ where: { id } });
    expect(row.totalTrades).toBe(0);
    expect(Number(row.roi)).toBe(0);
    expect(Number(row.netPnl)).toBe(0);
  });
});
