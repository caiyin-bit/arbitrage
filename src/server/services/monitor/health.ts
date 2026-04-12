import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import { keys, type PauseState } from "@/server/db/redis-keys";
import { createAdapter } from "@/server/services/exchange/factory";
import { decrypt } from "@/server/services/crypto/encryption";
import { nextPauseState } from "./volatility";
import type { ExchangeAdapter } from "@/server/services/exchange/types";
import type { ExchangeName } from "@/lib/constants";
import type { OHLCV } from "@/lib/types";

const PRICE_SOURCE_PRIORITY: ExchangeName[] = ["binance", "okx", "bybit", "huobi", "gateio"];

async function buildMonitoredSymbols(): Promise<string[]> {
  const [openPositions, baselineSetting] = await Promise.all([
    prisma.position.findMany({
      where: { status: { in: ["OPENING", "OPEN", "RESCUE"] } },
      select: { symbol: true },
      distinct: ["symbol"],
    }),
    prisma.setting.findUnique({ where: { key: "monitored_symbols" } }),
  ]);

  const baseline = (baselineSetting?.value as string[] | undefined) ?? [];
  const set = new Set<string>([...baseline, ...openPositions.map((p) => p.symbol)]);
  return Array.from(set);
}

async function getOrderedPriceSources(): Promise<ExchangeAdapter[]> {
  const enabled = await prisma.exchange.findMany({ where: { isEnabled: true } });
  const byName = new Map(enabled.map((e) => [e.name, e]));
  const adapters: ExchangeAdapter[] = [];
  for (const name of PRICE_SOURCE_PRIORITY) {
    const ex = byName.get(name);
    if (!ex) continue;
    adapters.push(
      createAdapter(
        ex.name as ExchangeName,
        decrypt(ex.apiKey),
        decrypt(ex.apiSecret),
        ex.passphrase ? decrypt(ex.passphrase) : undefined,
      ),
    );
  }
  return adapters;
}

async function fetchKlinesWithFallback(
  adapters: ExchangeAdapter[],
  symbol: string,
): Promise<{ kline1h: OHLCV[]; kline1d: OHLCV[]; source: string } | null> {
  for (const adapter of adapters) {
    try {
      const [kline1h, kline1d] = await Promise.all([
        adapter.getKline(symbol, "1h", 2),
        adapter.getKline(symbol, "1d", 2),
      ]);
      if (kline1h.length >= 2 && kline1d.length >= 2) {
        return { kline1h, kline1d, source: adapter.name };
      }
    } catch (err) {
      console.warn(`[health] ${symbol} failed on ${adapter.name}:`, err);
    }
  }
  return null;
}

export async function runHealthCheck() {
  const [settings, adapters, monitoredSymbols] = await Promise.all([
    prisma.setting.findMany({
      where: { key: { in: ["volatility_threshold_1h", "volatility_threshold_24h"] } },
    }),
    getOrderedPriceSources(),
    buildMonitoredSymbols(),
  ]);

  if (adapters.length === 0) {
    console.log("[health] no enabled exchanges; skipping volatility check");
    return;
  }
  if (monitoredSymbols.length === 0) {
    console.log("[health] no symbols to monitor");
    return;
  }

  const threshold1h =
    (settings.find((s) => s.key === "volatility_threshold_1h")?.value as number) ?? 0.05;
  const threshold24h =
    (settings.find((s) => s.key === "volatility_threshold_24h")?.value as number) ?? 0.15;

  for (const symbol of monitoredSymbols) {
    const result = await fetchKlinesWithFallback(adapters, symbol);
    if (!result) {
      console.warn(`[health] ${symbol} unavailable on all sources; skipped`);
      continue;
    }

    const priceChange1h =
      (result.kline1h[1].close - result.kline1h[0].close) / result.kline1h[0].close;
    const priceChange24h =
      (result.kline1d[1].close - result.kline1d[0].close) / result.kline1d[0].close;

    const currentRaw = await redis.get(keys.pause(symbol));
    const current: PauseState | null = currentRaw ? JSON.parse(currentRaw) : null;

    const next = nextPauseState({
      current,
      priceChange1h,
      priceChange24h,
      threshold1h,
      threshold24h,
    });

    if (next === null) {
      if (current) {
        await redis.del(keys.pause(symbol));
        console.log(`[health] ${symbol} volatility recovered (source=${result.source})`);
      }
    } else {
      await redis.set(keys.pause(symbol), JSON.stringify(next));
      if (!current) {
        const { dispatch } = await import("@/server/services/notifier");
        await dispatch({
          kind: "volatility_pause",
          symbol,
          reason: next.reason,
          change: next.reason === "1h_volatility" ? priceChange1h : priceChange24h,
        });
      }
      if (!current || current.recoveryCount !== next.recoveryCount) {
        console.log(`[health] ${symbol} pause state (source=${result.source}):`, next);
      }
    }
  }

  // Position snapshot (logging only — Plan 3 adds real drift detection)
  const openPositions = await prisma.position.findMany({
    where: { status: { in: ["OPEN", "RESCUE"] } },
    include: { longExchange: true, shortExchange: true },
  });
  for (const pos of openPositions) {
    console.log(`[health] Position ${pos.id} (${pos.symbol}) status=${pos.status}`);
  }
}
