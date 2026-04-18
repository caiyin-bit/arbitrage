import type { PrismaClient, Position, TradeLog, Settlement, Prisma } from "@prisma/client";
import type { PositionStore } from "./types";

// Accepts either PrismaClient (prod) or TransactionClient (inside .$transaction)
type DbClient = PrismaClient | Prisma.TransactionClient;

export class PrismaPositionStore implements PositionStore {
  constructor(private readonly db: DbClient) {}

  createPosition(data: Prisma.PositionUncheckedCreateInput): Promise<Position> {
    return this.db.position.create({ data });
  }

  updatePosition(id: string, data: Prisma.PositionUncheckedUpdateInput): Promise<Position> {
    return this.db.position.update({ where: { id }, data });
  }

  findPosition(id: string): Promise<Position | null> {
    return this.db.position.findUnique({ where: { id } });
  }

  findPositionOrThrow(
    where: Prisma.PositionWhereUniqueInput,
    include?: Prisma.PositionInclude,
  ): Promise<Position> {
    return this.db.position.findUniqueOrThrow({ where, include });
  }

  listOpenPositions(): Promise<Position[]> {
    return this.db.position.findMany({ where: { status: "OPEN" } });
  }

  createTradeLog(data: Prisma.TradeLogUncheckedCreateInput): Promise<TradeLog> {
    return this.db.tradeLog.create({ data });
  }

  updateTradeLogByClientOrderId(
    clientOrderId: string,
    data: Prisma.TradeLogUncheckedUpdateInput,
  ): Promise<TradeLog> {
    return this.db.tradeLog.update({ where: { clientOrderId }, data });
  }

  findTradeLogOrThrow(where: Prisma.TradeLogWhereUniqueInput): Promise<TradeLog> {
    return this.db.tradeLog.findUniqueOrThrow({ where });
  }

  findManyTradeLogs(where: Prisma.TradeLogWhereInput): Promise<TradeLog[]> {
    return this.db.tradeLog.findMany({ where });
  }

  listTradeLogs(executionId: string): Promise<TradeLog[]> {
    return this.db.tradeLog.findMany({ where: { executionId } });
  }

  createSettlement(data: Prisma.SettlementUncheckedCreateInput): Promise<Settlement> {
    return this.db.settlement.create({ data });
  }

  async findExchangeByName(name: string) {
    const row = await this.db.exchange.findFirst({
      where: { name, isEnabled: true },
      select: { id: true, name: true },
    });
    return row;
  }

  transaction<T>(fn: (tx: PositionStore) => Promise<T>): Promise<T> {
    // Only valid on the root PrismaClient — nested $transaction is not supported by Prisma.
    // If called inside an already-tx store, this will throw at runtime.
    if (!("$transaction" in this.db) || typeof (this.db as PrismaClient).$transaction !== "function") {
      throw new Error("PrismaPositionStore.transaction() called on a tx-scoped store (nested tx not supported)");
    }
    return (this.db as PrismaClient).$transaction(async (tx) => {
      const txStore = new PrismaPositionStore(tx);
      return fn(txStore);
    });
  }
}
