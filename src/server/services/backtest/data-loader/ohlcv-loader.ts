import type { Exchange } from "ccxt";
import { prisma } from "@/server/db/client";

const BATCH_LIMIT = 500;

export interface LoadResult {
  inserted: number;
  skipped: number;
}

export async function loadOhlcvHistory(
  adapter: Exchange,
  exchangeId: string,
  symbol: string,
  timeframe: string,
  from: Date,
  to: Date,
): Promise<LoadResult> {
  let since = from.getTime();
  const end = to.getTime();
  let inserted = 0;
  let skipped = 0;

  while (since < end) {
    const batch = await adapter.fetchOHLCV(symbol, timeframe, since, BATCH_LIMIT);
    if (!batch || batch.length === 0) break;

    const rows = batch
      .filter(([openTime]) => typeof openTime === "number" && openTime < end)
      .map(([openTime, open, high, low, close, volume]) => ({
        exchangeId,
        symbol,
        timeframe,
        openTime: new Date(openTime as number),
        open: open ?? 0,
        high: high ?? 0,
        low: low ?? 0,
        close: close ?? 0,
        volume: volume ?? 0,
      }));

    if (rows.length === 0) break;

    const result = await prisma.ohlcvSnapshot.createMany({ data: rows, skipDuplicates: true });
    inserted += result.count;
    skipped += rows.length - result.count;

    const lastTs = batch[batch.length - 1][0] as number;
    if (lastTs >= end) break;
    since = lastTs + 1;

    if (adapter.rateLimit && adapter.rateLimit > 0) {
      await new Promise((r) => setTimeout(r, adapter.rateLimit));
    }
  }

  return { inserted, skipped };
}
