import { keys } from "@/server/db/redis-keys";
import { generateExecutionId, generateClientOrderId } from "./id";
import { reconcileOrder } from "./reconcile";
import type { CloseHedgedRequest, ExecutionResult, ExecutorContext } from "./types";
import type { ExchangeAdapter } from "@/server/services/exchange/types";
import type { Decimal } from "@prisma/client/runtime/library";
import type { Exchange } from "@prisma/client";

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  return (v as Decimal).toNumber();
}

const LOCK_TTL_SECONDS = 60;
const RESULT_TTL_SECONDS = 300;

export async function closeHedgedPosition(
  ctx: ExecutorContext,
  req: CloseHedgedRequest,
): Promise<ExecutionResult> {
  if (!req.idempotencyKey) {
    throw new Error("idempotencyKey is required");
  }

  const resultKey = keys.idempotencyResult(req.idempotencyKey);
  const cached = await ctx.redis.get(resultKey);
  if (cached) {
    return JSON.parse(cached) as ExecutionResult;
  }

  const lockKey = keys.idempotencyLock(req.idempotencyKey);
  const acquired = await ctx.redis.set(lockKey, "1", "EX", LOCK_TTL_SECONDS, "NX");
  if (!acquired) {
    throw new Error(`Duplicate request in flight for key ${req.idempotencyKey}`);
  }

  const executionId = generateExecutionId();
  let finalResult: ExecutionResult;

  try {
    const position = (await ctx.store.findPositionOrThrow(
      { id: req.positionId },
      { longExchange: true, shortExchange: true },
    )) as unknown as import("@prisma/client").Position & {
      longExchange: Exchange;
      shortExchange: Exchange;
    };

    if (position.status !== "OPEN" && position.status !== "RESCUE") {
      throw new Error(`Cannot close position in status ${position.status}`);
    }

    await ctx.store.updatePosition(position.id, { status: "CLOSING" });

    const [longAdapter, shortAdapter] = await Promise.all([
      ctx.adapterFor(position.longExchange.name),
      ctx.adapterFor(position.shortExchange.name),
    ]);

    const longSize = toNum(position.longSize);
    const shortSize = toNum(position.shortSize);

    const longClientId = generateClientOrderId();
    const shortClientId = generateClientOrderId();

    // Pre-persist PENDING close trade_logs (same pattern as execute-open)
    if (longSize > 0) {
      await ctx.store.createTradeLog({
        positionId: position.id,
        exchangeId: position.longExchangeId,
        executionId,
        clientOrderId: longClientId,
        side: "LONG",
        action: "CLOSE",
        orderType: "MARKET",
        price: 0,
        signedQty: -longSize, // close is negative
        fee: 0,
        status: "PENDING",
      });
    }
    if (shortSize > 0) {
      await ctx.store.createTradeLog({
        positionId: position.id,
        exchangeId: position.shortExchangeId,
        executionId,
        clientOrderId: shortClientId,
        side: "SHORT",
        action: "CLOSE",
        orderType: "MARKET",
        price: 0,
        signedQty: -shortSize,
        fee: 0,
        status: "PENDING",
      });
    }

    // Fire concurrent close orders
    await Promise.allSettled([
      longSize > 0
        ? submitCloseAndReconcile(ctx, {
            adapter: longAdapter,
            clientOrderId: longClientId,
            symbol: position.symbol,
            side: "long",
            size: longSize,
          })
        : Promise.resolve(),
      shortSize > 0
        ? submitCloseAndReconcile(ctx, {
            adapter: shortAdapter,
            clientOrderId: shortClientId,
            symbol: position.symbol,
            side: "short",
            size: shortSize,
          })
        : Promise.resolve(),
    ]);

    // Mark position as closed regardless of exchange outcome — the trade_logs
    // carry the true state and reconcile will have updated aggregates
    await ctx.store.updatePosition(position.id, {
      status: "CLOSED",
      closeReason: req.reason.toUpperCase() as any,
      closedAt: ctx.clock.now(),
    });

    finalResult = {
      status: "filled",
      positionId: position.id,
      executionId,
    };

    const { dispatch } = await import("@/server/services/notifier");
    await dispatch({
      kind: "position_closed",
      symbol: position.symbol,
      pnl: 0, // Plan 3 wires real P&L from settlements
      reason: req.reason,
    });

    await ctx.redis.set(resultKey, JSON.stringify(finalResult), "EX", RESULT_TTL_SECONDS);
    return finalResult;
  } finally {
    await ctx.redis.del(lockKey);
  }
}

async function submitCloseAndReconcile(
  ctx: ExecutorContext,
  args: {
    adapter: ExchangeAdapter;
    clientOrderId: string;
    symbol: string;
    side: "long" | "short";
    size: number;
  },
): Promise<void> {
  try {
    await args.adapter.closePosition({
      symbol: args.symbol,
      side: args.side,
      size: args.size,
      clientOrderId: args.clientOrderId,
    });
  } catch (err) {
    ctx.log(`closePosition error for ${args.clientOrderId}`, { err });
  }

  try {
    await reconcileOrder(ctx, { clientOrderId: args.clientOrderId, adapter: args.adapter });
  } catch (err) {
    ctx.log(`reconcile failed for ${args.clientOrderId}`, { err });
  }
}
