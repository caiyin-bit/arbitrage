import ccxt from "ccxt";
import { prisma } from "@/server/db/client";
import { loadFundingRateHistory } from "./funding-rate-loader";
import { loadOhlcvHistory } from "./ohlcv-loader";

export interface LoaderOptions {
  from: Date;
  to: Date;
  exchanges: string[];
  symbols: string[];
  timeframe: string;
}

export async function loadAllHistory(opts: LoaderOptions) {
  const totals = { fundingInserted: 0, fundingSkipped: 0, ohlcvInserted: 0, ohlcvSkipped: 0 };
  for (const name of opts.exchanges) {
    const row = await prisma.exchange.findFirst({ where: { name } });
    if (!row) {
      console.warn(`[loader] exchange "${name}" not in DB; skipping`);
      continue;
    }
    const AdapterClass = (ccxt as unknown as Record<string, new () => unknown>)[name];
    if (!AdapterClass) {
      console.warn(`[loader] ccxt has no adapter "${name}"; skipping`);
      continue;
    }
    const adapter = new AdapterClass() as unknown as { options: Record<string, unknown> };
    adapter.options = { ...adapter.options, defaultType: "swap" };

    for (const symbol of opts.symbols) {
      console.log(`[loader] ${name} ${symbol} funding`);
      const fr = await loadFundingRateHistory(adapter as any, row.id, symbol, opts.from, opts.to);
      totals.fundingInserted += fr.inserted;
      totals.fundingSkipped += fr.skipped;

      console.log(`[loader] ${name} ${symbol} ohlcv ${opts.timeframe}`);
      const ohlcv = await loadOhlcvHistory(adapter as any, row.id, symbol, opts.timeframe, opts.from, opts.to);
      totals.ohlcvInserted += ohlcv.inserted;
      totals.ohlcvSkipped += ohlcv.skipped;
    }
  }
  return totals;
}
