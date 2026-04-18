import { describe, it, expect } from "vitest";
import { aggregate } from "@/server/services/backtest/reporter/aggregate";
import type { ClosedTrade, EquityCurvePoint } from "@/server/services/backtest/types";

function trade(overrides: Partial<ClosedTrade>): ClosedTrade {
  return {
    positionId: "p1",
    symbol: "BTC/USDT:USDT",
    longExchange: "binance",
    shortExchange: "okx",
    openedAt: new Date("2025-01-01T00:00:00Z"),
    closedAt: new Date("2025-01-01T08:00:00Z"),
    longEntry: 100, shortEntry: 100, longExit: 100, shortExit: 100,
    grossPnl: 0, fees: 0, fundingPnl: 0, netPnl: 0, holdHours: 8,
    ...overrides,
  };
}

describe("aggregate", () => {
  it("overall: win rate + max drawdown + roi", () => {
    const trades = [
      trade({ netPnl: 10 }),
      trade({ netPnl: -5 }),
      trade({ netPnl: 20 }),
    ];
    const curve: EquityCurvePoint[] = [
      { date: new Date("2025-01-01"), equity: 10_000, grossPnl: 0, netPnl: 0, totalFees: 0 },
      { date: new Date("2025-01-02"), equity: 10_010, grossPnl: 10, netPnl: 10, totalFees: 0 },
      { date: new Date("2025-01-03"), equity: 10_005, grossPnl: 5, netPnl: 5, totalFees: 0 },
      { date: new Date("2025-01-04"), equity: 10_025, grossPnl: 25, netPnl: 25, totalFees: 0 },
    ];
    const r = aggregate(trades, curve, 10_000);
    expect(r.overall.totalTrades).toBe(3);
    expect(r.overall.winRate).toBeCloseTo(2 / 3, 3);
    expect(r.overall.netPnl).toBe(25);
    expect(r.overall.maxDrawdown).toBeGreaterThan(0);
  });

  it("groups by symbol", () => {
    const trades = [
      trade({ symbol: "BTC/USDT:USDT", netPnl: 5 }),
      trade({ symbol: "ETH/USDT:USDT", netPnl: 10 }),
      trade({ symbol: "BTC/USDT:USDT", netPnl: -2 }),
    ];
    const r = aggregate(trades, [], 10_000);
    expect(r.bySymbol.find((x) => x.key === "BTC/USDT:USDT")?.netPnl).toBe(3);
    expect(r.bySymbol.find((x) => x.key === "ETH/USDT:USDT")?.netPnl).toBe(10);
  });
});
