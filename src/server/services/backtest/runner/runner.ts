import { prisma } from "@/server/db/client";
import { openHedgedPosition } from "@/server/services/executor/execute-open";
import { closeHedgedPosition } from "@/server/services/executor/execute-close";
import { findOpportunities } from "@/server/services/detector/opportunity";
import type { FundingRate } from "@/lib/types";
import type { ExchangeName } from "@/lib/constants";
import type { ExecutorContext } from "@/server/services/executor/types";
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
      equityCurve.push({
        date: new Date(dayKey + "T00:00:00Z"),
        equity: config.initialCapital,
        grossPnl: 0,
        netPnl: 0,
        totalFees: 0,
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

  const closedTrades = buildClosedTrades(store);
  return { config, startedAt, finishedAt: new Date(), closedTrades, equityCurve };
}

async function handleFundingCollection(ctx: ExecutorContext, cfg: BacktestConfig) {
  const now = ctx.clock.now();
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

  for (const op of ops.slice(0, slots)) {
    try {
      await openHedgedPosition(ctx, {
        idempotencyKey: `bt-${ctx.clock.now().getTime()}-${op.symbol}-${op.longExchange}-${op.shortExchange}`,
        opportunityId: `bt-op-${ctx.clock.now().getTime()}`,
        symbol: op.symbol,
        longExchange: op.longExchange,
        shortExchange: op.shortExchange,
        size: cfg.positionSize,
        leverage: 1,
      });
    } catch (err) {
      ctx.log("open error", { err: String(err) });
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

function buildClosedTrades(store: InMemoryPositionStore): ClosedTrade[] {
  return store
    .allPositions()
    .filter((p) => p.status === "CLOSED")
    .map((p) => {
      const settlements = store.allSettlements().filter((s) => s.positionId === p.id);
      const fundingPnl = settlements.reduce((a, s) => a + Number(s.fundingAmount), 0);
      const pCast = p as unknown as {
        openedAt: Date;
        closedAt: Date | null;
        longExchangeId: string;
        shortExchangeId: string;
        longAvgEntryPrice: unknown;
        shortAvgEntryPrice: unknown;
      };
      const openedAt = pCast.openedAt ?? new Date(0);
      const closedAt = pCast.closedAt ?? new Date();
      const holdHours = (closedAt.getTime() - openedAt.getTime()) / 3_600_000;
      return {
        positionId: p.id,
        symbol: p.symbol,
        longExchange: pCast.longExchangeId,
        shortExchange: pCast.shortExchangeId,
        openedAt,
        closedAt,
        longEntry: Number(pCast.longAvgEntryPrice),
        shortEntry: Number(pCast.shortAvgEntryPrice),
        longExit: 0,   // stubbed — deferred to Reporter
        shortExit: 0,  // stubbed — deferred to Reporter
        grossPnl: 0,   // stubbed — deferred to Reporter
        fees: 0,        // stubbed — deferred to Reporter
        fundingPnl,
        netPnl: fundingPnl,
        holdHours,
      };
    });
}
