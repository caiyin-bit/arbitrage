import { collectAllRates } from "@/server/services/collector/funding-rate";
import { findOpportunities } from "@/server/services/detector/opportunity";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";

export async function handleCollectRates() {
  console.log("[job] Collecting funding rates...");

  const rates = await collectAllRates();
  console.log("[job] Collected %d rates", rates.length);

  if (rates.length === 0) return;

  const [minSpread, minYield] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "min_rate_spread" } }),
    prisma.setting.findUnique({ where: { key: "min_annualized_yield" } }),
  ]);

  const config = {
    minRateSpread: (minSpread?.value as number) ?? 0.0001,
    minAnnualizedYield: (minYield?.value as number) ?? 0.15,
  };

  const opportunities = findOpportunities(rates, config);
  console.log("[job] Detected %d opportunities", opportunities.length);

  const exchangeMap = new Map<string, string>();
  const exchanges = await prisma.exchange.findMany({
    where: { isEnabled: true },
    select: { id: true, name: true },
  });
  for (const ex of exchanges) exchangeMap.set(ex.name, ex.id);

  for (const opp of opportunities) {
    const longExId = exchangeMap.get(opp.longExchange);
    const shortExId = exchangeMap.get(opp.shortExchange);
    if (!longExId || !shortExId) continue;

    await prisma.opportunity.create({
      data: {
        symbol: opp.symbol,
        longExchangeId: longExId,
        shortExchangeId: shortExId,
        longRate: opp.longRate,
        shortRate: opp.shortRate,
        rateSpread: opp.rateSpread,
        annualizedYield: opp.annualizedYield,
        suggestedSize: opp.suggestedSize,
        status: "DETECTED",
        detectedAt: new Date(),
      },
    });
  }

  if (opportunities.length > 0) {
    await redis.set(
      "opportunity:latest",
      JSON.stringify(opportunities),
      "EX",
      600,
    );
  }
}
