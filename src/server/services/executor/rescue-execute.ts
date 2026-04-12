import { prisma } from "@/server/db/client";
import type { ExchangeAdapter } from "@/server/services/exchange/types";
import type { Position } from "@prisma/client";
import { generateClientOrderId } from "./id";
import { recordTradeAndAggregate } from "./trade-recorder";
import type { RescuePlan } from "./rescue";
import type { ExecutionResult } from "./types";
import type { Decimal } from "@prisma/client/runtime/library";

interface ExecuteRescueArgs {
  position: Position;
  plan: RescuePlan;
  executionId: string;
  longAdapter: ExchangeAdapter;
  shortAdapter: ExchangeAdapter;
  longExchangeId: string;
  shortExchangeId: string;
  symbol: string;
}

const OPPORTUNITY_COOLDOWN_MS = 30 * 60 * 1000; // 30 min

export async function executeRescue(
  args: ExecuteRescueArgs,
): Promise<ExecutionResult> {
  const { position, plan, executionId, longAdapter, shortAdapter, longExchangeId, shortExchangeId, symbol } = args;

  let note = "";

  if (plan.kind === "rescue_orphan" || plan.kind === "rescue_excess") {
    // Market close the surplus side
    const adapter = plan.side === "long" ? longAdapter : shortAdapter;
    const exchangeId = plan.side === "long" ? longExchangeId : shortExchangeId;
    const clientOrderId = generateClientOrderId();

    const order = await adapter.closePosition({
      symbol,
      side: plan.side,
      size: plan.qty,
      clientOrderId,
    });

    await recordTradeAndAggregate({
      positionId: position.id,
      exchangeId,
      executionId,
      clientOrderId,
      side: plan.side,
      action: "rescue",
      orderType: "market",
      price: order.price,
      signedQty: -Math.abs(order.filledSize),
      fee: order.fee,
      exchangeOrderId: order.id,
      status: "filled",
      executedAt: new Date(),
    });

    note = `Rescued ${plan.qty} ${plan.side} via market reverse`;
  } else if (plan.kind === "topup") {
    // Market top-up the deficient side
    const adapter = plan.side === "long" ? longAdapter : shortAdapter;
    const exchangeId = plan.side === "long" ? longExchangeId : shortExchangeId;
    const clientOrderId = generateClientOrderId();

    const order = await adapter.openPosition({
      symbol,
      side: plan.side,
      size: plan.qty,
      leverage: 1,
      clientOrderId,
    });

    await recordTradeAndAggregate({
      positionId: position.id,
      exchangeId,
      executionId,
      clientOrderId,
      side: plan.side,
      action: "open",
      orderType: "market",
      price: order.price,
      signedQty: Math.abs(order.filledSize),
      fee: order.fee,
      exchangeOrderId: order.id,
      status: order.filledSize > 0 ? "filled" : "failed",
      executedAt: new Date(),
    });

    note = `Topped up ${plan.qty} ${plan.side} via market`;
  }

  // Re-read the position to see the post-rescue aggregates
  const updated = await prisma.position.findUniqueOrThrow({
    where: { id: position.id },
  });

  const longNet = (updated.longSize as unknown as Decimal).toNumber();
  const shortNet = (updated.shortSize as unknown as Decimal).toNumber();

  const newStatus = longNet === 0 && shortNet === 0
    ? "CLOSED"
    : longNet > 0 && shortNet > 0
    ? "OPEN"
    : "RESCUE";

  await prisma.position.update({
    where: { id: position.id },
    data: {
      status: newStatus,
      ...(newStatus === "CLOSED" ? { closedAt: new Date() } : {}),
    },
  });

  // Cool down the opportunity
  await prisma.opportunity.update({
    where: { id: position.opportunityId },
    data: {
      cooldownUntil: new Date(Date.now() + OPPORTUNITY_COOLDOWN_MS),
    },
  });

  const { dispatch } = await import("@/server/services/notifier");
  if (plan.kind !== "both_filled" && plan.kind !== "both_failed") {
    const dispatchSide: "long" | "short" =
      plan.kind === "topup" ? (plan.side === "long" ? "short" : "long") : plan.side;
    await dispatch({
      kind: "rescue_triggered",
      symbol,
      side: dispatchSide,
      qty: plan.qty,
      note,
    });
  }

  return {
    status: newStatus === "OPEN" ? "filled" : "rescued",
    positionId: position.id,
    executionId,
    note,
  };
}
