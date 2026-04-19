import type { PrismaClient } from "@prisma/client";
import type { BacktestResult } from "@/server/services/backtest/types";
import { aggregate } from "@/lib/backtest-aggregate";

export async function persistRun(
  prisma: PrismaClient,
  result: BacktestResult,
): Promise<string> {
  const agg = aggregate(result.closedTrades, result.equityCurve, result.config.initialCapital);
  const o = agg.overall;

  const row = await prisma.backtestRun.create({
    data: {
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      fromDate: result.config.from,
      toDate: result.config.to,
      config: result.config as unknown as object,
      totalTrades: o.totalTrades,
      winRate: o.winRate,
      roi: o.roi,
      netPnl: o.netPnl,
      maxDrawdown: o.maxDrawdown,
      sharpeRatio: o.sharpeRatio,
      closedTrades: result.closedTrades as unknown as object,
      equityCurve: result.equityCurve as unknown as object,
    },
  });
  return row.id;
}
