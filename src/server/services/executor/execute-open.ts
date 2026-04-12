import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import { keys } from "@/server/db/redis-keys";
import { createAdapter } from "@/server/services/exchange/factory";
import { decrypt } from "@/server/services/crypto/encryption";
import { generateExecutionId, generateClientOrderId } from "./id";
import { reconcileOrder } from "./reconcile";
import { decideRescueStrategy } from "./rescue";
import type { OpenHedgedRequest, ExecutionResult } from "./types";
import type { ExchangeAdapter } from "@/server/services/exchange/types";
import type { ExchangeName } from "@/lib/constants";
import type { Decimal } from "@prisma/client/runtime/library";

const LOCK_TTL_SECONDS = 60;
const RESULT_TTL_SECONDS = 300; // 5 minutes

export async function openHedgedPosition(
  req: OpenHedgedRequest,
): Promise<ExecutionResult> {
  const idempotencyKey = req.idempotencyKey;
  if (!idempotencyKey) {
    throw new Error("idempotencyKey is required");
  }

  // Replay cached result
  const resultKey = keys.idempotencyResult(idempotencyKey);
  const cached = await redis.get(resultKey);
  if (cached) {
    return JSON.parse(cached) as ExecutionResult;
  }

  // Acquire lock
  const lockKey = keys.idempotencyLock(idempotencyKey);
  const acquired = await redis.set(lockKey, "1", "EX", LOCK_TTL_SECONDS, "NX");
  if (!acquired) {
    throw new Error(`Duplicate request in flight for key ${idempotencyKey}`);
  }

  const executionId = generateExecutionId();

  let finalResult: ExecutionResult;
  try {
    const [long, short] = await Promise.all([
      prisma.exchange.findFirstOrThrow({
        where: { name: req.longExchange, isEnabled: true },
      }),
      prisma.exchange.findFirstOrThrow({
        where: { name: req.shortExchange, isEnabled: true },
      }),
    ]);

    const longAdapter = createAdapter(
      long.name as ExchangeName,
      decrypt(long.apiKey),
      decrypt(long.apiSecret),
      long.passphrase ? decrypt(long.passphrase) : undefined,
    );
    const shortAdapter = createAdapter(
      short.name as ExchangeName,
      decrypt(short.apiKey),
      decrypt(short.apiSecret),
      short.passphrase ? decrypt(short.passphrase) : undefined,
    );

    const position = await prisma.position.create({
      data: {
        opportunityId: req.opportunityId,
        symbol: req.symbol,
        longExchangeId: long.id,
        shortExchangeId: short.id,
        longSize: 0,
        longAvgEntryPrice: 0,
        shortSize: 0,
        shortAvgEntryPrice: 0,
        status: "OPENING",
        openedAt: new Date(),
      },
    });

    const longClientId = generateClientOrderId();
    const shortClientId = generateClientOrderId();

    // Pre-persist PENDING trade_logs BEFORE sending any orders
    await prisma.$transaction([
      prisma.tradeLog.create({
        data: {
          positionId: position.id,
          exchangeId: long.id,
          executionId,
          clientOrderId: longClientId,
          side: "LONG",
          action: "OPEN",
          orderType: "LIMIT_IOC",
          price: 0,
          signedQty: req.size,
          fee: 0,
          status: "PENDING",
        },
      }),
      prisma.tradeLog.create({
        data: {
          positionId: position.id,
          exchangeId: short.id,
          executionId,
          clientOrderId: shortClientId,
          side: "SHORT",
          action: "OPEN",
          orderType: "LIMIT_IOC",
          price: 0,
          signedQty: req.size,
          fee: 0,
          status: "PENDING",
        },
      }),
    ]);

    await Promise.allSettled([
      submitAndReconcile({
        adapter: longAdapter,
        clientOrderId: longClientId,
        symbol: req.symbol,
        side: "long",
        size: req.size,
        leverage: req.leverage,
      }),
      submitAndReconcile({
        adapter: shortAdapter,
        clientOrderId: shortClientId,
        symbol: req.symbol,
        side: "short",
        size: req.size,
        leverage: req.leverage,
      }),
    ]);

    const logs = await prisma.tradeLog.findMany({
      where: { executionId },
    });

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
        await prisma.position.update({
          where: { id: position.id },
          data: { status: "OPEN" },
        });
        finalResult = { status: "filled", positionId: position.id, executionId };
        const { dispatch } = await import("@/server/services/notifier");
        await dispatch({
          kind: "position_opened",
          symbol: req.symbol,
          size: req.size,
          executionId,
        });
      } else if (plan.kind === "both_failed") {
        await prisma.position.update({
          where: { id: position.id },
          data: { status: "CLOSED", closedAt: new Date() },
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
          longExchangeId: long.id,
          shortExchangeId: short.id,
          symbol: req.symbol,
        });
      }
    }

    await redis.set(resultKey, JSON.stringify(finalResult), "EX", RESULT_TTL_SECONDS);
    return finalResult;
  } finally {
    await redis.del(lockKey);
  }
}

async function submitAndReconcile(args: {
  adapter: ExchangeAdapter;
  clientOrderId: string;
  symbol: string;
  side: "long" | "short";
  size: number;
  leverage: number;
}): Promise<void> {
  try {
    await args.adapter.openPosition({
      symbol: args.symbol,
      side: args.side,
      size: args.size,
      leverage: args.leverage,
      clientOrderId: args.clientOrderId,
    });
  } catch (err) {
    console.warn(`[executor] openPosition error for ${args.clientOrderId}:`, err);
  }

  try {
    await reconcileOrder({ clientOrderId: args.clientOrderId, adapter: args.adapter });
  } catch (err) {
    console.error(`[executor] reconcile failed for ${args.clientOrderId}:`, err);
  }
}
