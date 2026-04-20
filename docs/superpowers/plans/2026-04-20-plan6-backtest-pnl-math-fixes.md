# Plan 6 — 回测 P&L 数学修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Vultr 6 个月真实数据回测暴露出的 3 个 P&L 数学 bug（仓位规模语义、wAvg 被 PENDING log 污染、强平后 equityCurve 缺尾点），让回测报表的 ROI、netPnl、名义金额彼此自洽。

**Architecture:** 所有改动限定在回测 runner 内，生产 executor（production `openHedgedPosition`/`closeHedgedPosition` 及其基础币数量契约）不动。3 个修复相互独立，分 3 个 commit 落在单个 feature 分支，最终合并成单个 PR。

**Tech Stack:** TypeScript, Next.js 16, Prisma 6 (Postgres), vitest (unit + integration), Node 22, Docker Compose（本地 DB/Redis）。

**Spec:** [docs/superpowers/specs/2026-04-20-plan6-backtest-pnl-math-fixes-design.md](../specs/2026-04-20-plan6-backtest-pnl-math-fixes-design.md)

**Branch:** `feature/plan6-pnl-math`（已创建并 commit 了 spec，当前 HEAD = `3544ac7`）

---

## File Structure

| 路径 | 职责 | 本 Plan 变更 |
|-----|-----|-------------|
| `src/server/services/backtest/runner/runner.ts` | 回测主循环、开仓/平仓调度、equityCurve 组装、closedTrades 聚合 | **三次修改**：extract 并过滤 `wAvg`、强平后追加 final equity 点、开仓前 USD→base 换算 |
| `src/server/services/backtest/types.ts` | BacktestConfig / ClosedTrade / EquityCurvePoint 类型定义 | `positionSize` 字段加 JSDoc 明确 USD 语义 |
| `tests/unit/backtest/runner-close-math.test.ts` | 新增纯函数单元测试 | 为 `wAvgFilledPrice` 补 3 个用例 |
| `tests/integration/backtest/end-to-end.test.ts` | 现有回测端到端集成测试 | 新增 2 个用例覆盖 Bug 1（USD 换算）和 Bug 3（最终权益不变量）|

**合约变更：** 在 `runner.ts` 顶层导出一个新函数 `wAvgFilledPrice(logs: TradeLog[]): number`，原 `buildClosedTrades` 内闭包 `wAvg` 改为调用它。无其他对外合约变更。

---

## Pre-work: Setup 环境

- [ ] **Step 0.1: 确认分支与工作区干净**

Run: `git status && git branch --show-current`
Expected:
```
On branch feature/plan6-pnl-math
nothing added to commit but untracked files present (use "git add" to track)
Untracked files: docs/ops/
feature/plan6-pnl-math
```

`docs/ops/` 是上个 session 的 Vultr 运维笔记，不在本 Plan 范围；忽略。

- [ ] **Step 0.2: 确认 DB 和 Redis 运行中**

Run: `docker compose ps`
Expected: `postgres` 和 `redis` 服务显示 `Up`。如未启动，运行 `docker compose up -d postgres redis`。

- [ ] **Step 0.3: 跑一遍当前测试套件，建立基线**

Run: `pnpm vitest run tests/unit/backtest tests/integration/backtest`
Expected: 全部通过（或若有失败，记下来，确认 Plan 6 不会让其回归或恶化）。

---

## Task 1: Bug 2 — `wAvg` 只取 FILLED/PARTIAL log

**Files:**
- Modify: `src/server/services/backtest/runner/runner.ts:323-379`
- Create: `tests/unit/backtest/runner-close-math.test.ts`

**Why first:** 最小最独立，且 Bug 3 的不变量证明依赖 `wAvg` 返回正确均价——先修它。

---

- [ ] **Step 1.1: 写失败的单元测试**

Create file `tests/unit/backtest/runner-close-math.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { wAvgFilledPrice } from "@/server/services/backtest/runner/runner";
import type { TradeLog } from "@prisma/client";

function log(overrides: Partial<TradeLog>): TradeLog {
  return {
    id: "t1",
    positionId: "p1",
    exchangeId: "e1",
    executionId: "ex1",
    clientOrderId: "c1",
    exchangeOrderId: null,
    side: "LONG",
    action: "CLOSE",
    orderType: "MARKET",
    price: 0 as unknown as TradeLog["price"],
    signedQty: 0 as unknown as TradeLog["signedQty"],
    fee: 0 as unknown as TradeLog["fee"],
    status: "PENDING",
    executedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as TradeLog;
}

describe("wAvgFilledPrice", () => {
  it("ignores PENDING logs so a failed close leg does not zero the good leg's price", () => {
    const logs = [
      log({ id: "a", status: "FILLED", price: 100 as any, signedQty: -5 as any }),
      log({ id: "b", status: "FILLED", price: 110 as any, signedQty: -5 as any }),
      log({ id: "c", status: "PENDING", price: 0 as any, signedQty: -10 as any }),
    ];
    // Unfiltered average would be ((100*5 + 110*5 + 0*10)/20) = 52.5
    // Filtered average = ((100*5 + 110*5)/10) = 105
    expect(wAvgFilledPrice(logs)).toBe(105);
  });

  it("returns 0 when every log is PENDING or FAILED (real leg failure)", () => {
    const logs = [
      log({ id: "a", status: "PENDING", price: 0 as any, signedQty: -5 as any }),
      log({ id: "b", status: "FAILED", price: 0 as any, signedQty: -5 as any }),
    ];
    expect(wAvgFilledPrice(logs)).toBe(0);
  });

  it("treats PARTIAL as filled and averages by absolute signed quantity", () => {
    const logs = [
      log({ id: "a", status: "FILLED", price: 200 as any, signedQty: 3 as any }),
      log({ id: "b", status: "PARTIAL", price: 100 as any, signedQty: 1 as any }),
    ];
    // (200*3 + 100*1) / 4 = 175
    expect(wAvgFilledPrice(logs)).toBe(175);
  });
});
```

- [ ] **Step 1.2: 运行测试确认失败**

Run: `pnpm vitest run tests/unit/backtest/runner-close-math.test.ts`
Expected: 全部失败，报错 `wAvgFilledPrice is not exported from runner`（或 `is not a function`）。

- [ ] **Step 1.3: 在 runner.ts 里提取并导出 `wAvgFilledPrice`**

Open `src/server/services/backtest/runner/runner.ts`. 在文件顶部的 import 区域之后、`runBacktest` 函数之前插入新的导出函数：

```ts
/**
 * Weighted average of trade-log prices, restricted to FILLED/PARTIAL logs.
 *
 * PENDING/FAILED logs carry price=0 from the pre-persist step; including them
 * in the average silently zeroes out the real fill price of a sibling leg.
 * Exported so the backtest's close-math can be unit-tested in isolation.
 */
export function wAvgFilledPrice(logs: TradeLog[]): number {
  const filled = logs.filter(
    (l) => l.status === "FILLED" || l.status === "PARTIAL",
  );
  const totalQty = filled.reduce(
    (s, l) => s + Math.abs(Number(l.signedQty)),
    0,
  );
  if (totalQty === 0) return 0;
  return (
    filled.reduce(
      (s, l) => s + Number(l.price) * Math.abs(Number(l.signedQty)),
      0,
    ) / totalQty
  );
}
```

然后在 `buildClosedTrades` 函数体里把原来的闭包 `wAvg` 删掉，改用新函数。原代码 `src/server/services/backtest/runner/runner.ts:327-331` 的：

```ts
const wAvg = (ls: TradeLog[]) => {
  const totalQty = ls.reduce((s, l) => s + Math.abs(Number(l.signedQty)), 0);
  if (totalQty === 0) return 0;
  return ls.reduce((s, l) => s + Number(l.price) * Math.abs(Number(l.signedQty)), 0) / totalQty;
};
```

整段删除。然后在 `buildClosedTrades` 内部 `src/server/services/backtest/runner/runner.ts:351-354` 的 4 行替换：

```ts
const longEntry  = wAvg(buckets.OPEN_LONG);
const shortEntry = wAvg(buckets.OPEN_SHORT);
const longExit   = wAvg(buckets.CLOSE_LONG);
const shortExit  = wAvg(buckets.CLOSE_SHORT);
```

改为：

```ts
const longEntry  = wAvgFilledPrice(buckets.OPEN_LONG);
const shortEntry = wAvgFilledPrice(buckets.OPEN_SHORT);
const longExit   = wAvgFilledPrice(buckets.CLOSE_LONG);
const shortExit  = wAvgFilledPrice(buckets.CLOSE_SHORT);
```

- [ ] **Step 1.4: 加一行诊断 warning（当 exit 真的为 0）**

在 `buildClosedTrades` 函数内、`trades.push({...})` 语句之前、计算完 `longExit`/`shortExit` 之后，添加：

```ts
if (longSize > 0 && longExit === 0) {
  console.warn(
    `[bt] position ${p.id} (${p.symbol}) longExit=0: CLOSE_LONG trade logs had no FILLED/PARTIAL entry — grossPnl will be skewed by longEntry × longSize`,
  );
}
if (shortSize > 0 && shortExit === 0) {
  console.warn(
    `[bt] position ${p.id} (${p.symbol}) shortExit=0: CLOSE_SHORT trade logs had no FILLED/PARTIAL entry — grossPnl will be skewed by −shortEntry × shortSize`,
  );
}
```

这个 warning 始终开启（不由 `BACKTEST_VERBOSE` 门控），因为它表示真实的平仓失败，应当被看到。

- [ ] **Step 1.5: 运行单元测试确认通过**

Run: `pnpm vitest run tests/unit/backtest/runner-close-math.test.ts`
Expected: 3 个测试全部 PASS。

- [ ] **Step 1.6: 跑 backtest 相关的所有测试，确认没有回归**

Run: `pnpm vitest run tests/unit/backtest tests/integration/backtest`
Expected: 全部 PASS，无新失败。特别关注 `end-to-end.test.ts` 里的 `trades have real math` 用例——它验证的恒等式不依赖 wAvg 的具体过滤策略，应当不受影响。

- [ ] **Step 1.7: 提交 commit 1**

```bash
git add src/server/services/backtest/runner/runner.ts tests/unit/backtest/runner-close-math.test.ts
git commit -m "$(cat <<'EOF'
fix(backtest): wAvg ignores PENDING/FAILED trade logs

When a close leg's adapter call fails (simulated or real), the PENDING
trade log keeps price=0. The old wAvg averaged this into the exit price,
silently zeroing a sibling good-leg's real fill. Now we only average
FILLED/PARTIAL logs and explicitly warn when an exit still comes out 0.

Extracted as wAvgFilledPrice for unit testing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Run after: `git log --oneline -2` → expect the new commit on top of `3544ac7`.

---

## Task 2: Bug 3 — 强平后追加 final equity 点

**Files:**
- Modify: `src/server/services/backtest/runner/runner.ts:97-113`
- Modify: `tests/integration/backtest/end-to-end.test.ts`

---

- [ ] **Step 2.1: 写失败的集成测试**

Open `tests/integration/backtest/end-to-end.test.ts`. 在最后一个 `it(...)` 用例（`failureRate=1.0 produces zero closed trades`）之后、`describe` 块的闭括号之前，追加新用例：

```ts
  it("finalEquity - initialCapital equals sum(trades.netPnl) after force-close", async () => {
    const bin = await prisma.exchange.create({ data: { name: "binance", apiKey: "", apiSecret: "", feeRate: 0.0005 } });
    const okx = await prisma.exchange.create({ data: { name: "okx", apiKey: "", apiSecret: "", feeRate: 0.0005 } });
    const t0 = Date.UTC(2025, 0, 1);

    // Seed 72h of hourly candles — force-close triggers at config.to
    for (let h = 0; h < 72; h++) {
      for (const ex of [bin, okx]) {
        await prisma.ohlcvSnapshot.create({
          data: {
            exchangeId: ex.id, symbol: "BTC/USDT:USDT", timeframe: "1h",
            openTime: new Date(t0 + h * 3600_000),
            open: 100, high: 100.5, low: 99.5, close: 100,
            volume: 1000,
          },
        });
      }
    }
    // Fund rates that create an arbitrage opportunity; last snapshot is late
    // enough that a position opened from it is still OPEN at config.to.
    for (const h of [8, 16, 24, 32, 40, 48, 56, 64]) {
      const at = new Date(t0 + h * 3600_000);
      await prisma.fundingRateSnapshot.create({
        data: { exchangeId: bin.id, symbol: "BTC/USDT:USDT", currentRate: 0.001, collectedAt: at, intervalHours: 8, nextSettlement: new Date(at.getTime() + 8 * 3600_000) },
      });
      await prisma.fundingRateSnapshot.create({
        data: { exchangeId: okx.id, symbol: "BTC/USDT:USDT", currentRate: -0.0005, collectedAt: at, intervalHours: 8, nextSettlement: new Date(at.getTime() + 8 * 3600_000) },
      });
    }

    const result = await runBacktest({
      ...DEFAULT_CONFIG,
      from: new Date(t0),
      to: new Date(t0 + 72 * 3600_000),
      failureRate: 0,
      volatilityPauseEnabled: false,
    });

    // At least one trade closed (sanity)
    expect(result.closedTrades.length).toBeGreaterThan(0);

    // The invariant: final equity point reflects every closed trade's P&L
    const finalEquity = result.equityCurve[result.equityCurve.length - 1].equity;
    const netPnl = result.closedTrades.reduce((s, t) => s + t.netPnl, 0);
    expect(Math.abs((finalEquity - DEFAULT_CONFIG.initialCapital) - netPnl)).toBeLessThan(0.01);
  }, 60_000);
```

- [ ] **Step 2.2: 运行集成测试确认失败**

Run: `pnpm vitest run tests/integration/backtest/end-to-end.test.ts -t "finalEquity - initialCapital equals sum"`
Expected: FAIL — `finalEquity` 停在强平前的日点，`netPnl` 包含强平仓位，两者相差一个非零值。

如果意外通过（说明 72h 内没有留下未平仓仓位，force-close 未触发），修改 `for (const h of [...])` 加入 `72` 或扩大到 96h——但先按当前配置跑。72h 内 risk_control close 阈值是 72h，开仓在 h=8 的仓位会在 h=80 被平掉；开仓在 h=32 之后的 3 笔将在 config.to 被强平，失败应复现。

- [ ] **Step 2.3: 在 runner.ts 里追加 final equity 点**

Open `src/server/services/backtest/runner/runner.ts`. 定位到 `src/server/services/backtest/runner/runner.ts:97-113` 的强平循环和 return 段：

```ts
  // Force-close any remaining open positions at config.to
  clock.setTime(config.to);
  const openAtEnd = await store.listOpenPositions();
  for (const p of openAtEnd) {
    try {
      await closeHedgedPosition(ctx, {
        idempotencyKey: `bt-force-close-${p.id}`,
        positionId: p.id,
        reason: "manual",
      });
    } catch (err) {
      ctx.log("force-close error", { positionId: p.id, err: String(err) });
    }
  }

  const closedTrades = buildClosedTrades(store, exchangeNamesById);
  return { config, startedAt, finishedAt: new Date(), closedTrades, equityCurve };
```

整段替换为：

```ts
  // Force-close any remaining open positions at config.to
  clock.setTime(config.to);
  const openAtEnd = await store.listOpenPositions();
  for (const p of openAtEnd) {
    try {
      await closeHedgedPosition(ctx, {
        idempotencyKey: `bt-force-close-${p.id}`,
        positionId: p.id,
        reason: "manual",
      });
    } catch (err) {
      ctx.log("force-close error", { positionId: p.id, err: String(err) });
    }
  }

  const closedTrades = buildClosedTrades(store, exchangeNamesById);

  // Append a final equity point at config.to so finalEquity and sum(trades.netPnl)
  // agree by construction once every position is closed. Without this point,
  // equityCurve stops at the last daily tick (pre-force-close) while closedTrades
  // already reflects the force-closed P&L — giving a roi/netPnl sign mismatch.
  const finalRealized = closedTrades.reduce((s, t) => s + (t.grossPnl - t.fees), 0);
  const finalFunding = store.allSettlements().reduce((s, x) => s + Number(x.fundingAmount), 0);
  equityCurve.push({
    date: config.to,
    equity: config.initialCapital + finalRealized + finalFunding,
    grossPnl: closedTrades.reduce((s, t) => s + t.grossPnl, 0),
    netPnl: closedTrades.reduce((s, t) => s + t.netPnl, 0),
    totalFees: closedTrades.reduce((s, t) => s + t.fees, 0),
  });

  return { config, startedAt, finishedAt: new Date(), closedTrades, equityCurve };
```

- [ ] **Step 2.4: 运行新集成测试确认通过**

Run: `pnpm vitest run tests/integration/backtest/end-to-end.test.ts -t "finalEquity - initialCapital equals sum"`
Expected: PASS。

- [ ] **Step 2.5: 跑完整 backtest 测试套确认无回归**

Run: `pnpm vitest run tests/unit/backtest tests/integration/backtest`
Expected: 全部 PASS。

特别注意现有 `runs a 2-day backtest with seeded data and produces 4 report files` 用例：它断言 `row.equityCurve.length === result.equityCurve.length`——新加的尾点会让两边都 +1，断言仍然成立。

- [ ] **Step 2.6: 提交 commit 2**

```bash
git add src/server/services/backtest/runner/runner.ts tests/integration/backtest/end-to-end.test.ts
git commit -m "$(cat <<'EOF'
fix(backtest): append final equity point after force-close

The timeline loop only pushes one equity point per day. The force-close
loop runs after the timeline and its realized P&L never made it into
equityCurve. As a result finalEquity was stale and aggregate's ROI
could disagree in sign with sum(trades.netPnl).

Append one final point at config.to using the same formula as the daily
accumulator. Adds integration test asserting the invariant
  finalEquity - initialCapital == sum(trades.netPnl)  (±0.01)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Bug 1 — positionSize 按 USD 语义换算

**Files:**
- Modify: `src/server/services/backtest/types.ts`（加 JSDoc；扩展 `ClosedTrade` 加 longSize/shortSize）
- Modify: `src/server/services/backtest/runner/runner.ts:237-262`（开仓循环做 USD→基础币换算；`buildClosedTrades` 填充新字段）
- Modify: `tests/integration/backtest/end-to-end.test.ts`（追加 Bug 1 断言）

**TDD 顺序：** 先扩类型（让测试能编译），然后写测试，再实现换算。

---

- [ ] **Step 3.1: 扩展 `ClosedTrade` 类型加 longSize/shortSize 并给 `positionSize` 加 JSDoc**

Open `src/server/services/backtest/types.ts`. 找到 `BacktestConfig.positionSize` 字段和 `ClosedTrade` 接口。

替换 `positionSize: number;` 为：

```ts
  /**
   * Per-leg notional in USD. Runner converts to base-asset quantity at open
   * time via `positionSize / currentPrice` before calling openHedgedPosition.
   * (Production executor takes base-asset units; this conversion is a
   * backtest-only concern.)
   */
  positionSize: number;
```

在 `ClosedTrade` 接口里，把 `longExit: number; shortExit: number;` 之后、`grossPnl: number;` 之前加两行 `longSize: number; shortSize: number;`——最终的接口完整定义：

```ts
export interface ClosedTrade {
  positionId: string;
  symbol: string;
  longExchange: string;
  shortExchange: string;
  openedAt: Date;
  closedAt: Date;
  longEntry: number;
  shortEntry: number;
  longExit: number;
  shortExit: number;
  longSize: number;
  shortSize: number;
  grossPnl: number;
  fees: number;
  fundingPnl: number;
  netPnl: number;
  holdHours: number;
}
```

- [ ] **Step 3.2: 更新 `buildClosedTrades` 填充 longSize/shortSize**

Open `src/server/services/backtest/runner/runner.ts`. 在 `buildClosedTrades` 末尾的 `trades.push({...})`，把对象字面量里 `longEntry, shortEntry, longExit, shortExit,` 之后、`grossPnl, fees, fundingPnl, netPnl, holdHours,` 之前插入 `longSize, shortSize,`。最终形如：

```ts
    trades.push({
      positionId:    p.id,
      symbol:        p.symbol,
      longExchange:  exchangeNames.get(p.longExchangeId)  ?? p.longExchangeId,
      shortExchange: exchangeNames.get(p.shortExchangeId) ?? p.shortExchangeId,
      openedAt, closedAt,
      longEntry, shortEntry, longExit, shortExit,
      longSize, shortSize,
      grossPnl, fees, fundingPnl, netPnl, holdHours,
    });
```

`longSize` / `shortSize` 本地变量在同一函数内几行之前已经定义（`const longSize = Number(p.longSize);`），直接复用。

- [ ] **Step 3.3: 跑一次 typecheck 确认类型改动不坏别的地方**

Run: `pnpm typecheck`
Expected: 通过。若任何消费者（UI 图表、reporter）对 `ClosedTrade` 做了严格 shape 检查，此时会暴露——但新字段只是增加可选消费面，不删除/改名，因此应当没问题。

- [ ] **Step 3.4: 写失败的集成测试**

在 `tests/integration/backtest/end-to-end.test.ts` 的 `describe` 块末尾、最后一个现有 `it(...)` 之后追加：

```ts
  it("positionSize is USD notional: runner opens base-asset quantity ≈ positionSize / price", async () => {
    const bin = await prisma.exchange.create({ data: { name: "binance", apiKey: "", apiSecret: "", feeRate: 0.0005 } });
    const okx = await prisma.exchange.create({ data: { name: "okx", apiKey: "", apiSecret: "", feeRate: 0.0005 } });
    const t0 = Date.UTC(2025, 0, 1);

    const BTC_PRICE = 50_000;
    for (let h = 0; h < 48; h++) {
      for (const ex of [bin, okx]) {
        await prisma.ohlcvSnapshot.create({
          data: {
            exchangeId: ex.id, symbol: "BTC/USDT:USDT", timeframe: "1h",
            openTime: new Date(t0 + h * 3600_000),
            open: BTC_PRICE, high: BTC_PRICE * 1.001, low: BTC_PRICE * 0.999,
            close: BTC_PRICE,
            volume: 1000,
          },
        });
      }
    }
    for (const h of [8, 16, 24, 32, 40]) {
      const at = new Date(t0 + h * 3600_000);
      await prisma.fundingRateSnapshot.create({
        data: { exchangeId: bin.id, symbol: "BTC/USDT:USDT", currentRate: 0.001, collectedAt: at, intervalHours: 8, nextSettlement: new Date(at.getTime() + 8 * 3600_000) },
      });
      await prisma.fundingRateSnapshot.create({
        data: { exchangeId: okx.id, symbol: "BTC/USDT:USDT", currentRate: -0.0005, collectedAt: at, intervalHours: 8, nextSettlement: new Date(at.getTime() + 8 * 3600_000) },
      });
    }

    const USD_NOTIONAL = 500;
    const result = await runBacktest({
      ...DEFAULT_CONFIG,
      from: new Date(t0),
      to: new Date(t0 + 48 * 3600_000),
      positionSize: USD_NOTIONAL,
      failureRate: 0,
      volatilityPauseEnabled: false,
    });

    expect(result.closedTrades.length).toBeGreaterThan(0);
    for (const t of result.closedTrades) {
      // longSize should be ≈ USD_NOTIONAL / BTC_PRICE (0.01 BTC), not USD_NOTIONAL (500 BTC).
      // Notional at entry price ≈ USD_NOTIONAL within a few bps of slippage.
      const notional = t.longSize * t.longEntry;
      expect(Math.abs(notional - USD_NOTIONAL)).toBeLessThan(USD_NOTIONAL * 0.01);
    }
  }, 60_000);
```

- [ ] **Step 3.5: 运行测试确认失败**

Run: `pnpm vitest run tests/integration/backtest/end-to-end.test.ts -t "positionSize is USD notional"`
Expected: FAIL。当前实现把 `positionSize=500` 直接作为基础币数量，所以 `t.longSize = 500`，`notional = 500 × 50000 = 25,000,000`——远超 `USD_NOTIONAL * 1.01 = 505`，断言失败。

- [ ] **Step 3.6: 实现 USD → 基础币数量换算**

Open `src/server/services/backtest/runner/runner.ts`. 定位到 `src/server/services/backtest/runner/runner.ts:237-262` 的开仓 for 循环。当前代码：

```ts
  for (const op of ops.slice(0, slots)) {
    try {
      const result = await openHedgedPosition(ctx, {
        idempotencyKey: `bt-${ctx.clock.now().getTime()}-${op.symbol}-${op.longExchange}-${op.shortExchange}`,
        opportunityId: `bt-op-${ctx.clock.now().getTime()}`,
        symbol: op.symbol,
        longExchange: op.longExchange,
        shortExchange: op.shortExchange,
        size: cfg.positionSize,
        leverage: 1,
      });
      ctx.log("open result", {
        symbol: op.symbol,
        status: result.status,
        positionId: result.positionId,
        note: result.note,
      });
    } catch (err) {
      ctx.log("open error", {
        symbol: op.symbol,
        longExchange: op.longExchange,
        shortExchange: op.shortExchange,
        err: String(err),
      });
    }
  }
```

整段替换为：

```ts
  for (const op of ops.slice(0, slots)) {
    try {
      // Convert USD notional to base-asset quantity using the long leg's
      // current price. Long and short prices are within a handful of bps,
      // so asymmetry is negligible for backtest purposes.
      const longAdapter = await ctx.adapterFor(op.longExchange);
      const ticker = await longAdapter.getPrice(op.symbol);
      if (ticker.last <= 0) {
        ctx.log("open skipped: non-positive price", { symbol: op.symbol, price: ticker.last });
        continue;
      }
      const baseQty = cfg.positionSize / ticker.last;

      const result = await openHedgedPosition(ctx, {
        idempotencyKey: `bt-${ctx.clock.now().getTime()}-${op.symbol}-${op.longExchange}-${op.shortExchange}`,
        opportunityId: `bt-op-${ctx.clock.now().getTime()}`,
        symbol: op.symbol,
        longExchange: op.longExchange,
        shortExchange: op.shortExchange,
        size: baseQty,
        leverage: 1,
      });
      ctx.log("open result", {
        symbol: op.symbol,
        status: result.status,
        positionId: result.positionId,
        note: result.note,
        usdNotional: cfg.positionSize,
        baseQty,
        refPrice: ticker.last,
      });
    } catch (err) {
      ctx.log("open error", {
        symbol: op.symbol,
        longExchange: op.longExchange,
        shortExchange: op.shortExchange,
        err: String(err),
      });
    }
  }
```

- [ ] **Step 3.7: 运行测试确认通过**

Run: `pnpm vitest run tests/integration/backtest/end-to-end.test.ts -t "positionSize is USD notional"`
Expected: PASS——`t.longSize ≈ 500/50000 = 0.01`，`notional = 0.01 * 50000 = 500`，误差在 1% 容差内。

- [ ] **Step 3.8: 跑完整套件确认 Bug 3 的集成不变量依然通过**

Run: `pnpm vitest run tests/unit/backtest tests/integration/backtest`
Expected: 全部 PASS。

**特别关注：** `trades have real math` 用例里原测试的 `expect(t.fees).toBeGreaterThan(0)`。BTC @ 100（测试里的价格）、positionSize=500 USD → baseQty=5 → fee = 100 × 5 × 0.0005 = 0.25 USD/腿——非零，断言依然过。

另外 `equityCurve.length` 的断言：之前是 `> 0`，现在因为 Bug 3 fix 会多一个尾点，仍 `> 0`。

- [ ] **Step 3.9: 提交 commit 3**

```bash
git add src/server/services/backtest/types.ts src/server/services/backtest/runner/runner.ts tests/integration/backtest/end-to-end.test.ts
git commit -m "$(cat <<'EOF'
fix(backtest): treat positionSize as USD notional, not base units

positionSize was authored as USD intent (500 USD at 10k capital = 5% risk)
but the executor contract is base-asset units, matching ccxt createOrder.
On BTC @ 77k this opened 500 BTC = $38.8M notional per leg, blowing up
every fee and P&L in the report.

Runner now queries the long adapter's price and converts USD → base-asset
quantity before calling openHedgedPosition. Production executor contract
is unchanged. ClosedTrade gains longSize/shortSize for direct assertion.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 集成验证 & PR 准备

**Files:** (no code changes)

---

- [ ] **Step 4.1: 跑完整仓库的相关测试**

Run: `pnpm vitest run tests/unit/backtest tests/integration/backtest`
Expected: 全部 PASS。

- [ ] **Step 4.2: 跑 typecheck**

Run: `pnpm typecheck`
Expected: 无类型错误。特别关注 `ClosedTrade` 新增的 `longSize`/`shortSize` 字段——若 UI 或 reporter 消费 `ClosedTrade` 的地方有类型解构，编译会报错。若报错，按现有风格补 `longSize: 0, shortSize: 0` 或略过即可（多出来的字段不会破坏消费者）。

- [ ] **Step 4.3: 跑 lint**

Run: `pnpm lint`
Expected: 通过。

- [ ] **Step 4.4: 查看 commit 历史**

Run: `git log --oneline main..HEAD`
Expected: 4 条 commit（按时间倒序）：

```
<sha4> fix(backtest): treat positionSize as USD notional, not base units
<sha3> fix(backtest): append final equity point after force-close
<sha2> fix(backtest): wAvg ignores PENDING/FAILED trade logs
3544ac7 docs(plan6): design spec for backtest P&L math fixes
```

- [ ] **Step 4.5: 推送并创建 PR**

```bash
git push -u origin feature/plan6-pnl-math
gh pr create --title "fix(backtest): 3 P&L math fixes" --body "$(cat <<'EOF'
## Summary

Three orthogonal P&L math fixes surfaced by the v0.2.0 Vultr 6-month real-data run. All limited to the backtest runner; production executor contracts unchanged.

- **wAvg filter**: `buildClosedTrades` now ignores PENDING/FAILED trade logs, so a failed close leg can't silently zero a sibling good leg's exit price. Warns explicitly when an exit genuinely comes out 0.
- **Final equity point**: runner appends one equity point at `config.to` after the force-close loop, so `finalEquity - initialCapital == sum(trades.netPnl)` by construction — eliminating the roi/netPnl sign mismatch seen in reports.
- **positionSize USD semantics**: runner converts `cfg.positionSize` (USD notional per leg) to base-asset quantity via `positionSize / currentPrice` before calling `openHedgedPosition`. `ClosedTrade` gains `longSize`/`shortSize` for direct assertion.

Spec: `docs/superpowers/specs/2026-04-20-plan6-backtest-pnl-math-fixes-design.md`.

## Test plan

- [ ] `pnpm vitest run tests/unit/backtest tests/integration/backtest` — green
- [ ] `pnpm typecheck` — green
- [ ] `pnpm lint` — green
- [ ] Manual (deferred, needs Vultr + huobi OHLCV): re-run 6-month backtest, confirm trade sizes ~\$500 notional, no spurious longExit=0, roi/netPnl same sign.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4.6: 更新 memory**

Open `/Users/jeff/.claude/projects/-Users-jeff-Work-workspace-crypto-arbitrage/memory/project_backtest_gap.md`. 在"**3 new bugs surfaced**"段落标题下追加一行：

```
**Status (2026-04-20):** All 3 bugs resolved in Plan 6 (`feature/plan6-pnl-math`). See spec `docs/superpowers/specs/2026-04-20-plan6-backtest-pnl-math-fixes-design.md`.
```

（若 PR 已合并则改写为 `Resolved and merged as vX.Y.Z`。）

---

## Self-Review 检查清单（Plan 作者自检）

**Spec coverage:**
- [x] Bug 1 覆盖：Task 3（Steps 3.1-3.9）
- [x] Bug 2 覆盖：Task 1（Steps 1.1-1.7）
- [x] Bug 3 覆盖：Task 2（Steps 2.1-2.6）
- [x] Spec 中的测试计划：wAvg unit 测试 → Task 1；final equity 不变量 → Task 2；USD 名义 → Task 3
- [x] Spec 的 warning-on-exit=0 → Step 1.4
- [x] Spec 的 `positionSize` JSDoc 更新 → Step 3.1
- [x] Spec 的"不做 aggregate.ts 重写"→ 计划中确实没动它

**Placeholder scan:** 无 TBD / TODO / "similar to above" / 省略的代码块。

**Type consistency:** `wAvgFilledPrice` 在 Task 1 和 buildClosedTrades 内同名使用；`ClosedTrade.longSize`/`shortSize` 在 Task 3 的 type 扩展和 buildClosedTrades 对象字面量里同名。

**Step size:** 每步 2-5 分钟可完成；commit 分布合理（3 个修复 3 个 commit + 1 个 spec commit）。
