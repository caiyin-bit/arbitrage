import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import { createAdapter } from "@/server/services/exchange/factory";
import { decrypt } from "@/server/services/crypto/encryption";
import type { ExchangeName } from "@/lib/constants";
import type { FundingRate } from "@/lib/types";

const DEFAULT_SYMBOLS = [
  "BTC/USDT:USDT",
  "ETH/USDT:USDT",
  "SOL/USDT:USDT",
  "BNB/USDT:USDT",
  "XRP/USDT:USDT",
];

export async function collectAllRates(): Promise<FundingRate[]> {
  const exchanges = await prisma.exchange.findMany({
    where: { isEnabled: true },
  });

  const allRates: FundingRate[] = [];

  const results = await Promise.allSettled(
    exchanges.map(async (ex) => {
      const adapter = createAdapter(
        ex.name as ExchangeName,
        decrypt(ex.apiKey),
        decrypt(ex.apiSecret),
        ex.passphrase ? decrypt(ex.passphrase) : undefined,
      );
      return adapter.getFundingRates(DEFAULT_SYMBOLS);
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      allRates.push(...result.value);
    } else {
      console.error(
        `Failed to collect rates from ${exchanges[i].name}:`,
        result.reason,
      );
    }
  }

  if (allRates.length > 0) {
    const exchangeMap = new Map(exchanges.map((e) => [e.name, e.id]));

    await prisma.fundingRateSnapshot.createMany({
      data: allRates.map((r) => ({
        exchangeId: exchangeMap.get(r.exchange)!,
        symbol: r.symbol,
        currentRate: r.currentRate,
        predictedRate: r.predictedRate,
        nextSettlement: r.nextSettlement,
        intervalHours: r.intervalHours,
        collectedAt: r.timestamp,
      })),
    });

    const pipeline = redis.pipeline();
    for (const r of allRates) {
      pipeline.set(
        `rate:${r.exchange}:${r.symbol}`,
        JSON.stringify(r),
        "EX",
        600,
      );
    }
    await pipeline.exec();
  }

  return allRates;
}
