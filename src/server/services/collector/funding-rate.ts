import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import { createAdapter } from "@/server/services/exchange/factory";
import { decrypt } from "@/server/services/crypto/encryption";
import { isMockExchange, type ExchangeName } from "@/lib/constants";
import type { FundingRate } from "@/lib/types";

// Dev-only: synthesize a mirrored rate set for the mock-binance exchange
// based on real rates, with a fixed offset that is large enough for the
// detector's thresholds to trigger opportunities.
const MOCK_RATE_OFFSET = 0.0005;

function synthesizeMockRates(
  realRates: FundingRate[],
  sourceExchange: string,
  mockName: ExchangeName,
): FundingRate[] {
  return realRates
    .filter((r) => r.exchange === sourceExchange)
    .map((r) => ({
      ...r,
      exchange: mockName,
      currentRate: r.currentRate + MOCK_RATE_OFFSET,
      predictedRate:
        r.predictedRate != null ? r.predictedRate + MOCK_RATE_OFFSET : null,
    }));
}

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

  // Real exchanges run their adapters; mock exchanges are filled in below.
  const realExchanges = exchanges.filter((ex) => !isMockExchange(ex.name));
  const mockExchanges = exchanges.filter((ex) => isMockExchange(ex.name));

  const results = await Promise.allSettled(
    realExchanges.map(async (ex) => {
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
        `Failed to collect rates from ${realExchanges[i].name}:`,
        result.reason,
      );
    }
  }

  // Synthesize rates for any mock exchanges based on real rates. Source:
  // first real exchange that actually produced data, preferring "okx".
  if (mockExchanges.length > 0 && allRates.length > 0) {
    const sourceExchange =
      allRates.find((r) => r.exchange === "okx")?.exchange ??
      allRates[0].exchange;
    for (const mock of mockExchanges) {
      allRates.push(
        ...synthesizeMockRates(
          allRates,
          sourceExchange,
          mock.name as ExchangeName,
        ),
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
