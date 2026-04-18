import type { Exchange } from "ccxt";
import { prisma } from "@/server/db/client";

const BATCH_LIMIT = 1000;

export interface LoadResult {
  inserted: number;
  skipped: number;
}

export async function loadFundingRateHistory(
  adapter: Exchange,
  exchangeId: string,
  symbol: string,
  from: Date,
  to: Date,
): Promise<LoadResult> {
  let since = from.getTime();
  const end = to.getTime();
  let inserted = 0;
  let skipped = 0;

  while (since < end) {
    const batch = await adapter.fetchFundingRateHistory(symbol, since, BATCH_LIMIT);
    if (!batch || batch.length === 0) break;

    const intervalMs = 8 * 3600_000; // 8 hours
    const rows = batch
      .filter((r) => typeof r.timestamp === "number" && r.timestamp < end)
      .map((r) => {
        const collectedAt = new Date(r.timestamp as number);
        return {
          exchangeId,
          symbol,
          currentRate: r.fundingRate ?? 0,
          collectedAt,
          nextSettlement: new Date(collectedAt.getTime() + intervalMs),
          intervalHours: 8,
        };
      });

    if (rows.length === 0) break;

    const result = await prisma.fundingRateSnapshot.createMany({
      data: rows,
      skipDuplicates: true,
    });
    inserted += result.count;
    skipped += rows.length - result.count;

    const lastTs = batch[batch.length - 1].timestamp as number;
    if (lastTs >= end) break;
    since = lastTs + 1;

    if (adapter.rateLimit && adapter.rateLimit > 0) {
      await new Promise((r) => setTimeout(r, adapter.rateLimit));
    }
  }

  return { inserted, skipped };
}
