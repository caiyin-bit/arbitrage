import { keys } from "@/server/db/redis-keys";
import { generateExecutionId, generateClientOrderId } from "./id";
import { reconcileOrder } from "./reconcile";
import { decideRescueStrategy } from "./rescue";
import type { OpenHedgedRequest, ExecutionResult, ExecutorContext } from "./types";
import type { ExchangeAdapter } from "@/server/services/exchange/types";
import type { Decimal } from "@prisma/client/runtime/library";

// Temporary compat: reconcileOrder will accept ctx as first param in T13.
// Until then, we wrap the old signature.
async function reconcileOrderCompat(
  _ctx: ExecutorContext,
  args: { clientOrderId: string; adapter: ExchangeAdapter },
) {
  return reconcileOrder(args); // old signature, still works
}

const LOCK_TTL_SECONDS = 60;
const RESULT_TTL_SECONDS = 300; // 5 minutes

export async function openHedgedPosition(
  ctx: ExecutorContext,
  req: OpenHedgedRequest,
): Promise<ExecutionResult> {
  const idempotencyKey = req.idempotencyKey;
  if (!idempotencyKey) {
    throw new Error("idempotencyKey is required");
  }

  // Replay cached result
  const resultKey = keys.idempotencyResult(idempotencyKey);
  const cached = await ctx.redis.get(resultKey);
  if (cached) {
    return JSON.parse(cached) as ExecutionResult;
  }

  // Acquire lock
  const lockKey = keys.idempotencyLock(idempotencyKey);
  const acquired = await ctx.redis.set(lockKey, "1", "EX", LOCK_TTL_SECONDS, "NX");
  if (!acquired) {
    throw new Error(`Duplicate request in flight for key ${idempotencyKey}`);
  }

  const executionId = generateExecutionId();

  let finalResult: ExecutionResult;
  try {
    const longExchangeRow = await ctx.store.findExchangeByName(req.longExchange);
    if (!longExchangeRow) throw new Error(`Exchange not found or disabled: ${req.longExchange}`);
    const shortExchangeRow = await ctx.store.findExchangeByName(req.shortExchange);
    if (!shortExchangeRow) throw new Error(`Exchange not found or disabled: ${req.shortExchange}`);

    const [longAdapter, shortAdapter] = await Promise.all([
      ctx.adapterFor(req.longExchange),
      ctx.adapterFor(req.shortExchange),
    ]);

    const position = await ctx.store.createPosition({
      opportunityId: req.opportunityId,
      symbol: req.symbol,
      longExchangeId: longExchangeRow.id,
      shortExchangeId: shortExchangeRow.id,
      longSize: 0,
      longAvgEntryPrice: 0,
      shortSize: 0,
      shortAvgEntryPrice: 0,
      status: "OPENING",
      openedAt: ctx.clock.now(),
    });

    const longClientId = generateClientOrderId();
    const shortClientId = generateClientOrderId();

    // Pre-persist PENDING trade_logs BEFORE sending any orders
    await ctx.store.createTradeLog({
      positionId: position.id,
      exchangeId: longExchangeRow.id,
      executionId,
      clientOrderId: longClientId,
      side: "LONG",
      action: "OPEN",
      orderType: "LIMIT_IOC",
      price: 0,
      signedQty: req.size,
      fee: 0,
      status: "PENDING",
    });
    await ctx.store.createTradeLog({
      positionId: position.id,
      exchangeId: shortExchangeRow.id,
      executionId,
      clientOrderId: shortClientId,
      side: "SHORT",
      action: "OPEN",
      orderType: "LIMIT_IOC",
      price: 0,
      signedQty: req.size,
      fee: 0,
      status: "PENDING",
    });

    await Promise.allSettled([
      submitAndReconcile(ctx, {
        adapter: longAdapter,
        clientOrderId: longClientId,
        symbol: req.symbol,
        side: "long",
        size: req.size,
        leverage: req.leverage,
      }),
      submitAndReconcile(ctx, {
        adapter: shortAdapter,
        clientOrderId: shortClientId,
        symbol: req.symbol,
        side: "short",
        size: req.size,
        leverage: req.leverage,
      }),
    ]);

    const logs = await ctx.store.listTradeLogs(executionId);

    const longLog = logs.find((l) => l.clientOrderId === longClientId)!;
    const shortLog = logs.find((l) => l.clientOrderId === shortClientId)!;

    if (longLog.status === "PENDING" || shortLog.status === "PENDING") {
      const { reconcileRetryQueue } = await import("@/server/jobs/queues");
      await reconcileRetryQueue.add(
        "reconcile",
        {
          executionId,
          clientOrderIds: [longClientId, shortClientId].filter(
            (_, i) => [longLog, shortLog][i].status === "PENDING",
          ),
        },
        { delay: 5_000, attempts: 5, backoff: { type: "exponential", delay: 5000 } },
      );
      finalResult = {
        status: "failed",
        positionId: position.id,
        executionId,
        note: "One or more legs unreachable; queued for reconcile",
      };
    } else {
      const longFilled = longLog.status === "FILLED" || longLog.status === "PARTIAL"
        ? Math.abs((longLog.signedQty as unknown as Decimal).toNumber())
        : 0;
      const shortFilled = shortLog.status === "FILLED" || shortLog.status === "PARTIAL"
        ? Math.abs((shortLog.signedQty as unknown as Decimal).toNumber())
        : 0;

      const plan = decideRescueStrategy({ longFilled, shortFilled });

      if (plan.kind === "both_filled") {
        await ctx.store.updatePosition(position.id, { status: "OPEN" });
        finalResult = { status: "filled", positionId: position.id, executionId };
        const { dispatch } = await import("@/server/services/notifier");
        await dispatch({
          kind: "position_opened",
          symbol: req.symbol,
          size: req.size,
          executionId,
        });
      } else if (plan.kind === "both_failed") {
        await ctx.store.updatePosition(position.id, {
          status: "CLOSED",
          closedAt: ctx.clock.now(),
        });
        finalResult = {
          status: "failed",
          positionId: position.id,
          executionId,
          note: "Both legs failed to fill",
        };
      } else {
        const { executeRescue } = await import("./rescue-execute");
        finalResult = await executeRescue({
          position,
          plan,
          executionId,
          longAdapter,
          shortAdapter,
          longExchangeId: longExchangeRow.id,
          shortExchangeId: shortExchangeRow.id,
          symbol: req.symbol,
        });
      }
    }

    await ctx.redis.set(resultKey, JSON.stringify(finalResult), "EX", RESULT_TTL_SECONDS);
    return finalResult;
  } finally {
    await ctx.redis.del(lockKey);
  }
}

async function submitAndReconcile(
  ctx: ExecutorContext,
  args: {
    adapter: ExchangeAdapter;
    clientOrderId: string;
    symbol: string;
    side: "long" | "short";
    size: number;
    leverage: number;
  },
): Promise<void> {
  try {
    await args.adapter.openPosition({
      symbol: args.symbol,
      side: args.side,
      size: args.size,
      leverage: args.leverage,
      clientOrderId: args.clientOrderId,
    });
  } catch (err) {
    ctx.log(`openPosition error for ${args.clientOrderId}`, { err });
  }

  try {
    await reconcileOrderCompat(ctx, { clientOrderId: args.clientOrderId, adapter: args.adapter });
  } catch (err) {
    ctx.log(`reconcile failed for ${args.clientOrderId}`, { err });
  }
}
