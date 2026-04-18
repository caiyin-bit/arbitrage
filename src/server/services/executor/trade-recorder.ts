import { computeAggregates, type RawFill } from "./aggregate";
import type { ExecutorContext } from "./types";
import type { Decimal } from "@prisma/client/runtime/library";

interface RecordTradeArgs {
  positionId: string;
  exchangeId: string;
  executionId: string;
  clientOrderId: string;
  side: "long" | "short";
  action: "open" | "close" | "rescue";
  orderType: "market" | "limit_ioc";
  price: number;
  signedQty: number;
  fee: number;
  exchangeOrderId?: string;
  status: "pending" | "filled" | "partial" | "failed";
  executedAt?: Date;
}

export async function recordTradeAndAggregate(ctx: ExecutorContext, args: RecordTradeArgs) {
  await ctx.store.transaction(async (tx) => {
    await tx.createTradeLog({
      positionId: args.positionId,
      exchangeId: args.exchangeId,
      executionId: args.executionId,
      clientOrderId: args.clientOrderId,
      side: args.side.toUpperCase() as any,
      action: args.action.toUpperCase() as any,
      orderType: args.orderType === "market" ? "MARKET" : "LIMIT_IOC",
      price: args.price,
      signedQty: args.signedQty,
      fee: args.fee,
      exchangeOrderId: args.exchangeOrderId,
      status: args.status.toUpperCase() as any,
      executedAt: args.executedAt,
    });

    const logs = await tx.findManyTradeLogs({ positionId: args.positionId });

    const fills: RawFill[] = logs.map((l) => ({
      side: l.side.toLowerCase() as "long" | "short",
      action: l.action.toLowerCase() as "open" | "close" | "rescue",
      signedQty: (l.signedQty as unknown as Decimal).toNumber(),
      price: (l.price as unknown as Decimal).toNumber(),
      status: l.status.toLowerCase() as "filled" | "pending" | "failed",
    }));

    const agg = computeAggregates(fills);

    await tx.updatePosition(args.positionId, {
      longSize: agg.longSize,
      longAvgEntryPrice: agg.longAvgEntry,
      shortSize: agg.shortSize,
      shortAvgEntryPrice: agg.shortAvgEntry,
    });
  });
}
