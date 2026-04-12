import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import { keys } from "@/server/db/redis-keys";
import { createAdapter } from "@/server/services/exchange/factory";
import { decrypt } from "@/server/services/crypto/encryption";
import { generateExecutionId, generateClientOrderId } from "./id";
import { reconcileOrder } from "./reconcile";
import type { CloseHedgedRequest, ExecutionResult } from "./types";
import type { ExchangeAdapter } from "@/server/services/exchange/types";
import type { ExchangeName } from "@/lib/constants";
import type { Decimal } from "@prisma/client/runtime/library";

const LOCK_TTL_SECONDS = 60;
const RESULT_TTL_SECONDS = 300;

export async function closeHedgedPosition(
  req: CloseHedgedRequest,
): Promise<ExecutionResult> {
  if (!req.idempotencyKey) {
    throw new Error("idempotencyKey is required");
  }

  const resultKey = keys.idempotencyResult(req.idempotencyKey);
  const cached = await redis.get(resultKey);
  if (cached) {
    return JSON.parse(cached) as ExecutionResult;
  }

  const lockKey = keys.idempotencyLock(req.idempotencyKey);
  const acquired = await redis.set(lockKey, "1", "EX", LOCK_TTL_SECONDS, "NX");
  if (!acquired) {
    throw new Error(`Duplicate request in flight for key ${req.idempotencyKey}`);
  }

  const executionId = generateExecutionId();
  let finalResult: ExecutionResult;

  try {
    const position = await prisma.position.findUniqueOrThrow({
      where: { id: req.positionId },
      include: { longExchange: true, shortExchange: true },
    });

    if (position.status !== "OPEN" && position.status !== "RESCUE") {
      throw new Error(`Cannot close position in status ${position.status}`);
    }

    await prisma.position.update({
      where: { id: position.id },
      data: { status: "CLOSING" },
    });

    const longAdapter = createAdapter(
      position.longExchange.name as ExchangeName,
      decrypt(position.longExchange.apiKey),
      decrypt(position.longExchange.apiSecret),
      position.longExchange.passphrase ? decrypt(position.longExchange.passphrase) : undefined,
    );
    const shortAdapter = createAdapter(
      position.shortExchange.name as ExchangeName,
      decrypt(position.shortExchange.apiKey),
      decrypt(position.shortExchange.apiSecret),
      position.shortExchange.passphrase ? decrypt(position.shortExchange.passphrase) : undefined,
    );

    const longSize = (position.longSize as unknown as Decimal).toNumber();
    const shortSize = (position.shortSize as unknown as Decimal).toNumber();

    const longClientId = generateClientOrderId();
    const shortClientId = generateClientOrderId();

    // Pre-persist PENDING close trade_logs (same pattern as execute-open)
    const createRows = [];
    if (longSize > 0) {
      createRows.push(
        prisma.tradeLog.create({
          data: {
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
          },
        }),
      );
    }
    if (shortSize > 0) {
      createRows.push(
        prisma.tradeLog.create({
          data: {
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
          },
        }),
      );
    }
    if (createRows.length > 0) {
      await prisma.$transaction(createRows);
    }

    // Fire concurrent close orders
    await Promise.allSettled([
      longSize > 0
        ? submitCloseAndReconcile({
            adapter: longAdapter,
            clientOrderId: longClientId,
            symbol: position.symbol,
            side: "long",
            size: longSize,
          })
        : Promise.resolve(),
      shortSize > 0
        ? submitCloseAndReconcile({
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
    await prisma.position.update({
      where: { id: position.id },
      data: {
        status: "CLOSED",
        closeReason: req.reason.toUpperCase() as any,
        closedAt: new Date(),
      },
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

    await redis.set(resultKey, JSON.stringify(finalResult), "EX", RESULT_TTL_SECONDS);
    return finalResult;
  } finally {
    await redis.del(lockKey);
  }
}

async function submitCloseAndReconcile(args: {
  adapter: ExchangeAdapter;
  clientOrderId: string;
  symbol: string;
  side: "long" | "short";
  size: number;
}): Promise<void> {
  try {
    await args.adapter.closePosition({
      symbol: args.symbol,
      side: args.side,
      size: args.size,
      clientOrderId: args.clientOrderId,
    });
  } catch (err) {
    console.warn(`[executor] closePosition error for ${args.clientOrderId}:`, err);
  }

  try {
    await reconcileOrder({ clientOrderId: args.clientOrderId, adapter: args.adapter });
  } catch (err) {
    console.error(`[executor] reconcile failed for ${args.clientOrderId}:`, err);
  }
}
