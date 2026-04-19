import { prisma } from "@/server/db/client";
import { openHedgedPosition } from "@/server/services/executor/execute-open";
import { closeHedgedPosition } from "@/server/services/executor/execute-close";
import { findOpportunities } from "@/server/services/detector/opportunity";
import type { FundingRate } from "@/lib/types";
import type { ExchangeName } from "@/lib/constants";
import type { ExecutorContext } from "@/server/services/executor/types";
import type { TradeLog } from "@prisma/client";
import type { BacktestConfig, BacktestResult, ClosedTrade, EquityCurvePoint } from "../types";
import { VirtualClock } from "./virtual-clock";
import { buildTimeline, type VirtualEvent } from "./timeline";
import { InMemoryPositionStore } from "./in-memory-store";
import { InMemoryRedis } from "./in-memory-redis";
import { HistoricalAdapter } from "./historical-adapter";
import { createFailureInjector } from "./failure-injector";

export async function runBacktest(config: BacktestConfig): Promise<BacktestResult> {
  const startedAt = new Date();
  const clock = new VirtualClock(config.from);
  const failure = createFailureInjector(config.seed, config.failureRate);

  const exchangeRows = await prisma.exchange.findMany({ select: { id: true, name: true } });
  const exchangeNamesById = new Map<string, string>(exchangeRows.map((e) => [e.id, e.name]));
  const store = new InMemoryPositionStore(exchangeRows);
  const redis = new InMemoryRedis(() => clock.now());

  const adapters = new Map<string, HistoricalAdapter>();
  for (const e of exchangeRows) {
    adapters.set(e.name, new HistoricalAdapter(e.name, clock, failure, config.slippageBps));
  }

  const ctx: ExecutorContext = {
    store,
    redis,
    adapterFor: async (name: string) => {
      const a = adapters.get(name);
      if (!a) throw new Error(`no adapter for ${name}`);
      return a;
    },
    clock,
    random: failure.random,
    log: (msg, meta) => {
      if (process.env.BACKTEST_VERBOSE) console.log(`[bt] ${msg}`, meta ?? "");
    },
  };

  const timeline = await buildTimeline({
    from: config.from,
    to: config.to,
    healthIntervalSec: config.healthIntervalSec,
  });

  const equityCurve: EquityCurvePoint[] = [];
  let lastDay = "";

  for (const event of timeline) {
    clock.setTime(event.at);
    try {
      switch (event.type) {
        case "funding_collection": await handleFundingCollection(ctx, config); break;
        case "health_check":       await handleHealthCheck(ctx, config);       break;
        case "settlement":         await handleSettlement(ctx, event, store);  break;
      }
    } catch (err) {
      ctx.log("handler error", {
        type: event.type,
        at: event.at.toISOString(),
        err: String(err),
      });
    }

    const dayKey = event.at.toISOString().slice(0, 10);
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      const closedTradesByThen = buildClosedTrades(store, exchangeNamesById).filter(
        (t) => t.closedAt.getTime() <= event.at.getTime(),
      );
      const realizedPriceAndFees = closedTradesByThen.reduce((s, t) => s + (t.grossPnl - t.fees), 0);
      const settlementsSoFar = store.allSettlements().filter(
        (s) => s.settledAt.getTime() <= event.at.getTime(),
      );
      const fundingSoFar = settlementsSoFar.reduce((s, x) => s + Number(x.fundingAmount), 0);
      const equity = config.initialCapital + realizedPriceAndFees + fundingSoFar;
      const dayGrossPnl = closedTradesByThen.reduce((s, t) => s + t.grossPnl, 0);
      const dayNetPnl = closedTradesByThen.reduce((s, t) => s + t.netPnl, 0) + fundingSoFar;
      const totalFees = closedTradesByThen.reduce((s, t) => s + t.fees, 0);
      equityCurve.push({
        date: new Date(dayKey + "T00:00:00Z"),
        equity,
        grossPnl: dayGrossPnl,
        netPnl: dayNetPnl,
        totalFees,
      });
    }
  }

  // Force-close any remaining open positions at config.to
  clock.setTime(config.to);
  const openAtEnd = await store.listOpenPositions();
  for (const p of openAtEnd) {
    try {
      await closeHedgedPosition(ctx, {
        idempotencyKey: `bt-force-close-${p.id}`,
        positionId: p.id,
        reason: "manual",
      });
    } catch (err) {
      ctx.log("force-close error", { positionId: p.id, err: String(err) });
    }
  }

  const closedTrades = buildClosedTrades(store, exchangeNamesById);
  return { config, startedAt, finishedAt: new Date(), closedTrades, equityCurve };
}

/**
 * Replicates Plan 2's nextPauseState logic using historical OHLCV from DB.
 *
 * Production health.ts compares two consecutive kline closes:
 *   priceChange1h  = (kline1h[1].close - kline1h[0].close) / kline1h[0].close
 *   priceChange24h = (kline1d[1].close - kline1d[0].close) / kline1d[0].close
 *
 * In the backtest we have only 1h candles, so:
 *   - 1h check: compare the two most recent 1h closes
 *   - 24h check: compare close 24 candles ago to the latest close
 *
 * Returns true if ANY monitored symbol is currently paused.
 */
async function checkVolatilityPause(now: Date, cfg: BacktestConfig): Promise<boolean> {
  // Symbols currently being traded (open positions) — mirror production's buildMonitoredSymbols
  const openSymbols = await prisma.fundingRateSnapshot.findMany({
    where: { collectedAt: { lte: now } },
    select: { symbol: true },
    distinct: ["symbol"],
  });
  const symbols = [...new Set(openSymbols.map((r) => r.symbol))];
  if (symbols.length === 0) return false;

  for (const symbol of symbols) {
    // Fetch 25 most-recent 1h candles up to `now` (any exchange — we just need price)
    const candles = await prisma.ohlcvSnapshot.findMany({
      where: { symbol, timeframe: "1h", openTime: { lte: now } },
      orderBy: { openTime: "desc" },
      take: 25,
      select: { close: true },
    });
    if (candles.length < 2) continue;

    // candles[0] is most recent, candles[1] is previous
    const latest = Number(candles[0].close);
    const prev1h  = Number(candles[1].close);
    const priceChange1h = (latest - prev1h) / prev1h;

    if (Math.abs(priceChange1h) > cfg.volatilityThreshold1h) return true;

    if (candles.length >= 25) {
      const prev24h = Number(candles[24].close);
      const priceChange24h = (latest - prev24h) / prev24h;
      if (Math.abs(priceChange24h) > cfg.volatilityThreshold24h) return true;
    }
  }
  return false;
}

async function handleFundingCollection(ctx: ExecutorContext, cfg: BacktestConfig) {
  const now = ctx.clock.now();

  if (cfg.volatilityPauseEnabled) {
    const paused = await checkVolatilityPause(now, cfg);
    if (paused) {
      ctx.log("volatility pause active, skipping opens");
      return;
    }
  }
  const rates = await prisma.fundingRateSnapshot.findMany({
    where: { collectedAt: { lte: now } },
    include: { exchange: { select: { name: true } } },
    orderBy: { collectedAt: "desc" },
    take: 200,
  });

  // Deduplicate to latest per exchange:symbol
  const latest = new Map<string, (typeof rates)[number]>();
  for (const r of rates) {
    const k = `${r.exchange.name}:${r.symbol}`;
    if (!latest.has(k)) latest.set(k, r);
  }

  // Build FundingRate[] as required by findOpportunities
  const snapshots: FundingRate[] = [...latest.values()].map((r) => ({
    exchange: r.exchange.name as ExchangeName,
    symbol: r.symbol,
    currentRate: Number(r.currentRate),
    predictedRate: null,
    nextSettlement: r.collectedAt,
    intervalHours: r.intervalHours,
    timestamp: r.collectedAt,
  }));

  const ops = findOpportunities(snapshots, {
    minRateSpread: cfg.minSpread,
    minAnnualizedYield: cfg.minApy,
  });

  const openCount = (await ctx.store.listOpenPositions()).length;
  const slots = Math.max(0, cfg.maxConcurrent - openCount);

  // Diagnostic: sample per-tick snapshot/opportunity/slot counts to a
  // low-frequency probe (every 288 ticks ≈ once per day in a 5min tick loop).
  // Gated by BACKTEST_VERBOSE=summary to avoid flooding 52560 ticks of log.
  if (process.env.BACKTEST_VERBOSE === "summary") {
    const tickMinute = Math.floor(now.getTime() / 60000);
    if (tickMinute % (60 * 24) < 5) {
      ctx.log("tick", {
        at: now.toISOString().slice(0, 13),
        snapshots: snapshots.length,
        opps: ops.length,
        openCount,
        slots,
        firstOp: ops[0]
          ? `${ops[0].symbol} ${ops[0].longExchange}→${ops[0].shortExchange} spread=${ops[0].rateSpread.toFixed(6)}`
          : null,
      });
    }
  }

  if (ops.length > 0 && slots > 0) {
    ctx.log("attempting opens", { count: Math.min(ops.length, slots), of: ops.length });
  }

  for (const op of ops.slice(0, slots)) {
    try {
      const result = await openHedgedPosition(ctx, {
        idempotencyKey: `bt-${ctx.clock.now().getTime()}-${op.symbol}-${op.longExchange}-${op.shortExchange}`,
        opportunityId: `bt-op-${ctx.clock.now().getTime()}`,
        symbol: op.symbol,
        longExchange: op.longExchange,
        shortExchange: op.shortExchange,
        size: cfg.positionSize,
        leverage: 1,
      });
      ctx.log("open result", {
        symbol: op.symbol,
        status: result.status,
        positionId: result.positionId,
        note: result.note,
      });
    } catch (err) {
      ctx.log("open error", {
        symbol: op.symbol,
        longExchange: op.longExchange,
        shortExchange: op.shortExchange,
        err: String(err),
      });
    }
  }
}

async function handleHealthCheck(ctx: ExecutorContext, _cfg: BacktestConfig) {
  const open = await ctx.store.listOpenPositions();
  for (const p of open) {
    const openedAt = (p as unknown as { openedAt: Date }).openedAt;
    if (!openedAt) continue;
    const hours = (ctx.clock.now().getTime() - openedAt.getTime()) / 3_600_000;
    if (hours > 72) {
      try {
        await closeHedgedPosition(ctx, {
          idempotencyKey: `bt-close-${p.id}-${ctx.clock.now().getTime()}`,
          positionId: p.id,
          reason: "risk_control",
        });
      } catch (err) {
        ctx.log("close error", { positionId: p.id, err: String(err) });
      }
    }
  }
}

async function handleSettlement(
  ctx: ExecutorContext,
  event: Extract<VirtualEvent, { type: "settlement" }>,
  _store: InMemoryPositionStore,
) {
  const open = await ctx.store.listOpenPositions();
  const exchange = await ctx.store.findExchangeByName(event.exchangeName);
  if (!exchange) return;

  for (const p of open as unknown as Array<{
    id: string;
    symbol: string;
    longExchangeId: string;
    shortExchangeId: string;
    longSize: unknown;
    shortSize: unknown;
  }>) {
    if (p.symbol !== event.symbol) continue;
    const isLong = exchange.id === p.longExchangeId;
    const isShort = exchange.id === p.shortExchangeId;
    if (!isLong && !isShort) continue;

    // Long pays when rate is positive; short receives. Amount is negative when paying.
    const notional = Number(isLong ? p.longSize : p.shortSize);
    const amount = notional * event.fundingRate * (isLong ? -1 : 1);

    await ctx.store.createSettlement({
      positionId: p.id,
      exchangeId: exchange.id,
      // Settlement schema: side, fundingRate, fundingAmount, settledAt
      side: isLong ? "LONG" : "SHORT",
      fundingRate: event.fundingRate,
      fundingAmount: amount,
      settledAt: event.at,
    });
  }
}

function buildClosedTrades(
  store: InMemoryPositionStore,
  exchangeNames: Map<string, string>,
): ClosedTrade[] {
  const wAvg = (ls: TradeLog[]) => {
    const totalQty = ls.reduce((s, l) => s + Math.abs(Number(l.signedQty)), 0);
    if (totalQty === 0) return 0;
    return ls.reduce((s, l) => s + Number(l.price) * Math.abs(Number(l.signedQty)), 0) / totalQty;
  };

  const trades: ClosedTrade[] = [];
  for (const p of store.allPositions()) {
    if (p.status !== "CLOSED") continue;

    const logs = store.allTradeLogs().filter((l) => l.positionId === p.id);
    const settlements = store.allSettlements().filter((s) => s.positionId === p.id);

    const buckets: Record<string, TradeLog[]> = {
      OPEN_LONG: [],
      OPEN_SHORT: [],
      CLOSE_LONG: [],
      CLOSE_SHORT: [],
    };
    for (const log of logs) {
      const key = `${log.action}_${log.side}`;
      if (key in buckets) buckets[key].push(log);
    }

    const longEntry  = wAvg(buckets.OPEN_LONG);
    const shortEntry = wAvg(buckets.OPEN_SHORT);
    const longExit   = wAvg(buckets.CLOSE_LONG);
    const shortExit  = wAvg(buckets.CLOSE_SHORT);

    const longSize  = Number(p.longSize);
    const shortSize = Number(p.shortSize);
    const grossPnl  = (longExit - longEntry) * longSize + (shortEntry - shortExit) * shortSize;

    const fees       = logs.reduce((s, l) => s + Number(l.fee), 0);
    const fundingPnl = settlements.reduce((s, x) => s + Number(x.fundingAmount), 0);
    const netPnl     = grossPnl + fundingPnl - fees;

    const openedAt  = p.openedAt ?? new Date(0);
    const closedAt  = p.closedAt ?? new Date();
    const holdHours = (closedAt.getTime() - openedAt.getTime()) / 3_600_000;

    trades.push({
      positionId:    p.id,
      symbol:        p.symbol,
      longExchange:  exchangeNames.get(p.longExchangeId)  ?? p.longExchangeId,
      shortExchange: exchangeNames.get(p.shortExchangeId) ?? p.shortExchangeId,
      openedAt, closedAt,
      longEntry, shortEntry, longExit, shortExit,
      grossPnl, fees, fundingPnl, netPnl, holdHours,
    });
  }
  return trades;
}
