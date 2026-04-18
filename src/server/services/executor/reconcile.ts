import type { ExchangeAdapter } from "@/server/services/exchange/types";
import type { ExecutorContext } from "./types";
import { computeAggregates, type RawFill } from "./aggregate";
import type { Decimal } from "@prisma/client/runtime/library";

/**
 * Query the exchange for a specific clientOrderId and reconcile the DB state.
 * Idempotent — safe to call multiple times. The clientOrderId unique constraint
 * and the explicit status check guarantee exactly-once transitions.
 */
export async function reconcileOrder(
  ctx: ExecutorContext,
  args: {
    clientOrderId: string;
    adapter: ExchangeAdapter;
  },
): Promise<"filled" | "partial" | "failed" | "pending"> {
  const row = await ctx.store.findTradeLogOrThrow({
    clientOrderId: args.clientOrderId,
  });

  if (row.status === "FILLED" || row.status === "FAILED") {
    return row.status.toLowerCase() as "filled" | "failed";
  }

  let order;
  try {
    order = await args.adapter.getOrder(args.clientOrderId);
  } catch {
    // Exchange doesn't know the order → return pending; caller decides retry
    return "pending";
  }

  if (!order) return "pending";

  const filled = order.filledSize ?? 0;
  const rowQty = row.signedQty ? Math.abs((row.signedQty as unknown as Decimal).toNumber()) : 0;

  let newStatus: "FILLED" | "PARTIAL" | "FAILED";
  if (filled === 0) newStatus = "FAILED";
  else if (rowQty > 0 && filled < rowQty) newStatus = "PARTIAL";
  else newStatus = "FILLED";

  await ctx.store.transaction(async (tx) => {
    // Lock the position row first to serialize concurrent reconcile calls
    await tx.lockPositionForUpdate(row.positionId);

    await tx.updateTradeLogByClientOrderId(args.clientOrderId, {
      status: newStatus,
      price: order.price,
      signedQty: row.action === "OPEN" ? filled : -filled,
      fee: order.fee,
      exchangeOrderId: order.id,
      executedAt: ctx.clock.now(),
    });

    const logs = await tx.findManyTradeLogs({ positionId: row.positionId });

    const fills: RawFill[] = logs.map((l) => ({
      side: l.side.toLowerCase() as "long" | "short",
      action: l.action.toLowerCase() as "open" | "close" | "rescue",
      signedQty: (l.signedQty as unknown as Decimal).toNumber(),
      price: (l.price as unknown as Decimal).toNumber(),
      status: l.status.toLowerCase() as "filled" | "pending" | "failed",
    }));

    const agg = computeAggregates(fills);

    await tx.updatePosition(row.positionId, {
      longSize: agg.longSize,
      longAvgEntryPrice: agg.longAvgEntry,
      shortSize: agg.shortSize,
      shortAvgEntryPrice: agg.shortAvgEntry,
    });
  });

  return newStatus.toLowerCase() as "filled" | "partial" | "failed";
}
