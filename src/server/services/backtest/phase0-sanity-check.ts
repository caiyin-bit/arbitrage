import { prisma } from "@/server/db/client";
import { findOpportunities } from "@/server/services/detector/opportunity";
import type { BacktestConfig, Phase0Result, Phase0Opportunity } from "./types";
import type { FundingRate } from "@/lib/types";
import type { ExchangeName } from "@/lib/constants";

const STEP_MS = 5 * 60 * 1000;

export async function phase0SanityCheck(config: BacktestConfig): Promise<Phase0Result> {
  const allRates = await prisma.fundingRateSnapshot.findMany({
    where: { collectedAt: { gte: config.from, lte: config.to } },
    include: { exchange: { select: { name: true } } },
    orderBy: { collectedAt: "asc" },
  });
  if (allRates.length === 0) {
    return { opportunities: [], theoreticalPnl: 0, verdict: "negative" };
  }

  const opps: Phase0Opportunity[] = [];
  for (let t = config.from.getTime(); t < config.to.getTime(); t += STEP_MS) {
    const latest = new Map<string, typeof allRates[number]>();
    for (const r of allRates) {
      if (r.collectedAt.getTime() > t) break;
      latest.set(`${r.exchange.name}:${r.symbol}`, r);
    }
    const snapshots: FundingRate[] = [...latest.values()].map((r) => ({
      exchange: r.exchange.name as ExchangeName,
      symbol: r.symbol,
      currentRate: Number(r.currentRate),
      predictedRate: null,
      nextSettlement: r.nextSettlement,
      intervalHours: r.intervalHours,
      timestamp: r.collectedAt,
    }));
    const ops = findOpportunities(snapshots, {
      minRateSpread: config.minSpread,
      minAnnualizedYield: config.minApy,
    });
    for (const op of ops) {
      opps.push({
        at: new Date(t),
        symbol: op.symbol,
        longExchange: op.longExchange,
        shortExchange: op.shortExchange,
        rateSpread: op.rateSpread,
        annualizedYield: op.annualizedYield,
      });
    }
  }

  const theoreticalPnl = opps.reduce((sum, o) => sum + o.rateSpread * config.positionSize, 0);
  const roi = theoreticalPnl / config.initialCapital;
  const verdict: Phase0Result["verdict"] = roi > 0.1 ? "positive" : roi > 0 ? "weak" : "negative";

  return { opportunities: opps, theoreticalPnl, verdict };
}
