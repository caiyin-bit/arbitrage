# Plan 2: Trade Execution + Monitoring + Notifications

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire real trade execution (open/close/rescue), continuous position/margin monitoring, settlement tracking, volatility pause, Telegram notifications, and UI surfaces for confirming actions and viewing live state.

**Architecture:** Extend the Plan 1 monolith. New services under `src/server/services/{executor,monitor,notifier}`, new BullMQ jobs for settlement/health/volatility, new tRPC routers for executing and querying positions. **Three-layer idempotency**: caller-supplied `idempotencyKey` (Redis lock + result cache), server `execution_id` for audit, `client_order_id` per ccxt call (DB unique index). Signed-quantity aggregation over `trade_logs`. All runtime state held in PostgreSQL + Redis; no external queue beyond BullMQ.

**Tech Stack:** Existing — Next.js 16, tRPC, Prisma 6, BullMQ, ccxt, PostgreSQL, Redis. New dependency: `node-telegram-bot-api`.

**Spec:** `docs/superpowers/specs/2026-04-12-funding-rate-arbitrage-platform-design.md` (especially §5.3 execution, §14.1 idempotency/rescue, §14.5 volatility pause)

**Depends on:** Plan 1 complete (all foundations, adapters, UI shell).

**Out of scope (Plan 3):** Backtest engine, historical backfill, partition/archive jobs, CI/CD, production Docker, GitHub Actions.

---

## File Structure

```
src/
├── server/
│   ├── services/
│   │   ├── executor/
│   │   │   ├── types.ts                # ExecutionRequest, ExecutionResult, RescueReason
│   │   │   ├── id.ts                   # generateExecutionId, generateClientOrderId
│   │   │   ├── aggregate.ts            # recomputePositionAggregates(positionId)
│   │   │   ├── execute-open.ts         # openHedgedPosition() — orchestrates flow
│   │   │   ├── execute-close.ts        # closeHedgedPosition()
│   │   │   ├── rescue.ts               # rescueSingleLeg() — reverse-market-close excess/orphan
│   │   │   └── trade-recorder.ts       # writeTradeLog() — DB insert + aggregate recompute
│   │   ├── monitor/
│   │   │   ├── settlement.ts           # scanUpcomingSettlements, recordSettlementDelta
│   │   │   ├── health.ts               # checkAllPositions — margin + drift + pnl snapshot
│   │   │   └── volatility.ts           # evaluateVolatilityPause(symbol)
│   │   └── notifier/
│   │       ├── types.ts                # NotificationEvent, NotifierProvider
│   │       ├── telegram.ts             # TelegramProvider implements NotifierProvider
│   │       ├── format.ts               # renderEvent(event) → string
│   │       └── index.ts                # dispatch(event) — multi-provider entry
│   ├── api/routers/
│   │   ├── position.ts                 # NEW: list/getById/open/close + health stats
│   │   └── opportunity.ts              # EXTEND: accept/reject mutations
│   ├── jobs/
│   │   ├── queues.ts                   # EXTEND: settlement-monitor, health-check queues
│   │   ├── monitor-settlement.ts       # scheduled 5min + 15min-before-settlement
│   │   ├── check-health.ts             # scheduled 5min — margin + volatility + drift
│   │   └── handlers/
│   │       └── index.ts                # Wires job names → handlers
│   └── db/
│       └── redis-keys.ts               # Centralized Redis key helpers: pauseKey, priceKey
├── lib/
│   ├── position-math.ts                # unrealizedPnl(), marginRatio(), signedAggregation()
│   └── telegram-format.ts              # Pure formatting utils (tested)
└── components/
    ├── opportunities/
    │   └── open-position-dialog.tsx    # Modal: confirm params → call trpc.position.open
    ├── positions/
    │   ├── position-row.tsx            # Real card wired to trpc.position.list
    │   ├── close-position-dialog.tsx   # Confirm close
    │   └── settlement-history.tsx      # Expandable settlement list
    └── notifications/
        └── alert-banner.tsx            # Inline banner for rescue/drift events (reads via trpc subscription)

tests/
├── unit/
│   ├── position-math.test.ts
│   ├── aggregate.test.ts               # signed_qty aggregation correctness
│   ├── rescue-decision.test.ts         # partial-fill branch logic
│   ├── volatility.test.ts              # pause/recover state machine
│   └── telegram-format.test.ts
└── integration/
    ├── executor-open.test.ts           # mocked adapter, asserts DB state
    ├── executor-rescue.test.ts         # simulates one-leg failure
    └── settlement-record.test.ts
```

---

## Task 1: Redis key helpers + position-math utilities (TDD)

**Files:**
- Create: `src/server/db/redis-keys.ts`, `src/lib/position-math.ts`, `tests/unit/position-math.test.ts`

- [ ] **Step 1: Create `src/server/db/redis-keys.ts`**

```typescript
export const keys = {
  rate: (exchange: string, symbol: string) => `rate:${exchange}:${symbol}`,
  price: (exchange: string, symbol: string) => `price:${exchange}:${symbol}`,
  balance: (exchange: string) => `balance:${exchange}`,
  opportunityLatest: () => `opportunity:latest`,
  pause: (symbol: string) => `pause:${symbol}`,
  /** Caller-supplied idempotency key lock (prevents duplicate executions) */
  idempotencyLock: (key: string) => `idem:lock:${key}`,
  /** Cached result for an idempotency key — duplicate calls replay this */
  idempotencyResult: (key: string) => `idem:result:${key}`,
} as const;

export interface PauseState {
  paused: true;
  reason: "1h_volatility" | "24h_volatility" | "manual";
  triggeredAt: string; // ISO
  recoveryCount: number;
}
```

- [ ] **Step 2: Write failing tests `tests/unit/position-math.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import {
  weightedAveragePrice,
  unrealizedPnl,
  marginRatio,
  safetyBuffer,
} from "@/lib/position-math";

describe("weightedAveragePrice", () => {
  it("weights by signed_qty", () => {
    const fills = [
      { price: 70000, signedQty: 1 },
      { price: 70100, signedQty: 2 },
    ];
    expect(weightedAveragePrice(fills)).toBeCloseTo(70066.67, 2);
  });

  it("returns 0 for empty fills", () => {
    expect(weightedAveragePrice([])).toBe(0);
  });

  it("ignores zero-signed fills", () => {
    const fills = [
      { price: 70000, signedQty: 0 },
      { price: 71000, signedQty: 1 },
    ];
    expect(weightedAveragePrice(fills)).toBe(71000);
  });
});

describe("unrealizedPnl", () => {
  it("long side profit when mark > entry", () => {
    expect(unrealizedPnl({ side: "long", size: 1, entryPrice: 70000, markPrice: 71000 }))
      .toBe(1000);
  });

  it("short side profit when mark < entry", () => {
    expect(unrealizedPnl({ side: "short", size: 1, entryPrice: 70000, markPrice: 69000 }))
      .toBe(1000);
  });

  it("scales with size", () => {
    expect(unrealizedPnl({ side: "long", size: 2.5, entryPrice: 100, markPrice: 110 }))
      .toBe(25);
  });
});

describe("marginRatio", () => {
  it("returns equity / maintenance as ratio", () => {
    expect(marginRatio({ equity: 1000, maintenanceMargin: 400 })).toBe(2.5);
  });

  it("returns Infinity when maintenance is 0", () => {
    expect(marginRatio({ equity: 1000, maintenanceMargin: 0 })).toBe(Infinity);
  });
});

describe("safetyBuffer", () => {
  it("computes buffer as 1 - used/total", () => {
    expect(safetyBuffer({ usedMargin: 400, totalMargin: 1000 })).toBe(0.6);
  });
});
```

- [ ] **Step 3: Run to verify fail**

```bash
pnpm test tests/unit/position-math.test.ts
```

- [ ] **Step 4: Implement `src/lib/position-math.ts`**

```typescript
export interface Fill {
  price: number;
  signedQty: number;
}

export function weightedAveragePrice(fills: Fill[]): number {
  let numer = 0;
  let denom = 0;
  for (const f of fills) {
    if (f.signedQty === 0) continue;
    numer += f.price * f.signedQty;
    denom += f.signedQty;
  }
  return denom === 0 ? 0 : numer / denom;
}

export function unrealizedPnl(args: {
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice: number;
}): number {
  const dir = args.side === "long" ? 1 : -1;
  return dir * (args.markPrice - args.entryPrice) * args.size;
}

export function marginRatio(args: {
  equity: number;
  maintenanceMargin: number;
}): number {
  if (args.maintenanceMargin === 0) return Infinity;
  return args.equity / args.maintenanceMargin;
}

export function safetyBuffer(args: {
  usedMargin: number;
  totalMargin: number;
}): number {
  if (args.totalMargin === 0) return 0;
  return 1 - args.usedMargin / args.totalMargin;
}
```

- [ ] **Step 5: Run to verify pass**

```bash
pnpm test tests/unit/position-math.test.ts
```

Expected: 10 passing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/position-math.ts src/server/db/redis-keys.ts tests/unit/position-math.test.ts
git commit -m "feat(plan2): position math utils + typed Redis key helpers"
```

---

## Task 2: Execution ID generation + Trade Recorder (with aggregation)

**Files:**
- Create: `src/server/services/executor/types.ts`, `src/server/services/executor/id.ts`, `src/server/services/executor/aggregate.ts`, `src/server/services/executor/trade-recorder.ts`, `tests/unit/aggregate.test.ts`

- [ ] **Step 1: Create `src/server/services/executor/types.ts`**

```typescript
import type { ExchangeName } from "@/lib/constants";

export interface OpenHedgedRequest {
  /** Caller-supplied UUID generated once per user confirmation (see idempotency protocol) */
  idempotencyKey: string;
  opportunityId: string;
  symbol: string;
  longExchange: ExchangeName;
  shortExchange: ExchangeName;
  size: number;
  leverage: number;
}

export interface CloseHedgedRequest {
  positionId: string;
  reason: "manual" | "rate_reversal" | "take_profit" | "risk_control";
}

export type RescueReason =
  | "orphan_long"        // short side failed completely
  | "orphan_short"       // long side failed completely
  | "excess_long"        // long filled more than short
  | "excess_short";

export interface ExecutionResult {
  status: "filled" | "partial" | "rescued" | "failed";
  positionId: string;
  executionId: string;
  note?: string;
}
```

- [ ] **Step 2: Create `src/server/services/executor/id.ts`**

```typescript
import { randomUUID } from "crypto";

export function generateExecutionId(): string {
  return `exec-${randomUUID()}`;
}

export function generateClientOrderId(): string {
  // ccxt clientOrderId limits: Binance 36 chars alphanumeric, OKX 32, Bybit 36, Gate 30
  // Use a 26-char base: "ord-" + 22 hex chars from uuid
  return `ord-${randomUUID().replace(/-/g, "").slice(0, 22)}`;
}
```

- [ ] **Step 3: Write failing tests `tests/unit/aggregate.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { computeAggregates } from "@/server/services/executor/aggregate";

const f = (overrides: Partial<{
  side: "long" | "short";
  action: "open" | "close" | "rescue";
  signedQty: number;
  price: number;
  status: "filled" | "pending" | "failed";
}> = {}) => ({
  side: "long" as const,
  action: "open" as const,
  signedQty: 1,
  price: 100,
  status: "filled" as const,
  ...overrides,
});

describe("computeAggregates", () => {
  it("sums signed_qty for filled fills per side", () => {
    const result = computeAggregates([
      f({ side: "long", action: "open", signedQty: 1, price: 100 }),
      f({ side: "long", action: "open", signedQty: 1, price: 110 }),
      f({ side: "short", action: "open", signedQty: 1, price: 105 }),
    ]);
    expect(result.longSize).toBe(2);
    expect(result.longAvgEntry).toBe(105);
    expect(result.shortSize).toBe(1);
    expect(result.shortAvgEntry).toBe(105);
  });

  it("rescue reduces net size", () => {
    const result = computeAggregates([
      f({ side: "long", action: "open", signedQty: 1, price: 100 }),
      f({ side: "long", action: "rescue", signedQty: -0.3, price: 101 }),
    ]);
    expect(result.longSize).toBeCloseTo(0.7);
    // entry avg uses only open actions
    expect(result.longAvgEntry).toBe(100);
  });

  it("close reduces net size and does not affect entry avg", () => {
    const result = computeAggregates([
      f({ side: "long", action: "open", signedQty: 2, price: 100 }),
      f({ side: "long", action: "close", signedQty: -2, price: 120 }),
    ]);
    expect(result.longSize).toBe(0);
    expect(result.longAvgEntry).toBe(100);
  });

  it("ignores non-filled fills", () => {
    const result = computeAggregates([
      f({ side: "long", action: "open", signedQty: 1, status: "failed" }),
      f({ side: "long", action: "open", signedQty: 1, status: "pending" }),
      f({ side: "long", action: "open", signedQty: 1, status: "filled", price: 100 }),
    ]);
    expect(result.longSize).toBe(1);
    expect(result.longAvgEntry).toBe(100);
  });

  it("returns zeros for empty array", () => {
    const result = computeAggregates([]);
    expect(result).toEqual({
      longSize: 0,
      longAvgEntry: 0,
      shortSize: 0,
      shortAvgEntry: 0,
    });
  });
});
```

- [ ] **Step 4: Run to verify fail**

```bash
pnpm test tests/unit/aggregate.test.ts
```

- [ ] **Step 5: Implement `src/server/services/executor/aggregate.ts`**

```typescript
export interface RawFill {
  side: "long" | "short";
  action: "open" | "close" | "rescue";
  signedQty: number;
  price: number;
  status: "filled" | "pending" | "failed";
}

export interface Aggregates {
  longSize: number;
  longAvgEntry: number;
  shortSize: number;
  shortAvgEntry: number;
}

export function computeAggregates(fills: RawFill[]): Aggregates {
  const filled = fills.filter((f) => f.status === "filled");

  const longAll = filled.filter((f) => f.side === "long");
  const shortAll = filled.filter((f) => f.side === "short");

  const sum = (rows: RawFill[]) => rows.reduce((a, b) => a + b.signedQty, 0);

  const wavg = (rows: RawFill[]) => {
    const opens = rows.filter((r) => r.action === "open");
    const denom = opens.reduce((a, b) => a + b.signedQty, 0);
    if (denom === 0) return 0;
    const numer = opens.reduce((a, b) => a + b.price * b.signedQty, 0);
    return numer / denom;
  };

  return {
    longSize: sum(longAll),
    longAvgEntry: wavg(longAll),
    shortSize: sum(shortAll),
    shortAvgEntry: wavg(shortAll),
  };
}
```

- [ ] **Step 6: Run to verify pass**

```bash
pnpm test tests/unit/aggregate.test.ts
```

- [ ] **Step 7: Implement `src/server/services/executor/trade-recorder.ts`**

```typescript
import { prisma } from "@/server/db/client";
import { computeAggregates, type RawFill } from "./aggregate";
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

export async function recordTradeAndAggregate(args: RecordTradeArgs) {
  await prisma.$transaction(async (tx) => {
    await tx.tradeLog.create({
      data: {
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
      },
    });

    const logs = await tx.tradeLog.findMany({
      where: { positionId: args.positionId },
    });

    const fills: RawFill[] = logs.map((l) => ({
      side: l.side.toLowerCase() as "long" | "short",
      action: l.action.toLowerCase() as "open" | "close" | "rescue",
      signedQty: (l.signedQty as unknown as Decimal).toNumber(),
      price: (l.price as unknown as Decimal).toNumber(),
      status: l.status.toLowerCase() as "filled" | "pending" | "failed",
    }));

    const agg = computeAggregates(fills);

    await tx.position.update({
      where: { id: args.positionId },
      data: {
        longSize: agg.longSize,
        longAvgEntryPrice: agg.longAvgEntry,
        shortSize: agg.shortSize,
        shortAvgEntryPrice: agg.shortAvgEntry,
      },
    });
  });
}
```

- [ ] **Step 8: Commit**

```bash
git add src/server/services/executor/ tests/unit/aggregate.test.ts
git commit -m "feat(plan2): trade recorder with signed-qty aggregation and idempotent IDs"
```

---

## Task 3: Rescue decision logic (TDD)

**Files:**
- Create: `src/server/services/executor/rescue.ts`, `tests/unit/rescue-decision.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { decideRescueStrategy } from "@/server/services/executor/rescue";

describe("decideRescueStrategy", () => {
  it("returns both_filled when sizes match", () => {
    expect(decideRescueStrategy({ longFilled: 1, shortFilled: 1 })).toEqual({
      kind: "both_filled",
    });
  });

  it("returns both_failed when nothing filled", () => {
    expect(decideRescueStrategy({ longFilled: 0, shortFilled: 0 })).toEqual({
      kind: "both_failed",
    });
  });

  it("returns orphan rescue when one side is zero", () => {
    expect(decideRescueStrategy({ longFilled: 1, shortFilled: 0 })).toEqual({
      kind: "rescue_orphan",
      side: "long",
      qty: 1,
    });
    expect(decideRescueStrategy({ longFilled: 0, shortFilled: 2 })).toEqual({
      kind: "rescue_orphan",
      side: "short",
      qty: 2,
    });
  });

  it("uses reduce branch when excess < 10% of matched", () => {
    // long=1.05, short=1.0, matched=1.0, excess=0.05 → 5% < 10% → reduce long by 0.05
    expect(decideRescueStrategy({ longFilled: 1.05, shortFilled: 1 })).toEqual({
      kind: "rescue_excess",
      side: "long",
      qty: 0.05,
    });
  });

  it("uses top-up branch when excess >= 10% of matched", () => {
    // long=1.2, short=1.0 → excess 20% → top up short by 0.2
    expect(decideRescueStrategy({ longFilled: 1.2, shortFilled: 1 })).toEqual({
      kind: "topup",
      side: "short",
      qty: 0.2,
    });
  });
});
```

- [ ] **Step 2: Implement `src/server/services/executor/rescue.ts`**

```typescript
export type RescuePlan =
  | { kind: "both_filled" }
  | { kind: "both_failed" }
  | { kind: "rescue_orphan"; side: "long" | "short"; qty: number }
  | { kind: "rescue_excess"; side: "long" | "short"; qty: number }
  | { kind: "topup"; side: "long" | "short"; qty: number };

const EXCESS_THRESHOLD = 0.1;

export function decideRescueStrategy(args: {
  longFilled: number;
  shortFilled: number;
}): RescuePlan {
  const { longFilled, shortFilled } = args;

  if (longFilled === 0 && shortFilled === 0) return { kind: "both_failed" };
  if (longFilled === shortFilled) return { kind: "both_filled" };

  if (longFilled === 0) {
    return { kind: "rescue_orphan", side: "short", qty: shortFilled };
  }
  if (shortFilled === 0) {
    return { kind: "rescue_orphan", side: "long", qty: longFilled };
  }

  const matched = Math.min(longFilled, shortFilled);
  const excessSide = longFilled > shortFilled ? "long" : "short";
  const excessQty = Math.abs(longFilled - shortFilled);
  const ratio = excessQty / matched;

  if (ratio < EXCESS_THRESHOLD) {
    return { kind: "rescue_excess", side: excessSide, qty: excessQty };
  }
  return {
    kind: "topup",
    side: excessSide === "long" ? "short" : "long",
    qty: excessQty,
  };
}
```

- [ ] **Step 3: Verify pass**

```bash
pnpm test tests/unit/rescue-decision.test.ts
```

Expected: 6 passing.

- [ ] **Step 4: Commit**

```bash
git add src/server/services/executor/rescue.ts tests/unit/rescue-decision.test.ts
git commit -m "feat(plan2): rescue strategy decision logic for partial fills"
```

---

## Task 4: Execute Open Hedged Position

**Files:**
- Create: `src/server/services/executor/execute-open.ts`, `src/server/services/executor/reconcile.ts`, `tests/integration/executor-open.test.ts`

### Idempotency & crash-safety protocol

**Critical:** The executor must survive network timeouts, process crashes, and duplicate retries without ever double-ordering. Rules:

1. **Caller supplies the idempotency key.** `openHedgedPosition(req)` requires `req.idempotencyKey` — a client-provided string (UUID, "confirm button click id", or hash of a user form submission). The tRPC router generates it per button press and includes it in the mutation input. **The server never mints idempotency keys internally** — doing so defeats the purpose of the lock.
2. **Redis lock on the idempotency key** (`idem:lock:{key}`, 60s TTL) is taken at function entry. If a duplicate call arrives with the same `idempotencyKey`, the server returns the first call's cached result (read from `idem:result:{key}`, 5min TTL) instead of starting a new flow.
3. **Pre-persist before send.** Before calling `adapter.openPosition()`, write a `PENDING` trade_log row with `client_order_id`. The DB unique index on `client_order_id` is the second dedup gate (covers crashes during the Redis-lock window).
4. **Handle three outcomes per leg:**
   - Fulfilled → reconcile updates the pending row to FILLED/PARTIAL/FAILED by clientOrderId
   - Rejected (any error) → `reconcileOrder()` queries the exchange for the real state using `clientOrderId` and applies the result
   - Reconcile also fails → leave row as PENDING, schedule a BullMQ `reconcile-retry` job, bail out without running rescue. The retry job later calls `reconcileOrder()` and, if it resolves terminal, kicks off `executeRescue`.
5. **Rescue only after both legs have terminal state.** If either leg is still PENDING post-reconcile, the orchestrator MUST NOT proceed to rescue; a half-ordered position is safer than re-sending.
6. **Reconcile is the only path that transitions PENDING → FILLED/FAILED.** Never write FILLED directly from the adapter response. The `client_order_id` unique constraint guarantees exactly-once semantics.

Schema note: Plan 1 already declared `clientOrderId` as `@unique` on `TradeLog` — that index is load-bearing here.

### tRPC-level idempotency key generation

The UI generates the idempotency key once when the user opens the confirmation dialog, and re-uses it on every confirmation click. If the user rage-clicks the Confirm button three times, all three tRPC mutations carry the same key — the server dedupes via the Redis lock.

```typescript
// In open-position-dialog.tsx
const [idempotencyKey] = useState(() => crypto.randomUUID());
// Pass into the mutation payload
```

The tRPC schema for `position.open` requires `idempotencyKey: z.string().uuid()`.

- [ ] **Step 1: Implement `src/server/services/executor/reconcile.ts`**

```typescript
import { prisma } from "@/server/db/client";
import type { ExchangeAdapter } from "@/server/services/exchange/types";
import { computeAggregates, type RawFill } from "./aggregate";
import type { Decimal } from "@prisma/client/runtime/library";

/**
 * Query the exchange for a specific clientOrderId and reconcile the DB state.
 * Idempotent — safe to call multiple times. The clientOrderId unique constraint
 * and the explicit status check guarantee exactly-once transitions.
 */
export async function reconcileOrder(args: {
  clientOrderId: string;
  adapter: ExchangeAdapter;
}): Promise<"filled" | "partial" | "failed" | "pending"> {
  const row = await prisma.tradeLog.findUniqueOrThrow({
    where: { clientOrderId: args.clientOrderId },
  });

  // Terminal states — nothing to do
  if (row.status === "FILLED" || row.status === "FAILED") {
    return row.status.toLowerCase() as "filled" | "failed";
  }

  let order;
  try {
    // Most ccxt exchanges support fetchOrder by clientOrderId via params
    order = await args.adapter.getOrder(args.clientOrderId);
  } catch {
    // Exchange doesn't know the order → treat as failed (the request never landed)
    // But: only mark failed if we've retried at least once. First call returns pending.
    return "pending";
  }

  if (!order) return "pending";

  const filled = order.filledSize ?? 0;
  const amount = row.signedQty ? Math.abs((row.signedQty as unknown as Decimal).toNumber()) : 0;

  let newStatus: "FILLED" | "PARTIAL" | "FAILED";
  if (filled === 0) newStatus = "FAILED";
  else if (amount > 0 && filled < amount) newStatus = "PARTIAL";
  else newStatus = "FILLED";

  await prisma.$transaction(async (tx) => {
    await tx.tradeLog.update({
      where: { clientOrderId: args.clientOrderId },
      data: {
        status: newStatus,
        price: order.price,
        signedQty: row.action === "OPEN" ? filled : -filled,
        fee: order.fee,
        exchangeOrderId: order.id,
        executedAt: new Date(),
      },
    });

    // Re-aggregate the parent position
    const logs = await tx.tradeLog.findMany({
      where: { positionId: row.positionId },
    });

    const fills: RawFill[] = logs.map((l) => ({
      side: l.side.toLowerCase() as "long" | "short",
      action: l.action.toLowerCase() as "open" | "close" | "rescue",
      signedQty: (l.signedQty as unknown as Decimal).toNumber(),
      price: (l.price as unknown as Decimal).toNumber(),
      status: l.status.toLowerCase() as "filled" | "pending" | "failed",
    }));

    const agg = computeAggregates(fills);

    await tx.position.update({
      where: { id: row.positionId },
      data: {
        longSize: agg.longSize,
        longAvgEntryPrice: agg.longAvgEntry,
        shortSize: agg.shortSize,
        shortAvgEntryPrice: agg.shortAvgEntry,
      },
    });
  });

  return newStatus.toLowerCase() as "filled" | "partial" | "failed";
}
```

- [ ] **Step 2: Implement `src/server/services/executor/execute-open.ts`**

```typescript
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
const RESULT_TTL_SECONDS = 300; // 5 minutes — long enough for UI retries after success

export async function openHedgedPosition(
  req: OpenHedgedRequest,
): Promise<ExecutionResult> {
  // 0. Caller-supplied idempotency key is the ONLY dedup handle that survives
  //    across process restarts and duplicate network retries. The server must
  //    never generate it internally.
  const idempotencyKey = req.idempotencyKey;
  if (!idempotencyKey) {
    throw new Error("idempotencyKey is required");
  }

  // 0a. If a previous call with this key already returned a result, replay it.
  const resultKey = keys.idempotencyResult(idempotencyKey);
  const cached = await redis.get(resultKey);
  if (cached) {
    return JSON.parse(cached) as ExecutionResult;
  }

  // 0b. Acquire the lock. A concurrent duplicate is rejected with a clear error;
  //     the caller should poll the result key or retry.
  const lockKey = keys.idempotencyLock(idempotencyKey);
  const acquired = await redis.set(lockKey, "1", "EX", LOCK_TTL_SECONDS, "NX");
  if (!acquired) {
    throw new Error(`Duplicate request in flight for key ${idempotencyKey}`);
  }

  // Each distinct user confirmation gets its own execution_id for audit traceability.
  // This is a server-side ID stored in trade_logs — it does NOT participate in dedup.
  const executionId = generateExecutionId();

  let finalResult: ExecutionResult;
  try {
    // 1. Load exchange configs
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

    // 2. Create shell Position row (status=OPENING)
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

    // 3. **Pre-persist both trade_logs as PENDING before sending any orders**
    //    The unique index on clientOrderId is our dedup gate if the process crashes
    //    and a caller retries with the same IDs.
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
          signedQty: req.size, // target, signed_qty will be overwritten on reconcile
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

    // 4. Fire the concurrent orders. Each branch goes through reconcile() — never
    //    writes FILLED directly from the adapter's response. This unifies the
    //    success and reject paths.
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

    // 5. Re-read the trade_logs to find out the true terminal state
    const logs = await prisma.tradeLog.findMany({
      where: { executionId },
    });

    const longLog = logs.find((l) => l.clientOrderId === longClientId)!;
    const shortLog = logs.find((l) => l.clientOrderId === shortClientId)!;

    // If either is still PENDING, we hit the "exchange unreachable" path.
    // Schedule a reconcile retry job and bail — DO NOT rescue yet.
    if (longLog.status === "PENDING" || shortLog.status === "PENDING") {
      const { reconcileRetryQueue } = await import("@/server/jobs/queues");
      await reconcileRetryQueue.add(
        "reconcile",
        {
          executionId,
          clientOrderIds: [longClientId, shortClientId].filter(
            (id, i) => [longLog, shortLog][i].status === "PENDING",
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

      // 6. Decide rescue
      const plan = decideRescueStrategy({ longFilled, shortFilled });

      if (plan.kind === "both_filled") {
        await prisma.position.update({
          where: { id: position.id },
          data: { status: "OPEN" },
        });
        finalResult = { status: "filled", positionId: position.id, executionId };
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
        // For rescue/topup cases, delegate to rescue executor in Task 5
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

    // Cache the result so duplicate calls with the same idempotencyKey replay it
    await redis.set(resultKey, JSON.stringify(finalResult), "EX", RESULT_TTL_SECONDS);
    return finalResult;
  } finally {
    // Release the lock; result cache lives longer (5 min) so retries still hit cache
    await redis.del(lockKey);
  }
}

/**
 * Submit a single open order and reconcile its DB state.
 * Never writes the trade_log directly — always goes through reconcile.
 * On any error, we call reconcileOrder() which queries the exchange by
 * clientOrderId; if even that fails, the row stays PENDING and a retry
 * job picks it up later.
 */
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

  // Always reconcile — success OR error path goes through the same query
  try {
    await reconcileOrder({ clientOrderId: args.clientOrderId, adapter: args.adapter });
  } catch (err) {
    console.error(`[executor] reconcile failed for ${args.clientOrderId}:`, err);
    // Leave as PENDING; retry queue will handle it
  }
}
```

### Reconcile retry queue

- [ ] **Step 3: Register `reconcileRetryQueue` in `src/server/jobs/queues.ts`**

```typescript
export const reconcileRetryQueue = new Queue("reconcile-retry", {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 200,
    attempts: 5,
    backoff: { type: "exponential", delay: 5000 },
  },
});
```

Add a Worker in `worker.ts` that handles the `reconcile` job:

```typescript
const reconcileWorker = new Worker(
  "reconcile-retry",
  async (job) => {
    const { executionId, clientOrderIds } = job.data as {
      executionId: string;
      clientOrderIds: string[];
    };

    const { reconcileOrder } = await import("@/server/services/executor/reconcile");
    const { createAdapter } = await import("@/server/services/exchange/factory");
    const { decrypt } = await import("@/server/services/crypto/encryption");

    for (const cid of clientOrderIds) {
      const log = await prisma.tradeLog.findUniqueOrThrow({
        where: { clientOrderId: cid },
        include: { exchange: true },
      });
      if (log.status !== "PENDING") continue;

      const adapter = createAdapter(
        log.exchange.name as any,
        decrypt(log.exchange.apiKey),
        decrypt(log.exchange.apiSecret),
        log.exchange.passphrase ? decrypt(log.exchange.passphrase) : undefined,
      );

      const result = await reconcileOrder({ clientOrderId: cid, adapter });

      // If still pending after retry, throw to trigger BullMQ backoff
      if (result === "pending") {
        throw new Error(`Still pending: ${cid}`);
      }
    }

    // After all legs terminal, re-evaluate the position and kick off rescue if needed
    const { maybeRunRescueAfterReconcile } = await import("@/server/services/executor/post-reconcile");
    await maybeRunRescueAfterReconcile(executionId);
  },
  { connection: redis, concurrency: 1 },
);
```

- [ ] **Step 4: Implement `src/server/services/executor/post-reconcile.ts`**

```typescript
import { prisma } from "@/server/db/client";
import { createAdapter } from "@/server/services/exchange/factory";
import { decrypt } from "@/server/services/crypto/encryption";
import { decideRescueStrategy } from "./rescue";
import { executeRescue } from "./rescue-execute";
import type { ExchangeName } from "@/lib/constants";
import type { Decimal } from "@prisma/client/runtime/library";

/**
 * After a reconcile retry finishes, check if the position can now complete
 * (both_filled, both_failed) or needs rescue. Runs the same decision logic
 * as execute-open, but from the post-reconcile entry point.
 */
export async function maybeRunRescueAfterReconcile(executionId: string) {
  const logs = await prisma.tradeLog.findMany({
    where: { executionId, action: "OPEN" },
    include: { position: { include: { longExchange: true, shortExchange: true } } },
  });

  if (logs.length === 0) return;
  if (logs.some((l) => l.status === "PENDING")) return; // still waiting

  const position = logs[0].position;
  if (!position || position.status !== "OPENING") return;

  const longLog = logs.find((l) => l.side === "LONG")!;
  const shortLog = logs.find((l) => l.side === "SHORT")!;

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
    return;
  }

  if (plan.kind === "both_failed") {
    await prisma.position.update({
      where: { id: position.id },
      data: { status: "CLOSED", closedAt: new Date() },
    });
    return;
  }

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

  await executeRescue({
    position,
    plan,
    executionId,
    longAdapter,
    shortAdapter,
    longExchangeId: position.longExchangeId,
    shortExchangeId: position.shortExchangeId,
    symbol: position.symbol,
  });
}
```

- [ ] **Step 5: Create `tests/integration/executor-open.test.ts`** — real DB integration test against the local Postgres container. The goal is to prove the pre-persist + reconcile + rescue flow transitions are correct.

```typescript
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import { encrypt } from "@/server/services/crypto/encryption";

// Mock the factory so we substitute a fake adapter. Encryption is REAL to catch
// schema/type mismatches.
const longAdapter = {
  name: "binance",
  openPosition: vi.fn(),
  closePosition: vi.fn(),
  getOrder: vi.fn(),
  getBalances: vi.fn(async () => []),
  getFundingRates: vi.fn(async () => []),
  getNextSettlementTime: vi.fn(),
  getPrice: vi.fn(),
  getKline: vi.fn(),
  getSymbols: vi.fn(async () => []),
  getFeeRate: vi.fn(async () => 0.0004),
  testConnection: vi.fn(async () => true),
};
const shortAdapter = { ...longAdapter, name: "okx" };

vi.mock("@/server/services/exchange/factory", () => ({
  createAdapter: vi.fn((name: string) => (name === "binance" ? longAdapter : shortAdapter)),
}));

async function resetDB() {
  await prisma.$transaction([
    prisma.tradeLog.deleteMany(),
    prisma.settlement.deleteMany(),
    prisma.position.deleteMany(),
    prisma.opportunity.deleteMany(),
    prisma.exchange.deleteMany(),
  ]);
}

async function seedExchangesAndOpportunity() {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "a".repeat(64);
  const bin = await prisma.exchange.create({
    data: {
      name: "binance",
      apiKey: encrypt("k1"),
      apiSecret: encrypt("s1"),
      isEnabled: true,
      feeRate: 0.0004,
    },
  });
  const okx = await prisma.exchange.create({
    data: {
      name: "okx",
      apiKey: encrypt("k2"),
      apiSecret: encrypt("s2"),
      passphrase: encrypt("p"),
      isEnabled: true,
      feeRate: 0.0005,
    },
  });
  const opp = await prisma.opportunity.create({
    data: {
      symbol: "BTC/USDT:USDT",
      longExchangeId: bin.id,
      shortExchangeId: okx.id,
      longRate: 0.0001,
      shortRate: 0.0003,
      rateSpread: 0.0002,
      annualizedYield: 0.2,
      suggestedSize: 1,
      status: "DETECTED",
      detectedAt: new Date(),
    },
  });
  return { bin, okx, opp };
}

describe("openHedgedPosition — full integration", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetDB();
    // Flush any leftover idempotency locks AND cached results so each test
    // starts from a clean slate. Uses the same prefixes declared in redis-keys.ts.
    const stale = await redis.keys("idem:*");
    if (stale.length > 0) await redis.del(...stale);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await redis.quit();
  });

  it("happy path: both legs fill, position status becomes OPEN", async () => {
    const { opp } = await seedExchangesAndOpportunity();

    longAdapter.openPosition.mockResolvedValue({
      id: "o1", clientOrderId: "c1", symbol: "BTC/USDT:USDT", side: "long",
      price: 70000, filledSize: 1, fee: 28, status: "filled", timestamp: new Date(),
    });
    longAdapter.getOrder.mockResolvedValue({
      id: "o1", clientOrderId: "c1", symbol: "BTC/USDT:USDT", side: "long",
      price: 70000, filledSize: 1, fee: 28, status: "filled", timestamp: new Date(),
    });
    shortAdapter.openPosition.mockResolvedValue({
      id: "o2", clientOrderId: "c2", symbol: "BTC/USDT:USDT", side: "short",
      price: 70100, filledSize: 1, fee: 35, status: "filled", timestamp: new Date(),
    });
    shortAdapter.getOrder.mockResolvedValue({
      id: "o2", clientOrderId: "c2", symbol: "BTC/USDT:USDT", side: "short",
      price: 70100, filledSize: 1, fee: 35, status: "filled", timestamp: new Date(),
    });

    const { openHedgedPosition } = await import("@/server/services/executor/execute-open");
    const result = await openHedgedPosition({
      opportunityId: opp.id,
      symbol: "BTC/USDT:USDT",
      longExchange: "binance",
      shortExchange: "okx",
      size: 1,
      leverage: 2,
    });

    expect(result.status).toBe("filled");

    const position = await prisma.position.findUniqueOrThrow({ where: { id: result.positionId } });
    expect(position.status).toBe("OPEN");
    expect(Number(position.longSize)).toBe(1);
    expect(Number(position.shortSize)).toBe(1);
    expect(Number(position.longAvgEntryPrice)).toBe(70000);
    expect(Number(position.shortAvgEntryPrice)).toBe(70100);

    const logs = await prisma.tradeLog.findMany({ where: { positionId: result.positionId } });
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.status === "FILLED")).toBe(true);
  });

  it("pre-persists PENDING rows before sending orders", async () => {
    const { opp } = await seedExchangesAndOpportunity();

    // Make both adapters hang so we can observe the DB mid-flight
    let resolveLong: (v: any) => void;
    longAdapter.openPosition.mockImplementation(
      () => new Promise((r) => { resolveLong = r; }),
    );
    shortAdapter.openPosition.mockResolvedValue({
      id: "o2", clientOrderId: "c2", symbol: "BTC/USDT:USDT", side: "short",
      price: 70000, filledSize: 1, fee: 28, status: "filled", timestamp: new Date(),
    });
    shortAdapter.getOrder.mockResolvedValue({
      id: "o2", clientOrderId: "c2", symbol: "BTC/USDT:USDT", side: "short",
      price: 70000, filledSize: 1, fee: 28, status: "filled", timestamp: new Date(),
    });

    const { openHedgedPosition } = await import("@/server/services/executor/execute-open");

    const promise = openHedgedPosition({
      opportunityId: opp.id,
      symbol: "BTC/USDT:USDT",
      longExchange: "binance",
      shortExchange: "okx",
      size: 1,
      leverage: 2,
    });

    // Poll for the pending row to appear
    let pendingLogs: any[] = [];
    for (let i = 0; i < 50; i++) {
      pendingLogs = await prisma.tradeLog.findMany({ where: { status: "PENDING" } });
      if (pendingLogs.length >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(pendingLogs.length).toBeGreaterThanOrEqual(2);

    // Now let the long leg complete and finish the flow
    longAdapter.getOrder.mockResolvedValue({
      id: "o1", clientOrderId: "c1", symbol: "BTC/USDT:USDT", side: "long",
      price: 70000, filledSize: 1, fee: 28, status: "filled", timestamp: new Date(),
    });
    resolveLong!({
      id: "o1", clientOrderId: "c1", symbol: "BTC/USDT:USDT", side: "long",
      price: 70000, filledSize: 1, fee: 28, status: "filled", timestamp: new Date(),
    });

    const result = await promise;
    expect(result.status).toBe("filled");
  });

  it("duplicate call with same idempotencyKey replays cached result without re-ordering", async () => {
    const { opp } = await seedExchangesAndOpportunity();

    longAdapter.openPosition.mockResolvedValue({
      id: "o1", clientOrderId: "c1", symbol: "BTC/USDT:USDT", side: "long",
      price: 70000, filledSize: 1, fee: 28, status: "filled", timestamp: new Date(),
    });
    longAdapter.getOrder.mockResolvedValue({
      id: "o1", clientOrderId: "c1", symbol: "BTC/USDT:USDT", side: "long",
      price: 70000, filledSize: 1, fee: 28, status: "filled", timestamp: new Date(),
    });
    shortAdapter.openPosition.mockResolvedValue({
      id: "o2", clientOrderId: "c2", symbol: "BTC/USDT:USDT", side: "short",
      price: 70000, filledSize: 1, fee: 28, status: "filled", timestamp: new Date(),
    });
    shortAdapter.getOrder.mockResolvedValue({
      id: "o2", clientOrderId: "c2", symbol: "BTC/USDT:USDT", side: "short",
      price: 70000, filledSize: 1, fee: 28, status: "filled", timestamp: new Date(),
    });

    const { openHedgedPosition } = await import("@/server/services/executor/execute-open");
    const idempotencyKey = crypto.randomUUID();
    const payload = {
      idempotencyKey,
      opportunityId: opp.id,
      symbol: "BTC/USDT:USDT",
      longExchange: "binance" as const,
      shortExchange: "okx" as const,
      size: 1,
      leverage: 2,
    };

    const first = await openHedgedPosition(payload);
    const second = await openHedgedPosition(payload);

    // Same positionId replayed from cache — not a new execution
    expect(second.positionId).toBe(first.positionId);
    expect(second.executionId).toBe(first.executionId);

    // Each adapter's openPosition was called exactly once
    expect(longAdapter.openPosition).toHaveBeenCalledTimes(1);
    expect(shortAdapter.openPosition).toHaveBeenCalledTimes(1);

    // Exactly one position row and two trade_logs — not double
    const positions = await prisma.position.findMany();
    expect(positions).toHaveLength(1);
    const logs = await prisma.tradeLog.findMany();
    expect(logs).toHaveLength(2);

    // Lock released; result still cached
    const locks = await redis.keys("idem:lock:*");
    expect(locks).toHaveLength(0);
    const resultCached = await redis.get(`idem:result:${idempotencyKey}`);
    expect(resultCached).not.toBeNull();
  });

  it("concurrent duplicate in-flight call is rejected with clear error", async () => {
    const { opp } = await seedExchangesAndOpportunity();

    // Hang the first call on the long adapter so the lock is still held
    let resolveLong: (v: any) => void;
    longAdapter.openPosition.mockImplementation(
      () => new Promise((r) => { resolveLong = r; }),
    );
    shortAdapter.openPosition.mockResolvedValue({
      id: "o2", clientOrderId: "c2", symbol: "BTC/USDT:USDT", side: "short",
      price: 70000, filledSize: 1, fee: 28, status: "filled", timestamp: new Date(),
    });

    const { openHedgedPosition } = await import("@/server/services/executor/execute-open");
    const idempotencyKey = crypto.randomUUID();
    const payload = {
      idempotencyKey,
      opportunityId: opp.id,
      symbol: "BTC/USDT:USDT",
      longExchange: "binance" as const,
      shortExchange: "okx" as const,
      size: 1,
      leverage: 2,
    };

    const first = openHedgedPosition(payload);

    // Wait for lock to be acquired
    await new Promise((r) => setTimeout(r, 50));

    // Concurrent duplicate with the same key must reject
    await expect(openHedgedPosition(payload)).rejects.toThrow(/Duplicate request/);

    // Release the first call
    longAdapter.getOrder.mockResolvedValue({
      id: "o1", clientOrderId: "c1", symbol: "BTC/USDT:USDT", side: "long",
      price: 70000, filledSize: 1, fee: 28, status: "filled", timestamp: new Date(),
    });
    shortAdapter.getOrder.mockResolvedValue({
      id: "o2", clientOrderId: "c2", symbol: "BTC/USDT:USDT", side: "short",
      price: 70000, filledSize: 1, fee: 28, status: "filled", timestamp: new Date(),
    });
    resolveLong!({
      id: "o1", clientOrderId: "c1", symbol: "BTC/USDT:USDT", side: "long",
      price: 70000, filledSize: 1, fee: 28, status: "filled", timestamp: new Date(),
    });

    await first;
  });
});
```

A matching `executor-rescue.test.ts` (Task 12) asserts:
- When `longAdapter.openPosition` resolves with `filledSize: 1` and `shortAdapter.openPosition` rejects, followed by `shortAdapter.getOrder` also rejecting: the short trade_log stays PENDING, a reconcile retry is queued, and the position is NOT closed.
- When the short adapter `getOrder` later returns `filledSize: 0`, `maybeRunRescueAfterReconcile` transitions the orphan to rescue path, writes a negative-signedQty rescue log on the long leg, sets position.status to `CLOSED`, and sets `opportunity.cooldownUntil`.

- [ ] **Step 6: Commit**

```bash
git add src/server/services/executor/execute-open.ts tests/integration/executor-open.test.ts
git commit -m "feat(plan2): execute-open orchestrator with concurrent IOC orders"
```

---

## Task 5: Rescue Executor (partial/orphan handling)

**Files:**
- Create: `src/server/services/executor/rescue-execute.ts`

- [ ] **Step 1: Implement `src/server/services/executor/rescue-execute.ts`**

```typescript
import { prisma } from "@/server/db/client";
import type { ExchangeAdapter } from "@/server/services/exchange/types";
import type { Position } from "@prisma/client";
import { generateClientOrderId } from "./id";
import { recordTradeAndAggregate } from "./trade-recorder";
import type { RescuePlan } from "./rescue";
import type { ExecutionResult } from "./types";

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
    // Market top-up the short side
    const adapter = plan.side === "long" ? longAdapter : shortAdapter;
    const exchangeId = plan.side === "long" ? longExchangeId : shortExchangeId;
    const clientOrderId = generateClientOrderId();

    const order = await adapter.openPosition({
      symbol,
      side: plan.side,
      size: plan.qty,
      leverage: 1, // keep same as initial; refine later
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

  // Update position status
  const updated = await prisma.position.findUniqueOrThrow({
    where: { id: position.id },
  });

  const longNet = (updated.longSize as unknown as number) ?? 0;
  const shortNet = (updated.shortSize as unknown as number) ?? 0;

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

  // Cool down the opportunity to avoid retrigger
  await prisma.opportunity.update({
    where: { id: position.opportunityId },
    data: {
      cooldownUntil: new Date(Date.now() + OPPORTUNITY_COOLDOWN_MS),
    },
  });

  return {
    status: newStatus === "OPEN" ? "filled" : "rescued",
    positionId: position.id,
    executionId,
    note,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/services/executor/rescue-execute.ts
git commit -m "feat(plan2): rescue executor — reverse-market close or top-up"
```

---

## Task 6: Execute Close Hedged Position

**Files:**
- Create: `src/server/services/executor/execute-close.ts`

- [ ] **Step 1: Implement**

```typescript
import { prisma } from "@/server/db/client";
import { createAdapter } from "@/server/services/exchange/factory";
import { decrypt } from "@/server/services/crypto/encryption";
import { generateExecutionId, generateClientOrderId } from "./id";
import { recordTradeAndAggregate } from "./trade-recorder";
import type { CloseHedgedRequest, ExecutionResult } from "./types";
import type { ExchangeName } from "@/lib/constants";
import type { Decimal } from "@prisma/client/runtime/library";

export async function closeHedgedPosition(
  req: CloseHedgedRequest,
): Promise<ExecutionResult> {
  const executionId = generateExecutionId();

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

  const [longResult, shortResult] = await Promise.allSettled([
    longSize > 0
      ? longAdapter.closePosition({
          symbol: position.symbol,
          side: "long",
          size: longSize,
          clientOrderId: longClientId,
        })
      : Promise.resolve(null),
    shortSize > 0
      ? shortAdapter.closePosition({
          symbol: position.symbol,
          side: "short",
          size: shortSize,
          clientOrderId: shortClientId,
        })
      : Promise.resolve(null),
  ]);

  if (longResult.status === "fulfilled" && longResult.value) {
    await recordTradeAndAggregate({
      positionId: position.id,
      exchangeId: position.longExchangeId,
      executionId,
      clientOrderId: longClientId,
      side: "long",
      action: "close",
      orderType: "market",
      price: longResult.value.price,
      signedQty: -longResult.value.filledSize,
      fee: longResult.value.fee,
      exchangeOrderId: longResult.value.id,
      status: "filled",
      executedAt: new Date(),
    });
  }
  if (shortResult.status === "fulfilled" && shortResult.value) {
    await recordTradeAndAggregate({
      positionId: position.id,
      exchangeId: position.shortExchangeId,
      executionId,
      clientOrderId: shortClientId,
      side: "short",
      action: "close",
      orderType: "market",
      price: shortResult.value.price,
      signedQty: -shortResult.value.filledSize,
      fee: shortResult.value.fee,
      exchangeOrderId: shortResult.value.id,
      status: "filled",
      executedAt: new Date(),
    });
  }

  await prisma.position.update({
    where: { id: position.id },
    data: {
      status: "CLOSED",
      closeReason: req.reason.toUpperCase() as any,
      closedAt: new Date(),
    },
  });

  return {
    status: "filled",
    positionId: position.id,
    executionId,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/services/executor/execute-close.ts
git commit -m "feat(plan2): execute-close orchestrator for hedged positions"
```

---

## Task 7: Volatility Pause state machine (TDD)

**Files:**
- Create: `src/server/services/monitor/volatility.ts`, `tests/unit/volatility.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi } from "vitest";
import { nextPauseState } from "@/server/services/monitor/volatility";

describe("nextPauseState", () => {
  it("triggers pause when 1h change exceeds threshold", () => {
    const next = nextPauseState({
      current: null,
      priceChange1h: 0.06,
      priceChange24h: 0.05,
      threshold1h: 0.05,
      threshold24h: 0.15,
    });
    expect(next).toEqual(expect.objectContaining({ paused: true, reason: "1h_volatility", recoveryCount: 0 }));
  });

  it("triggers pause when 24h change exceeds threshold", () => {
    const next = nextPauseState({
      current: null,
      priceChange1h: 0.02,
      priceChange24h: 0.2,
      threshold1h: 0.05,
      threshold24h: 0.15,
    });
    expect(next?.reason).toBe("24h_volatility");
  });

  it("stays unpaused when both below threshold", () => {
    const next = nextPauseState({
      current: null,
      priceChange1h: 0.02,
      priceChange24h: 0.05,
      threshold1h: 0.05,
      threshold24h: 0.15,
    });
    expect(next).toBeNull();
  });

  it("increments recoveryCount when paused and under recovery threshold", () => {
    const current = { paused: true as const, reason: "1h_volatility" as const, triggeredAt: new Date().toISOString(), recoveryCount: 1 };
    const next = nextPauseState({
      current,
      priceChange1h: 0.02, // under 3% (5% * 0.6)
      priceChange24h: 0.05,
      threshold1h: 0.05,
      threshold24h: 0.15,
    });
    expect(next?.recoveryCount).toBe(2);
  });

  it("clears pause after 3 consecutive under-threshold checks", () => {
    const current = { paused: true as const, reason: "1h_volatility" as const, triggeredAt: new Date().toISOString(), recoveryCount: 2 };
    const next = nextPauseState({
      current,
      priceChange1h: 0.01,
      priceChange24h: 0.05,
      threshold1h: 0.05,
      threshold24h: 0.15,
    });
    expect(next).toBeNull();
  });

  it("resets recoveryCount when paused and breach recurs", () => {
    const current = { paused: true as const, reason: "1h_volatility" as const, triggeredAt: new Date().toISOString(), recoveryCount: 2 };
    const next = nextPauseState({
      current,
      priceChange1h: 0.07,
      priceChange24h: 0.05,
      threshold1h: 0.05,
      threshold24h: 0.15,
    });
    expect(next?.recoveryCount).toBe(0);
  });
});
```

- [ ] **Step 2: Implement `src/server/services/monitor/volatility.ts`**

```typescript
import type { PauseState } from "@/server/db/redis-keys";

interface Args {
  current: PauseState | null;
  priceChange1h: number;
  priceChange24h: number;
  threshold1h: number;
  threshold24h: number;
}

const RECOVERY_RATIO = 0.6;
const RECOVERY_REQUIRED = 3;

export function nextPauseState(args: Args): PauseState | null {
  const abs1h = Math.abs(args.priceChange1h);
  const abs24h = Math.abs(args.priceChange24h);
  const breached1h = abs1h > args.threshold1h;
  const breached24h = abs24h > args.threshold24h;

  if (!args.current) {
    if (breached1h) {
      return {
        paused: true,
        reason: "1h_volatility",
        triggeredAt: new Date().toISOString(),
        recoveryCount: 0,
      };
    }
    if (breached24h) {
      return {
        paused: true,
        reason: "24h_volatility",
        triggeredAt: new Date().toISOString(),
        recoveryCount: 0,
      };
    }
    return null;
  }

  // Already paused
  if (breached1h || breached24h) {
    return { ...args.current, recoveryCount: 0 };
  }

  const recoveryThreshold1h = args.threshold1h * RECOVERY_RATIO;
  const recoveryThreshold24h = args.threshold24h * RECOVERY_RATIO;

  if (abs1h < recoveryThreshold1h && abs24h < recoveryThreshold24h) {
    const newCount = args.current.recoveryCount + 1;
    if (newCount >= RECOVERY_REQUIRED) return null; // clear pause
    return { ...args.current, recoveryCount: newCount };
  }

  // Between breach and recovery — hold state
  return args.current;
}
```

- [ ] **Step 3: Verify pass**

```bash
pnpm test tests/unit/volatility.test.ts
```

Expected: 6 passing.

- [ ] **Step 4: Commit**

```bash
git add src/server/services/monitor/volatility.ts tests/unit/volatility.test.ts
git commit -m "feat(plan2): volatility pause state machine with recovery counter"
```

---

## Task 8: Health Check job (margin + volatility + drift)

**Files:**
- Create: `src/server/services/monitor/health.ts`, `src/server/jobs/check-health.ts`
- Modify: `src/server/jobs/queues.ts`, `src/server/jobs/worker.ts`

### Monitoring scope rules

The health check monitors **every symbol with a live position** plus a configured baseline watchlist. Price data is pulled from a **per-symbol designated price source** with a fallback chain — never hardcoded to the first exchange.

Rules:
1. **Monitored set** = `DISTINCT(positions.symbol WHERE status IN ('OPEN','RESCUE','OPENING'))` ∪ `settings.monitored_symbols` (JSON array, seeded with ~5 defaults but user-editable).
2. **Price source priority** per symbol: Binance → OKX → Bybit → Gate.io. Whichever is enabled first and successfully returns 2 klines wins. If all fail the symbol is skipped with a log line, not silently dropped.
3. **Pause key scope** is per-symbol (shared across all exchanges since funding rates correlate globally) — this matches the existing `pause:{symbol}` key design.

- [ ] **Step 0: Extend the seed to include `monitored_symbols` setting**

Add to `src/server/db/seed.ts` DEFAULT_SETTINGS:

```typescript
{
  key: "monitored_symbols",
  value: ["BTC/USDT:USDT", "ETH/USDT:USDT", "SOL/USDT:USDT", "BNB/USDT:USDT", "XRP/USDT:USDT"],
  description: "Baseline list of symbols monitored for volatility pause",
},
```

- [ ] **Step 1: Implement `src/server/services/monitor/health.ts`**

```typescript
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import { keys, type PauseState } from "@/server/db/redis-keys";
import { createAdapter } from "@/server/services/exchange/factory";
import { decrypt } from "@/server/services/crypto/encryption";
import { nextPauseState } from "./volatility";
import type { ExchangeAdapter } from "@/server/services/exchange/types";
import type { ExchangeName } from "@/lib/constants";
import type { OHLCV } from "@/lib/types";

// Source priority order — higher reliability / more markets first
const PRICE_SOURCE_PRIORITY: ExchangeName[] = ["binance", "okx", "bybit", "gateio"];

async function buildMonitoredSymbols(): Promise<string[]> {
  const [openPositions, baselineSetting] = await Promise.all([
    prisma.position.findMany({
      where: { status: { in: ["OPENING", "OPEN", "RESCUE"] } },
      select: { symbol: true },
      distinct: ["symbol"],
    }),
    prisma.setting.findUnique({ where: { key: "monitored_symbols" } }),
  ]);

  const baseline = (baselineSetting?.value as string[] | undefined) ?? [];
  const set = new Set<string>([...baseline, ...openPositions.map((p) => p.symbol)]);
  return Array.from(set);
}

async function getOrderedPriceSources(): Promise<ExchangeAdapter[]> {
  const enabled = await prisma.exchange.findMany({ where: { isEnabled: true } });
  const byName = new Map(enabled.map((e) => [e.name, e]));
  const adapters: ExchangeAdapter[] = [];
  for (const name of PRICE_SOURCE_PRIORITY) {
    const ex = byName.get(name);
    if (!ex) continue;
    adapters.push(
      createAdapter(
        ex.name as ExchangeName,
        decrypt(ex.apiKey),
        decrypt(ex.apiSecret),
        ex.passphrase ? decrypt(ex.passphrase) : undefined,
      ),
    );
  }
  return adapters;
}

async function fetchKlinesWithFallback(
  adapters: ExchangeAdapter[],
  symbol: string,
): Promise<{ kline1h: OHLCV[]; kline1d: OHLCV[]; source: string } | null> {
  for (const adapter of adapters) {
    try {
      const [kline1h, kline1d] = await Promise.all([
        adapter.getKline(symbol, "1h", 2),
        adapter.getKline(symbol, "1d", 2),
      ]);
      if (kline1h.length >= 2 && kline1d.length >= 2) {
        return { kline1h, kline1d, source: adapter.name };
      }
    } catch (err) {
      console.warn(`[health] ${symbol} failed on ${adapter.name}:`, err);
    }
  }
  return null;
}

export async function runHealthCheck() {
  const [settings, adapters, monitoredSymbols] = await Promise.all([
    prisma.setting.findMany({
      where: { key: { in: ["volatility_threshold_1h", "volatility_threshold_24h"] } },
    }),
    getOrderedPriceSources(),
    buildMonitoredSymbols(),
  ]);

  if (adapters.length === 0) {
    console.log("[health] no enabled exchanges; skipping volatility check");
    return;
  }
  if (monitoredSymbols.length === 0) {
    console.log("[health] no symbols to monitor");
    return;
  }

  const threshold1h =
    (settings.find((s) => s.key === "volatility_threshold_1h")?.value as number) ?? 0.05;
  const threshold24h =
    (settings.find((s) => s.key === "volatility_threshold_24h")?.value as number) ?? 0.15;

  for (const symbol of monitoredSymbols) {
    const result = await fetchKlinesWithFallback(adapters, symbol);
    if (!result) {
      console.warn(`[health] ${symbol} unavailable on all sources; skipped`);
      continue;
    }

    const priceChange1h =
      (result.kline1h[1].close - result.kline1h[0].close) / result.kline1h[0].close;
    const priceChange24h =
      (result.kline1d[1].close - result.kline1d[0].close) / result.kline1d[0].close;

    const currentRaw = await redis.get(keys.pause(symbol));
    const current: PauseState | null = currentRaw ? JSON.parse(currentRaw) : null;

    const next = nextPauseState({
      current,
      priceChange1h,
      priceChange24h,
      threshold1h,
      threshold24h,
    });

    if (next === null) {
      if (current) {
        await redis.del(keys.pause(symbol));
        console.log(`[health] ${symbol} volatility recovered (source=${result.source})`);
      }
    } else {
      await redis.set(keys.pause(symbol), JSON.stringify(next));
      if (!current || current.recoveryCount !== next.recoveryCount) {
        console.log(`[health] ${symbol} pause state (source=${result.source}):`, next);
      }
    }
  }

  // Position margin snapshot — iterate open positions and compare DB vs exchange.
  // Full implementation deferred: Plan 2 logs the state; Plan 3 adds drift detection
  // by calling adapter.getPositions() and comparing longSize/shortSize against DB.
  const openPositions = await prisma.position.findMany({
    where: { status: { in: ["OPEN", "RESCUE"] } },
    include: { longExchange: true, shortExchange: true },
  });
  for (const pos of openPositions) {
    console.log(`[health] Position ${pos.id} (${pos.symbol}) status=${pos.status}`);
  }
}
```

- [ ] **Step 2: Implement `src/server/jobs/check-health.ts`**

```typescript
import { runHealthCheck } from "@/server/services/monitor/health";

export async function handleCheckHealth() {
  console.log("[job] Running health check...");
  try {
    await runHealthCheck();
  } catch (err) {
    console.error("[job] Health check failed:", err);
    throw err;
  }
}
```

- [ ] **Step 3: Extend `src/server/jobs/queues.ts`** to register the new queue

```typescript
// Add alongside rateCollectionQueue
export const healthCheckQueue = new Queue("health-check", {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 100,
    attempts: 2,
  },
});

// In setupSchedulers:
const healthExisting = await healthCheckQueue.getRepeatableJobs();
for (const job of healthExisting) {
  await healthCheckQueue.removeRepeatableByKey(job.key);
}
await healthCheckQueue.add("check", {}, { repeat: { every: 300_000 } });
```

- [ ] **Step 4: Extend `src/server/jobs/worker.ts`** to handle the new queue

```typescript
// In startWorker, add second Worker instance for health-check:
const healthWorker = new Worker(
  "health-check",
  async (job) => {
    if (job.name === "check") {
      const { handleCheckHealth } = await import("./check-health");
      await handleCheckHealth();
    }
  },
  { connection: redis, concurrency: 1 },
);

healthWorker.on("completed", (job) => console.log("[health-worker] completed", job.id));
healthWorker.on("failed", (job, err) => console.error("[health-worker] failed", job?.id, err.message));

return { worker, healthWorker };
```

- [ ] **Step 5: Commit**

```bash
git add src/server/services/monitor/health.ts src/server/jobs/check-health.ts src/server/jobs/queues.ts src/server/jobs/worker.ts
git commit -m "feat(plan2): health check job with volatility pause monitoring"
```

---

## Task 9: Settlement Monitor (idempotent ingest)

**Files:**
- Create: `src/server/services/monitor/settlement.ts`, `src/server/jobs/monitor-settlement.ts`
- Modify: `src/server/jobs/queues.ts`, `src/server/jobs/worker.ts`, `src/server/services/exchange/types.ts`, `src/server/services/exchange/binance.ts` (+ okx/bybit/gateio)
- Modify: `prisma/schema.prisma` — add unique constraint for dedup

### Goal

This task delivers a **minimum viable real implementation**, not a stub. After it runs:
- Every filled funding settlement on an open position lands in the `settlements` table exactly once.
- Dedup is enforced by a DB unique constraint on `(position_id, exchange_id, side, settled_at)`.
- The job can run every minute or every hour without producing duplicates.

### Schema change

Add a unique index to `Settlement` so the ingest is truly idempotent:

```prisma
model Settlement {
  // ... existing fields ...

  @@unique([positionId, exchangeId, side, settledAt], name: "settlement_dedup")
  @@index([positionId])
  @@map("settlements")
}
```

Run `pnpm db:push` after editing `schema.prisma`.

### Exchange adapter extension

Add a new method to `ExchangeAdapter`:

```typescript
// src/server/services/exchange/types.ts
export interface FundingPayment {
  symbol: string;
  amount: number;        // positive = received, negative = paid
  fundingRate: number;
  settledAt: Date;
  exchangeSettlementId?: string;
}

export interface ExchangeAdapter {
  // ... existing methods ...

  /** Fetch recent funding payments for a symbol (used by the settlement ingest). */
  getFundingHistory(symbol: string, since: Date): Promise<FundingPayment[]>;
}
```

Implementation per adapter uses ccxt's `fetchFundingHistory` (Binance/Bybit) or `fetchLedger` with type filter (OKX/Gate.io). Example for Binance:

```typescript
async getFundingHistory(symbol: string, since: Date): Promise<FundingPayment[]> {
  const entries = await (this.client as any).fetchFundingHistory(symbol, since.getTime());
  return (entries as any[]).map((e) => ({
    symbol: e.symbol ?? symbol,
    amount: e.amount ?? 0,
    fundingRate: e.info?.fundingRate ? Number(e.info.fundingRate) : 0,
    settledAt: new Date(e.timestamp ?? Date.now()),
    exchangeSettlementId: e.id,
  }));
}
```

Each adapter wraps its exchange-specific ccxt call. If ccxt does not support `fetchFundingHistory` for a given exchange, implement with `privateGetFundingHistory` or the exchange-specific private endpoint. Any adapter that cannot yet provide this data should throw `new Error("not implemented")` and be skipped by the ingest loop (logged, not silently ignored).

- [ ] **Step 1: Add `FundingPayment` type + `getFundingHistory` method to each of the 4 adapters**

Follow the Binance example for all four. Mark unsupported exchanges clearly — the ingest will log "not implemented" and skip them until follow-up.

- [ ] **Step 2: Implement `src/server/services/monitor/settlement.ts`**

```typescript
import { prisma } from "@/server/db/client";
import { createAdapter } from "@/server/services/exchange/factory";
import { decrypt } from "@/server/services/crypto/encryption";
import { dispatch } from "@/server/services/notifier";
import type { ExchangeName } from "@/lib/constants";

const LOOKBACK_MS = 30 * 60 * 1000; // 30 min — well over the 8h settlement cadence

/**
 * For every position that is still open, ask both exchanges what funding
 * payments have occurred since the last check. Insert new rows with a
 * unique constraint that swallows duplicates.
 */
export async function scanSettlements() {
  const openPositions = await prisma.position.findMany({
    where: { status: { in: ["OPEN", "RESCUE"] } },
    include: { longExchange: true, shortExchange: true },
  });

  for (const pos of openPositions) {
    for (const side of ["long", "short"] as const) {
      const exchange = side === "long" ? pos.longExchange : pos.shortExchange;

      try {
        const adapter = createAdapter(
          exchange.name as ExchangeName,
          decrypt(exchange.apiKey),
          decrypt(exchange.apiSecret),
          exchange.passphrase ? decrypt(exchange.passphrase) : undefined,
        );

        const since = new Date(Date.now() - LOOKBACK_MS);
        const payments = await adapter.getFundingHistory(pos.symbol, since);

        for (const p of payments) {
          // Upsert by unique constraint (position_id, exchange_id, side, settled_at)
          // If a row already exists Prisma will throw P2002; we catch and skip
          try {
            await prisma.settlement.create({
              data: {
                positionId: pos.id,
                exchangeId: exchange.id,
                side: side.toUpperCase() as "LONG" | "SHORT",
                fundingRate: p.fundingRate,
                fundingAmount: p.amount,
                settledAt: p.settledAt,
              },
            });

            await dispatch({
              kind: "settlement_recorded",
              symbol: pos.symbol,
              side,
              amount: p.amount,
            });
          } catch (err: any) {
            // Unique constraint violation → already recorded, skip silently
            if (err?.code !== "P2002") throw err;
          }
        }
      } catch (err: any) {
        if (err?.message === "not implemented") {
          console.log(
            `[settlement] ${exchange.name} getFundingHistory not implemented — skipped`,
          );
          continue;
        }
        console.error(`[settlement] ${pos.symbol} ${side} on ${exchange.name}:`, err);
      }
    }
  }
}
```

- [ ] **Step 3: Implement job handler**

```typescript
// src/server/jobs/monitor-settlement.ts
import { scanSettlements } from "@/server/services/monitor/settlement";

export async function handleMonitorSettlement() {
  console.log("[job] Scanning settlements...");
  await scanSettlements();
}
```

- [ ] **Step 4: Register `settlementMonitorQueue` in `queues.ts`** and schedule every 5 minutes. Add a Worker in `worker.ts`.

- [ ] **Step 5: Write an integration test `tests/integration/settlement-record.test.ts`**

Seeds a position + exchange, mocks `getFundingHistory` to return 2 payments, calls `scanSettlements()` twice, and asserts:
- First call inserts 2 settlements
- Second call inserts 0 (idempotency via unique constraint)
- `position.settlements` relation contains exactly 2 rows with the right amounts

- [ ] **Step 6: Commit**

```bash
git add src/server/services/monitor/settlement.ts src/server/services/exchange/ src/server/jobs/monitor-settlement.ts src/server/jobs/queues.ts src/server/jobs/worker.ts prisma/schema.prisma tests/integration/settlement-record.test.ts
git commit -m "feat(plan2): settlement monitor with getFundingHistory and dedup constraint"
```

---

## Task 10: Telegram Notifier

**Files:**
- Create: `src/server/services/notifier/types.ts`, `src/server/services/notifier/format.ts`, `src/server/services/notifier/telegram.ts`, `src/server/services/notifier/index.ts`, `tests/unit/telegram-format.test.ts`
- Install: `node-telegram-bot-api` + types

- [ ] **Step 1: Install dependency**

```bash
pnpm add node-telegram-bot-api
pnpm add -D @types/node-telegram-bot-api
```

- [ ] **Step 2: Create event types `src/server/services/notifier/types.ts`**

```typescript
export type NotificationEvent =
  | { kind: "opportunity_detected"; symbol: string; annualizedYield: number; longExchange: string; shortExchange: string }
  | { kind: "position_opened"; symbol: string; size: number; executionId: string }
  | { kind: "position_closed"; symbol: string; pnl: number; reason: string }
  | { kind: "rescue_triggered"; symbol: string; side: "long" | "short"; qty: number; note: string }
  | { kind: "margin_warning"; symbol: string; exchange: string; buffer: number }
  | { kind: "volatility_pause"; symbol: string; reason: string; change: number }
  | { kind: "settlement_recorded"; symbol: string; side: "long" | "short"; amount: number };

export interface NotifierProvider {
  name: string;
  send(event: NotificationEvent): Promise<void>;
}
```

- [ ] **Step 3: Write failing test `tests/unit/telegram-format.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { formatEvent } from "@/server/services/notifier/format";

describe("formatEvent", () => {
  it("formats opportunity_detected with yield", () => {
    const msg = formatEvent({
      kind: "opportunity_detected",
      symbol: "BTC/USDT",
      annualizedYield: 0.235,
      longExchange: "okx",
      shortExchange: "binance",
    });
    expect(msg).toContain("BTC/USDT");
    expect(msg).toContain("23.50%");
    expect(msg).toContain("okx");
    expect(msg).toContain("binance");
  });

  it("formats rescue_triggered with warning emoji", () => {
    const msg = formatEvent({
      kind: "rescue_triggered",
      symbol: "ETH/USDT",
      side: "long",
      qty: 0.5,
      note: "orphan",
    });
    expect(msg).toContain("⚠️");
    expect(msg).toContain("ETH/USDT");
    expect(msg).toContain("0.5");
  });

  it("formats position_closed with pnl sign", () => {
    const profit = formatEvent({ kind: "position_closed", symbol: "SOL", pnl: 12.3, reason: "manual" });
    expect(profit).toContain("+$12.30");
    const loss = formatEvent({ kind: "position_closed", symbol: "SOL", pnl: -5, reason: "manual" });
    expect(loss).toContain("-$5.00");
  });
});
```

- [ ] **Step 4: Implement `src/server/services/notifier/format.ts`**

```typescript
import type { NotificationEvent } from "./types";

function signed(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

export function formatEvent(event: NotificationEvent): string {
  switch (event.kind) {
    case "opportunity_detected":
      return `🎯 New opportunity: ${event.symbol}\n${pct(event.annualizedYield)} APY\nLong ${event.longExchange} → Short ${event.shortExchange}`;
    case "position_opened":
      return `✅ Position opened: ${event.symbol}\nSize ${event.size}\nExec ${event.executionId}`;
    case "position_closed":
      return `🔒 Position closed: ${event.symbol}\nP&L ${signed(event.pnl)}\nReason: ${event.reason}`;
    case "rescue_triggered":
      return `⚠️ Rescue: ${event.symbol}\n${event.side} ${event.qty}\n${event.note}`;
    case "margin_warning":
      return `🚨 Margin warning: ${event.symbol} on ${event.exchange}\nBuffer ${pct(event.buffer)}`;
    case "volatility_pause":
      return `⏸ Volatility pause: ${event.symbol}\n${event.reason} — change ${pct(event.change)}`;
    case "settlement_recorded":
      return `💰 Settlement: ${event.symbol} ${event.side} ${signed(event.amount)}`;
  }
}
```

- [ ] **Step 5: Implement `src/server/services/notifier/telegram.ts`**

```typescript
import TelegramBot from "node-telegram-bot-api";
import type { NotifierProvider, NotificationEvent } from "./types";
import { formatEvent } from "./format";

export class TelegramProvider implements NotifierProvider {
  readonly name = "telegram";
  private bot: TelegramBot | null = null;
  private chatId: string | null = null;

  constructor(token: string | undefined, chatId: string | undefined) {
    if (token && chatId) {
      this.bot = new TelegramBot(token, { polling: false });
      this.chatId = chatId;
    }
  }

  async send(event: NotificationEvent) {
    if (!this.bot || !this.chatId) {
      console.log("[telegram] not configured, skipping:", event.kind);
      return;
    }
    try {
      await this.bot.sendMessage(this.chatId, formatEvent(event));
    } catch (err) {
      console.error("[telegram] send failed:", err);
    }
  }
}
```

- [ ] **Step 6: Implement dispatcher `src/server/services/notifier/index.ts`**

```typescript
import type { NotificationEvent, NotifierProvider } from "./types";
import { TelegramProvider } from "./telegram";

const providers: NotifierProvider[] = [
  new TelegramProvider(
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.TELEGRAM_CHAT_ID,
  ),
];

export async function dispatch(event: NotificationEvent) {
  await Promise.allSettled(providers.map((p) => p.send(event)));
}
```

- [ ] **Step 7: Update `.env.example`**

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

- [ ] **Step 8: Run tests**

```bash
pnpm test tests/unit/telegram-format.test.ts
```

- [ ] **Step 9: Wire dispatch() into existing hot spots**

In `src/server/jobs/collect-rates.ts`, after opportunity insert, call:

```typescript
import { dispatch } from "@/server/services/notifier";
// ...
await dispatch({
  kind: "opportunity_detected",
  symbol: opp.symbol,
  annualizedYield: opp.annualizedYield,
  longExchange: opp.longExchange,
  shortExchange: opp.shortExchange,
});
```

In `execute-open.ts` after success/rescue; in `execute-close.ts` after success; in `health.ts` when pause triggers.

- [ ] **Step 10: Commit**

```bash
git add src/server/services/notifier/ src/server/jobs/collect-rates.ts src/server/services/executor/ src/server/services/monitor/ .env.example tests/unit/telegram-format.test.ts package.json pnpm-lock.yaml
git commit -m "feat(plan2): Telegram notifier with event formatting and dispatch"
```

---

## Task 11: tRPC position router (open/close/list)

**Files:**
- Create: `src/server/api/routers/position.ts`
- Modify: `src/server/api/root.ts`, `src/server/api/routers/opportunity.ts`

- [ ] **Step 1: Create `src/server/api/routers/position.ts`**

```typescript
import { z } from "zod";
import { router, publicProcedure } from "../trpc";
import { openHedgedPosition } from "@/server/services/executor/execute-open";
import { closeHedgedPosition } from "@/server/services/executor/execute-close";
import { EXCHANGE_NAMES } from "@/lib/constants";

export const positionRouter = router({
  list: publicProcedure
    .input(
      z.object({
        status: z.enum(["OPENING", "OPEN", "CLOSING", "CLOSED", "RESCUE"]).optional(),
        limit: z.number().min(1).max(100).default(50),
      }).default(() => ({ limit: 50 })),
    )
    .query(async ({ ctx, input }) => {
      return ctx.prisma.position.findMany({
        where: input.status ? { status: input.status } : undefined,
        include: {
          longExchange: { select: { id: true, name: true } },
          shortExchange: { select: { id: true, name: true } },
          settlements: {
            orderBy: { settledAt: "desc" },
            take: 5,
          },
          _count: { select: { tradeLogs: true, settlements: true } },
        },
        orderBy: { openedAt: "desc" },
        take: input.limit,
      });
    }),

  get: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.position.findUniqueOrThrow({
        where: { id: input.id },
        include: {
          longExchange: true,
          shortExchange: true,
          settlements: { orderBy: { settledAt: "desc" } },
          tradeLogs: { orderBy: { createdAt: "asc" } },
        },
      });
    }),

  open: publicProcedure
    .input(
      z.object({
        idempotencyKey: z.string().uuid(),
        opportunityId: z.string().uuid(),
        symbol: z.string(),
        longExchange: z.enum(EXCHANGE_NAMES),
        shortExchange: z.enum(EXCHANGE_NAMES),
        size: z.number().positive(),
        leverage: z.number().min(1).max(10),
      }),
    )
    .mutation(async ({ input }) => {
      return openHedgedPosition(input);
    }),

  close: publicProcedure
    .input(
      z.object({
        idempotencyKey: z.string().uuid(),
        positionId: z.string().uuid(),
        reason: z.enum(["manual", "rate_reversal", "take_profit", "risk_control"]).default("manual"),
      }),
    )
    .mutation(async ({ input }) => {
      return closeHedgedPosition(input);
    }),
});
```

- [ ] **Step 2: Register in `src/server/api/root.ts`**

```typescript
import { positionRouter } from "./routers/position";
// ...
export const appRouter = router({
  exchange: exchangeRouter,
  opportunity: opportunityRouter,
  position: positionRouter, // NEW
  settings: settingsRouter,
  dashboard: dashboardRouter,
});
```

- [ ] **Step 3: Commit**

```bash
git add src/server/api/routers/position.ts src/server/api/root.ts
git commit -m "feat(plan2): tRPC position router — list/get/open/close"
```

---

## Task 12: Rescue + reconcile integration tests

**Files:**
- Create: `tests/integration/executor-rescue.test.ts`
- Create: `tests/integration/executor-reconcile-retry.test.ts`

**Note:** Task 4 already landed the primary happy-path integration test for `executor-open`. This task adds the two hardest paths — single-leg rescue and the reconcile retry after an unreachable exchange.

- [ ] **Step 1: Write `tests/integration/executor-rescue.test.ts`**

Seeds two exchanges + opportunity, then runs `openHedgedPosition` with mocks that make:
- `longAdapter.openPosition` return `filledSize: 1, price: 70000`
- `shortAdapter.openPosition` return `filledSize: 0` (simulated failure)
- `longAdapter.getOrder` return the filled state
- `shortAdapter.getOrder` return `filledSize: 0` (confirmed failed)
- `longAdapter.closePosition` return `filledSize: 1` (the rescue market close)

Assert:
1. Position status transitions: OPENING → CLOSED (long rescued to zero)
2. Three trade_logs exist for the execution_id: long OPEN (filled, +1), short OPEN (failed, 0), long RESCUE (filled, -1)
3. `computeAggregates` yields longSize=0, shortSize=0
4. `opportunity.cooldownUntil` is set to roughly now+30min
5. A `rescue_triggered` notification was dispatched (capture via mocked notifier)

- [ ] **Step 2: Write `tests/integration/executor-reconcile-retry.test.ts`**

Seeds exchanges + opportunity, then makes `longAdapter.openPosition` reject with a network error AND `longAdapter.getOrder` reject with the same error (the exchange is unreachable). `shortAdapter` fills normally.

Assert:
1. After `openHedgedPosition` returns, status is "failed" with note "queued for reconcile"
2. The long trade_log row remains status=PENDING
3. The short trade_log row is FILLED
4. A job has been added to `reconcileRetryQueue`

Then simulate the retry: mock `longAdapter.getOrder` to now return `filledSize: 0` (confirmed never landed). Invoke the reconcile worker's handler function directly. Assert:
1. Long trade_log transitions to FAILED
2. `maybeRunRescueAfterReconcile` is called
3. Since shortFilled=1, longFilled=0 → orphan short rescue fires
4. Short leg gets closed via market, short trade_log rescue row with -1 signed_qty
5. Position ends up CLOSED, opportunity cooldown set

- [ ] **Step 3: Run**

```bash
pnpm test tests/integration/
```

All integration tests (open happy path + pre-persist + rescue + reconcile retry + settlement) should pass.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/
git commit -m "test(plan2): integration tests for rescue and reconcile retry paths"
```

---

## Task 13: Open Position Dialog + Close Dialog UI

**Files:**
- Create: `src/components/opportunities/open-position-dialog.tsx`, `src/components/positions/close-position-dialog.tsx`

- [ ] **Step 1: Install shadcn Dialog primitive manually**

Create `src/components/ui/dialog.tsx` — minimal Radix-style dialog. If that's too heavy, use a simple overlay + card pattern.

- [ ] **Step 2: `open-position-dialog.tsx`**

```tsx
"use client";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

interface Props {
  opportunity: {
    id: string;
    symbol: string;
    longExchange: { name: string };
    shortExchange: { name: string };
    annualizedYield: number;
  };
  onClose: () => void;
}

export function OpenPositionDialog({ opportunity, onClose }: Props) {
  const [size, setSize] = useState("0.1");
  const [leverage, setLeverage] = useState(2);
  // Generated ONCE per dialog mount — rage-clicks reuse the same key,
  // which is the only thing that makes the server-side Redis lock effective.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const openMut = trpc.position.open.useMutation({
    onSuccess: (result) => {
      console.log("opened", result);
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-card border border-border rounded-xl p-6 w-[420px] flex flex-col gap-5">
        <div>
          <h3 className="text-base font-semibold">Open hedged position</h3>
          <p className="text-xs text-muted-foreground mt-1">
            {opportunity.symbol} · {opportunity.longExchange.name} → {opportunity.shortExchange.name}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Size</label>
          <input
            className="bg-muted border border-border rounded-md px-3 py-2 font-mono text-sm"
            value={size}
            onChange={(e) => setSize(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Leverage</label>
          <select
            className="bg-muted border border-border rounded-md px-3 py-2 text-sm"
            value={leverage}
            onChange={(e) => setLeverage(Number(e.target.value))}
          >
            {[1, 2, 3].map((l) => (
              <option key={l} value={l}>{l}x</option>
            ))}
          </select>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="default"
            disabled={openMut.isPending}
            onClick={() =>
              openMut.mutate({
                idempotencyKey,
                opportunityId: opportunity.id,
                symbol: opportunity.symbol,
                longExchange: opportunity.longExchange.name as any,
                shortExchange: opportunity.shortExchange.name as any,
                size: parseFloat(size),
                leverage,
              })
            }
          >
            {openMut.isPending ? "Opening..." : "Confirm"}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create similar `close-position-dialog.tsx`** with confirm text.

- [ ] **Step 4: Wire into `opportunity-card.tsx`** — replace the "Open Position" button with one that opens the dialog.

- [ ] **Step 5: Commit**

```bash
git add src/components/
git commit -m "feat(plan2): open/close position confirmation dialogs"
```

---

## Task 14: Positions page real data

**Files:**
- Modify: `src/app/(dashboard)/positions/page.tsx`
- Create: `src/components/positions/position-row.tsx`

- [ ] **Step 1: Rewrite positions page with real data**

Query `trpc.position.list` and render cards using the Pencil-style layout (reuse the PositionCard structure from mockups). Each row wires "Close Position" to open the close dialog.

Also add 4 summary stat cards at top computed from the list:
- Open count
- Total notional (sum of longSize * longAvgEntry)
- Net P&L (sum of all settlements.funding_amount per position + unrealized based on cached ticker prices)
- Worst margin (placeholder until health check populates it)

If the list is empty, keep the current empty state placeholder.

- [ ] **Step 2: Verify HMR + run tests + build**

- [ ] **Step 3: Commit**

```bash
git add src/app/\(dashboard\)/positions/ src/components/positions/
git commit -m "feat(plan2): Positions page wired to real tRPC data"
```

---

## Task 15: End-to-end sanity run

- [ ] **Step 1: Run all tests**

```bash
pnpm test
```

Expected: previous 16 + new unit/integration tests all passing.

- [ ] **Step 2: Build**

```bash
pnpm build
```

- [ ] **Step 3: Start dev server, verify pages render**

```bash
./dev.sh   # or reuse existing dev
```

Navigate to /settings → configure (if not already), /opportunities → click Open Position → dialog shows → cancel; /positions → should show empty or stub.

- [ ] **Step 4: Push**

```bash
git push
```

---

## Spec Coverage Checklist

| Spec Section | Covered By |
|---|---|
| 14.1 幂等（两层 ID） | Task 2, 4 |
| 14.1 部分成交补救 | Task 3, 5 |
| 14.1 单腿补救（rescue） | Task 5 |
| 14.5 极端行情暂停 | Task 7, 8 |
| 14.5 恢复计数器 | Task 7 |
| 五.3 结算监控 | Task 9 |
| 十三、Telegram 通知 | Task 10 |
| 六、Positions 页面 | Task 13, 14 |
| 六、Opportunities Open 弹窗 | Task 13 |
| 数据模型：trade_logs signed_qty + execution_id + client_order_id | Task 2 (used via schema from Plan 1) |
| 数据模型：positions 聚合态 | Task 2 (recordTradeAndAggregate) |

## Not in Plan 2 scope (deferred)

- Settlement ingest for any exchange whose ccxt build does not expose `fetchFundingHistory` or equivalent private ledger endpoint — those adapters throw `not implemented` and the ingest logs + skips them. Follow-up in Plan 2.x per exchange as needed.
- Exchange `getPositions` drift detection beyond logging (Plan 3 adds active reconcile)
- Margin/latency stats on ExchangeRow (needs latency probe service)
- Dashboard page real data (P&L curve, active positions, events)
- Real-time tRPC subscriptions for alerts (polling only in Plan 2)
- OpenClaw notification provider (only Telegram in Plan 2)
- Backtest engine (Plan 3)
- CI/CD + production deploy (Plan 3)
