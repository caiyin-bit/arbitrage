import type { Position, TradeLog, Settlement, Opportunity, Prisma } from "@prisma/client";
import type { PositionStore } from "@/server/services/executor/types";

interface StoredExchange { id: string; name: string; }

export class InMemoryPositionStore implements PositionStore {
  private positions = new Map<string, Position>();
  private tradeLogs = new Map<string, TradeLog>();          // clientOrderId → TradeLog
  private settlements: Settlement[] = [];
  private opportunities = new Map<string, Opportunity>();
  private exchanges = new Map<string, StoredExchange>();
  private counter = 0;

  constructor(exchanges: StoredExchange[], opportunities: Opportunity[] = []) {
    for (const e of exchanges) this.exchanges.set(e.name, e);
    for (const o of opportunities) this.opportunities.set(o.id, o);
  }

  private nextId(): string {
    this.counter += 1;
    return `bt-${this.counter.toString(36)}`;
  }

  async createPosition(data: Prisma.PositionUncheckedCreateInput): Promise<Position> {
    const id = typeof data.id === "string" ? data.id : this.nextId();
    const row = { id, createdAt: new Date(), updatedAt: new Date(), ...data } as unknown as Position;
    this.positions.set(id, row);
    return row;
  }

  async updatePosition(id: string, data: Prisma.PositionUncheckedUpdateInput): Promise<Position> {
    const row = this.positions.get(id);
    if (!row) throw new Error(`no position ${id}`);
    const updated = { ...row, ...data, updatedAt: new Date() } as Position;
    this.positions.set(id, updated);
    return updated;
  }

  async findPosition(id: string): Promise<Position | null> {
    return this.positions.get(id) ?? null;
  }

  async findPositionOrThrow(
    where: Prisma.PositionWhereUniqueInput,
    _include?: Prisma.PositionInclude,
  ): Promise<Position> {
    if (typeof where.id !== "string") throw new Error("InMemoryPositionStore.findPositionOrThrow only supports { id }");
    const row = this.positions.get(where.id);
    if (!row) throw new Error(`no position ${where.id}`);
    return row;
  }

  async listOpenPositions(): Promise<Position[]> {
    return [...this.positions.values()].filter((p) => p.status === "OPEN");
  }

  async createTradeLog(data: Prisma.TradeLogUncheckedCreateInput): Promise<TradeLog> {
    const row = { id: this.nextId(), createdAt: new Date(), updatedAt: new Date(), ...data } as unknown as TradeLog;
    this.tradeLogs.set(row.clientOrderId, row);
    return row;
  }

  async updateTradeLogByClientOrderId(
    clientOrderId: string,
    data: Prisma.TradeLogUncheckedUpdateInput,
  ): Promise<TradeLog> {
    const row = this.tradeLogs.get(clientOrderId);
    if (!row) throw new Error(`no tradelog ${clientOrderId}`);
    const updated = { ...row, ...data, updatedAt: new Date() } as TradeLog;
    this.tradeLogs.set(clientOrderId, updated);
    return updated;
  }

  async findTradeLogOrThrow(where: Prisma.TradeLogWhereUniqueInput): Promise<TradeLog> {
    const id = where.clientOrderId ?? where.id;
    if (typeof id !== "string") throw new Error("InMemoryPositionStore.findTradeLogOrThrow requires clientOrderId or id");
    const byClient = this.tradeLogs.get(id);
    if (byClient) return byClient;
    const byInternal = [...this.tradeLogs.values()].find((t) => t.id === id);
    if (byInternal) return byInternal;
    throw new Error(`no tradelog matching ${JSON.stringify(where)}`);
  }

  async findManyTradeLogs(where: Prisma.TradeLogWhereInput): Promise<TradeLog[]> {
    return [...this.tradeLogs.values()].filter((t) => {
      if (where.executionId && t.executionId !== where.executionId) return false;
      if (where.positionId && t.positionId !== where.positionId) return false;
      if (where.clientOrderId && t.clientOrderId !== where.clientOrderId) return false;
      return true;
    });
  }

  async listTradeLogs(executionId: string): Promise<TradeLog[]> {
    return [...this.tradeLogs.values()].filter((t) => t.executionId === executionId);
  }

  async createSettlement(data: Prisma.SettlementUncheckedCreateInput): Promise<Settlement> {
    const row = { id: this.nextId(), createdAt: new Date(), ...data } as unknown as Settlement;
    this.settlements.push(row);
    return row;
  }

  async findExchangeByName(name: string): Promise<{ id: string; name: string } | null> {
    const row = this.exchanges.get(name);
    return row ? { id: row.id, name: row.name } : null;
  }

  async updateOpportunity(id: string, data: Prisma.OpportunityUncheckedUpdateInput): Promise<Opportunity> {
    const row = this.opportunities.get(id);
    if (!row) {
      const stub = { id, createdAt: new Date(), ...data } as unknown as Opportunity;
      this.opportunities.set(id, stub);
      return stub;
    }
    const updated = { ...row, ...data } as Opportunity;
    this.opportunities.set(id, updated);
    return updated;
  }

  async lockPositionForUpdate(_id: string): Promise<void> {
    // no-op: InMemory runs in a single event loop
  }

  async transaction<T>(fn: (tx: PositionStore) => Promise<T>): Promise<T> {
    return fn(this);
  }

  // Backtest-only helpers
  allPositions(): Position[] { return [...this.positions.values()]; }
  allSettlements(): Settlement[] { return [...this.settlements]; }
  allTradeLogs(): TradeLog[] { return [...this.tradeLogs.values()]; }
}
