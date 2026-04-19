# 回测 UI 集成 (Plan 5 Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/backtest` 页面从 Plan 1 的占位符改成历史回测 viewer——列出所有 `BacktestRun`、点进去显示 5 核心指标卡 + 7 图表（recharts × 6 + @visx/heatmap × 1）。回测仍由 CLI 产生，UI 不负责触发（留给 Plan 6 Phase B）。

**Architecture:** Runner 跑完回测后通过新增的 `persistRun()` 往 `BacktestRun` 表写一行（预聚合 6 指标 + config 快照 + `closedTrades` / `equityCurve` JSON 明细）。tRPC `backtestRouter` 的 `list` / `get` 供 UI 拉数据。Aggregate 纯函数从 `src/server/services/backtest/reporter/` 搬到 `src/lib/` 以便 server/client 共用。前端图表复用 Plan 1 已在用的 recharts，热力图单独引 `@visx/heatmap`（~60KB gzipped）。

**Tech Stack:** Next.js 16 App Router · React 19 · tRPC 11 · Prisma 6 (Postgres) · recharts（项目已有）· @visx/heatmap（新引入）· Vitest 4 · TypeScript 5.

**Spec:** `docs/superpowers/specs/2026-04-19-plan5-backtest-ui-design.md`

**Prerequisite state:**
- v0.2.0 已上线，DI 重构 + backtest CLI + 离线 HTML 报告已部署
- 分支：建 `feature/backtest-ui` 从 `main`
- Dev env（`./dev.sh`）正常
- 基线测试：`pnpm test tests/unit` 127+ passing；`pnpm tsc --noEmit` clean

---

## 总体任务地图

| # | 范围 | 输出 |
|---|---|---|
| 1 | Prisma schema: `BacktestRun` model + migration | 新表 + migration.sql |
| 2 | 搬 `aggregate.ts` → `src/lib/backtest-aggregate.ts` | server/client 共用 |
| 3 | `persist-run.ts` + 单元测试 | CLI 能写入 DB |
| 4 | 接入 CLI + 扩现有 E2E 断言 | 端到端流打通 |
| 5 | `backtestRouter.list` + unit test | list 能返回 |
| 6 | `backtestRouter.get` + unit test + 挂到 root | get 能返回 |
| 7 | 安装 `@visx/heatmap` + peer deps | bundle 增量可控 |
| 8 | Chart 组件 × 3（equity-curve / daily-histogram / by-exchange-pair） | 3 个 recharts 图 |
| 9 | Chart 组件 × 3（by-symbol / fee-pie / hold-duration） | 3 个 recharts 图 |
| 10 | Heatmap 组件（@visx） | 1 个热力图 |
| 11 | UI 骨架：MetadataBar / StatCards / EmptyState | 详情页上半部 |
| 12 | RunList（左侧列表） + URL state | `/backtest?run=` 深链 |
| 13 | RunDetail container + ChartGrid | 详情页装配 |
| 14 | Main `/backtest` 页面 + 空状态 | 完整路由接通 |
| 15 | 手动 E2E smoke（非 commit） | 验收清单 |

共 15 个 task，约 1 天工作量。

---

## Task 1: Prisma schema — BacktestRun + migration

**Files:**
- Modify: `prisma/schema.prisma`（追加到文件末尾）
- Create: `prisma/migrations/<ts>_backtest_run/migration.sql`（Prisma 生成）

- [ ] **Step 1: 追加 model 到 schema.prisma 末尾**

```prisma
model BacktestRun {
  id           String   @id @default(cuid())
  startedAt    DateTime @map("started_at")
  finishedAt   DateTime @map("finished_at")
  fromDate     DateTime @map("from_date")
  toDate       DateTime @map("to_date")
  config       Json

  totalTrades  Int      @map("total_trades")
  winRate      Decimal  @db.Decimal(6, 4)  @map("win_rate")
  roi          Decimal  @db.Decimal(10, 6)
  netPnl       Decimal  @db.Decimal(18, 4) @map("net_pnl")
  maxDrawdown  Decimal  @db.Decimal(18, 4) @map("max_drawdown")
  sharpeRatio  Decimal  @db.Decimal(10, 4) @map("sharpe_ratio")

  closedTrades Json     @map("closed_trades")
  equityCurve  Json     @map("equity_curve")

  createdAt    DateTime @default(now()) @map("created_at")

  @@index([startedAt])
  @@map("backtest_runs")
}
```

- [ ] **Step 2: 生成 migration**

```
docker compose run --rm app pnpm prisma migrate dev --name backtest_run
```

Expected: 新目录 `prisma/migrations/<ts>_backtest_run/migration.sql` 含 `CREATE TABLE backtest_runs` + 6 个 Decimal 列 + 2 个 Json 列 + `CREATE INDEX` on `started_at`。

- [ ] **Step 3: 验证表存在**

```
docker compose exec postgres psql -U arbitrage -c '\d backtest_runs'
```

Expected: 列出 13 个列 + 主键 + startedAt 索引。

- [ ] **Step 4: Commit**

```
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(backtest-ui): add BacktestRun model + migration"
```

---

## Task 2: 迁移 aggregate.ts 到 src/lib/

**Files:**
- Create: `src/lib/backtest-aggregate.ts`（从 reporter 搬）
- Modify: `src/server/services/backtest/reporter/aggregate.ts`（改成 re-export shim）
- Modify: `tests/unit/backtest/aggregate.test.ts`（更新 import 路径）

- [ ] **Step 1: 搬文件**

```
git mv src/server/services/backtest/reporter/aggregate.ts src/lib/backtest-aggregate.ts
```

- [ ] **Step 2: 创建 re-export shim**

Create `src/server/services/backtest/reporter/aggregate.ts`:

```ts
// Re-export the aggregate module for backward-compat with existing imports.
// The canonical home is src/lib/backtest-aggregate.ts so server + client can share.
export * from "@/lib/backtest-aggregate";
```

- [ ] **Step 3: 更新测试 import**

Edit `tests/unit/backtest/aggregate.test.ts`：

```ts
import { aggregate } from "@/lib/backtest-aggregate";
```

（替换原 `"@/server/services/backtest/reporter/aggregate"`）

- [ ] **Step 4: 验证现有测试仍绿**

```
docker compose exec postgres psql -U arbitrage -c "TRUNCATE funding_rate_snapshots, funding_rate_hourly, ohlcv_snapshots, settlements, trade_logs, positions, opportunities, exchanges CASCADE;" >/dev/null
pnpm test tests/unit/backtest/aggregate.test.ts
```

Expected: 2 passing（原有用例保持）。

- [ ] **Step 5: tsc + 全量 unit test 确认 shim 工作**

```
pnpm tsc --noEmit
pnpm test tests/unit
```

Expected: tsc clean；所有 unit tests 过。reporter.ts 的现有 import `from "./aggregate"` 通过 shim 不受影响。

- [ ] **Step 6: Commit**

```
git add src/lib/backtest-aggregate.ts \
        src/server/services/backtest/reporter/aggregate.ts \
        tests/unit/backtest/aggregate.test.ts
git commit -m "refactor(backtest): move aggregate to src/lib for server/client sharing"
```

---

## Task 3: persist-run.ts + 单元测试

**Files:**
- Create: `src/server/services/backtest/reporter/persist-run.ts`
- Create: `tests/unit/backtest/persist-run.test.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/unit/backtest/persist-run.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/server/db/client";
import { persistRun } from "@/server/services/backtest/reporter/persist-run";
import type { BacktestResult, BacktestConfig } from "@/server/services/backtest/types";

async function reset() {
  await prisma.backtestRun.deleteMany();
}

function mkResult(overrides: Partial<BacktestResult> = {}): BacktestResult {
  const config: BacktestConfig = {
    from: new Date("2025-01-01T00:00:00Z"),
    to: new Date("2025-01-03T00:00:00Z"),
    initialCapital: 10_000,
    positionSize: 500,
    maxConcurrent: 3,
    minSpread: 0.0005,
    minApy: 0.1,
    slippageBps: 3,
    failureRate: 0.02,
    seed: "test",
    volatilityPauseEnabled: true,
    volatilityThreshold1h: 0.05,
    volatilityThreshold24h: 0.15,
    rateReversalExit: true,
    minHoldingPeriods: 1,
    healthIntervalSec: 300,
  };
  return {
    config,
    startedAt: new Date("2025-01-03T00:00:00Z"),
    finishedAt: new Date("2025-01-03T00:00:10Z"),
    closedTrades: [],
    equityCurve: [],
    ...overrides,
  };
}

describe("persistRun", () => {
  beforeEach(reset);

  it("writes one BacktestRun row with 6 aggregated metrics", async () => {
    const result = mkResult({
      closedTrades: [
        {
          positionId: "p1", symbol: "BTC/USDT:USDT",
          longExchange: "binance", shortExchange: "okx",
          openedAt: new Date("2025-01-01T00:00:00Z"),
          closedAt: new Date("2025-01-01T08:00:00Z"),
          longEntry: 100, shortEntry: 100, longExit: 101, shortExit: 99,
          grossPnl: 20, fees: 2, fundingPnl: 1, netPnl: 19, holdHours: 8,
        },
      ],
      equityCurve: [
        { date: new Date("2025-01-01"), equity: 10_000, grossPnl: 0, netPnl: 0, totalFees: 0 },
        { date: new Date("2025-01-02"), equity: 10_019, grossPnl: 20, netPnl: 19, totalFees: 2 },
      ],
    });

    const id = await persistRun(prisma, result);
    expect(id).toMatch(/^c/); // cuid

    const row = await prisma.backtestRun.findUniqueOrThrow({ where: { id } });
    expect(row.totalTrades).toBe(1);
    expect(Number(row.winRate)).toBe(1);
    expect(Number(row.netPnl)).toBe(19);
    expect(Array.isArray(row.closedTrades)).toBe(true);
    expect((row.closedTrades as unknown[]).length).toBe(1);
    expect((row.equityCurve as unknown[]).length).toBe(2);
  });

  it("stores config as JSON with from/to preserved", async () => {
    const result = mkResult();
    const id = await persistRun(prisma, result);
    const row = await prisma.backtestRun.findUniqueOrThrow({ where: { id } });
    const cfg = row.config as unknown as { initialCapital: number; seed: string };
    expect(cfg.initialCapital).toBe(10_000);
    expect(cfg.seed).toBe("test");
  });

  it("handles zero-trade results without crashing", async () => {
    const id = await persistRun(prisma, mkResult());
    const row = await prisma.backtestRun.findUniqueOrThrow({ where: { id } });
    expect(row.totalTrades).toBe(0);
    expect(Number(row.roi)).toBe(0);
    expect(Number(row.netPnl)).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认 FAIL**

```
docker compose exec postgres psql -U arbitrage -c "TRUNCATE funding_rate_snapshots, funding_rate_hourly, ohlcv_snapshots, settlements, trade_logs, positions, opportunities, exchanges, backtest_runs CASCADE;" >/dev/null
pnpm test tests/unit/backtest/persist-run.test.ts
```

Expected: FAIL — module not found。

- [ ] **Step 3: 实现**

Create `src/server/services/backtest/reporter/persist-run.ts`:

```ts
import type { PrismaClient } from "@prisma/client";
import type { BacktestResult } from "@/server/services/backtest/types";
import { aggregate } from "@/lib/backtest-aggregate";

export async function persistRun(
  prisma: PrismaClient,
  result: BacktestResult,
): Promise<string> {
  const agg = aggregate(result.closedTrades, result.equityCurve, result.config.initialCapital);
  const o = agg.overall;

  const row = await prisma.backtestRun.create({
    data: {
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      fromDate: result.config.from,
      toDate: result.config.to,
      config: result.config as unknown as object,
      totalTrades: o.totalTrades,
      winRate: o.winRate,
      roi: o.roi,
      netPnl: o.netPnl,
      maxDrawdown: o.maxDrawdown,
      sharpeRatio: o.sharpeRatio,
      closedTrades: result.closedTrades as unknown as object,
      equityCurve: result.equityCurve as unknown as object,
    },
  });
  return row.id;
}
```

- [ ] **Step 4: 运行测试**

```
pnpm test tests/unit/backtest/persist-run.test.ts
```

Expected: 3 passing。

- [ ] **Step 5: Commit**

```
git add src/server/services/backtest/reporter/persist-run.ts \
        tests/unit/backtest/persist-run.test.ts
git commit -m "feat(backtest-ui): persist-run writes BacktestRun row with aggregated metrics"
```

---

## Task 4: 接入 CLI + 扩展 E2E 断言

**Files:**
- Modify: `src/server/services/backtest/cli.ts`
- Modify: `tests/integration/backtest/end-to-end.test.ts`

- [ ] **Step 1: CLI 调 persistRun**

Edit `src/server/services/backtest/cli.ts`。在文件顶部 imports 加：

```ts
import { prisma } from "@/server/db/client";
import { persistRun } from "./reporter/persist-run";
```

把 `main()` 的 phase 2 分支改成：

```ts
const result = await runBacktest(cfg);
const dir = await writeReport(result, cfg.output);
console.log(`[bt] wrote ${dir}`);
console.log(`[bt] trades=${result.closedTrades.length} equityCurvePoints=${result.equityCurve.length}`);
const runId = await persistRun(prisma, result);
console.log(`[bt] persisted run ${runId}`);
```

- [ ] **Step 2: 扩 E2E 测试断言**

Edit `tests/integration/backtest/end-to-end.test.ts`。找到 Plan 4 的"runs a 2-day backtest"测试，在写完报告文件后加：

```ts
// persistRun is invoked by the CLI in production; here the test uses runBacktest + writeReport
// directly, so we call persistRun explicitly to assert the DB row is written correctly.
const { persistRun } = await import("@/server/services/backtest/reporter/persist-run");
const runId = await persistRun(prisma, result);
const row = await prisma.backtestRun.findUniqueOrThrow({ where: { id: runId } });
expect(row.totalTrades).toBeGreaterThanOrEqual(0);
expect(Number(row.roi)).toBeCloseTo((result.config.initialCapital === 0 ? 0 : 0), 5);  // flat equity baseline
expect((row.closedTrades as unknown[]).length).toBe(result.closedTrades.length);
```

注意：原测试的 `reset()` 里要加 `await prisma.backtestRun.deleteMany();` 放在其它 deleteMany 之前（无 FK 依赖，顺序其实无所谓，但补全）：

```ts
async function reset() {
  await prisma.backtestRun.deleteMany();
  await prisma.settlement.deleteMany();
  // ... 其余 deleteMany 保持原样
}
```

- [ ] **Step 3: 运行 E2E + 新测试**

```
docker compose exec postgres psql -U arbitrage -c "TRUNCATE funding_rate_snapshots, funding_rate_hourly, ohlcv_snapshots, settlements, trade_logs, positions, opportunities, exchanges, backtest_runs CASCADE;" >/dev/null
pnpm test tests/integration/backtest/end-to-end.test.ts
```

Expected: 3 passing（Plan 4 的 3 个测试都过，含新加断言）。

- [ ] **Step 4: Commit**

```
git add src/server/services/backtest/cli.ts tests/integration/backtest/end-to-end.test.ts
git commit -m "feat(backtest-ui): CLI calls persistRun after writeReport; E2E asserts DB row"
```

---

## Task 5: backtestRouter.list + unit test

**Files:**
- Create: `src/server/api/routers/backtest.ts`
- Create: `tests/unit/trpc/backtest-router.test.ts`（新目录 tests/unit/trpc 可能需要先建）
- Modify: `src/server/api/root.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/unit/trpc/backtest-router.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { appRouter } from "@/server/api/root";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import type { TRPCContext } from "@/server/api/trpc";

function ctxAuthed(): TRPCContext {
  return {
    prisma, redis,
    user: { id: "u1", username: "test", displayName: null },
    sessionToken: null,
    resHeaders: new Headers(),
    req: new Request("http://localhost:3000", { method: "POST" }),
  } as TRPCContext;
}
function ctxAnon(): TRPCContext {
  return { ...ctxAuthed(), user: null } as TRPCContext;
}

async function reset() {
  await prisma.backtestRun.deleteMany();
}

async function seedRun(startedAt: Date, roi: number, totalTrades: number) {
  return prisma.backtestRun.create({
    data: {
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 60_000),
      fromDate: new Date("2025-01-01"),
      toDate: new Date("2025-04-01"),
      config: { initialCapital: 10_000 },
      totalTrades,
      winRate: 0.5,
      roi,
      netPnl: 100,
      maxDrawdown: 10,
      sharpeRatio: 1.2,
      closedTrades: [],
      equityCurve: [],
    },
  });
}

describe("backtestRouter.list", () => {
  beforeEach(reset);

  it("returns empty array when no runs", async () => {
    const caller = appRouter.createCaller(ctxAuthed());
    const out = await caller.backtest.list();
    expect(out).toEqual([]);
  });

  it("returns runs sorted by startedAt desc", async () => {
    const older = await seedRun(new Date("2025-02-01"), 0.05, 5);
    const newer = await seedRun(new Date("2025-03-01"), 0.1, 10);
    const caller = appRouter.createCaller(ctxAuthed());
    const out = await caller.backtest.list();
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe(newer.id);
    expect(out[1].id).toBe(older.id);
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await seedRun(new Date(2025, 0, 1 + i), 0, 0);
    }
    const caller = appRouter.createCaller(ctxAuthed());
    const out = await caller.backtest.list({ limit: 3 });
    expect(out).toHaveLength(3);
  });

  it("rejects unauthenticated", async () => {
    const caller = appRouter.createCaller(ctxAnon());
    await expect(caller.backtest.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
```

- [ ] **Step 2: 运行测试确认 FAIL**

```
docker compose exec postgres psql -U arbitrage -c "TRUNCATE funding_rate_snapshots, funding_rate_hourly, ohlcv_snapshots, settlements, trade_logs, positions, opportunities, exchanges, backtest_runs CASCADE;" >/dev/null
pnpm test tests/unit/trpc/backtest-router.test.ts
```

Expected: FAIL — `backtest` not on appRouter。

- [ ] **Step 3: 实现 list**

Create `src/server/api/routers/backtest.ts`:

```ts
import { z } from "zod";
import { router, protectedProcedure } from "../trpc";

export const backtestRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(500).default(50) })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 50;
      return ctx.prisma.backtestRun.findMany({
        orderBy: { startedAt: "desc" },
        take: limit,
        select: {
          id: true,
          startedAt: true,
          fromDate: true,
          toDate: true,
          totalTrades: true,
          winRate: true,
          roi: true,
          netPnl: true,
        },
      });
    }),
});
```

- [ ] **Step 4: 挂到 root**

Edit `src/server/api/root.ts`。加 import：

```ts
import { backtestRouter } from "./routers/backtest";
```

把 `appRouter = router({...})` 里加 `backtest: backtestRouter`（位置按字母序靠后即可）：

```ts
export const appRouter = router({
  auth: authRouter,
  backtest: backtestRouter,
  exchange: exchangeRouter,
  // ... 其余保持
});
```

- [ ] **Step 5: 运行测试**

```
pnpm test tests/unit/trpc/backtest-router.test.ts
```

Expected: 4 passing。

- [ ] **Step 6: Commit**

```
git add src/server/api/routers/backtest.ts src/server/api/root.ts \
        tests/unit/trpc/backtest-router.test.ts
git commit -m "feat(backtest-ui): backtestRouter.list + mount to appRouter"
```

---

## Task 6: backtestRouter.get + unit test

**Files:**
- Modify: `src/server/api/routers/backtest.ts`
- Modify: `tests/unit/trpc/backtest-router.test.ts`

- [ ] **Step 1: 扩测试**

在 `tests/unit/trpc/backtest-router.test.ts` 末尾追加 describe 块：

```ts
describe("backtestRouter.get", () => {
  beforeEach(reset);

  it("returns full row including trades and equityCurve", async () => {
    const run = await seedRun(new Date("2025-03-01"), 0.1, 10);
    const caller = appRouter.createCaller(ctxAuthed());
    const out = await caller.backtest.get({ id: run.id });
    expect(out.id).toBe(run.id);
    expect(out.config).toBeTypeOf("object");
    expect(Array.isArray(out.closedTrades)).toBe(true);
    expect(Array.isArray(out.equityCurve)).toBe(true);
  });

  it("throws NOT_FOUND on unknown id", async () => {
    const caller = appRouter.createCaller(ctxAuthed());
    await expect(caller.backtest.get({ id: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rejects unauthenticated", async () => {
    const caller = appRouter.createCaller(ctxAnon());
    await expect(caller.backtest.get({ id: "any" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
```

- [ ] **Step 2: 运行 FAIL**

```
pnpm test tests/unit/trpc/backtest-router.test.ts
```

Expected: 新 describe 块 FAIL — get 未实现。

- [ ] **Step 3: 加 get 到 backtestRouter**

Edit `src/server/api/routers/backtest.ts`。加 import：

```ts
import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
```

在 `router({ list: ..., })` 里补一个 `get`：

```ts
get: protectedProcedure
  .input(z.object({ id: z.string().min(1) }))
  .query(async ({ ctx, input }) => {
    try {
      return await ctx.prisma.backtestRun.findUniqueOrThrow({
        where: { id: input.id },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
        throw new TRPCError({ code: "NOT_FOUND", message: "run not found" });
      }
      throw e;
    }
  }),
```

- [ ] **Step 4: 运行测试**

```
pnpm test tests/unit/trpc/backtest-router.test.ts
```

Expected: 7 passing（4 from Task 5 + 3 新）。

- [ ] **Step 5: Commit**

```
git add src/server/api/routers/backtest.ts tests/unit/trpc/backtest-router.test.ts
git commit -m "feat(backtest-ui): backtestRouter.get returns full run or NOT_FOUND"
```

---

## Task 7: 安装 @visx/heatmap 依赖

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: 安装**

```
pnpm add @visx/heatmap @visx/scale @visx/group
```

- [ ] **Step 2: Typecheck**

```
pnpm tsc --noEmit
```

Expected: clean（新包有自己的 type defs）。

- [ ] **Step 3: Bundle 观察**

```
pnpm next build 2>&1 | tail -25
```

不断言具体数字，只要 build 过 + route `/backtest` 依然在 routes 清单（虽然还是占位符）。

- [ ] **Step 4: Commit**

```
git add package.json pnpm-lock.yaml
git commit -m "chore(backtest-ui): add @visx/heatmap + @visx/scale + @visx/group deps"
```

---

## Task 8: Chart 组件（1/3）— equity-curve + daily-pnl-histogram + by-exchange-pair

**Files:**
- Create: `src/components/backtest/charts/equity-curve.tsx`
- Create: `src/components/backtest/charts/daily-pnl-histogram.tsx`
- Create: `src/components/backtest/charts/by-exchange-pair.tsx`

- [ ] **Step 1: equity-curve.tsx**

Create:

```tsx
"use client";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import type { EquityCurvePoint } from "@/server/services/backtest/types";

interface Props {
  data: EquityCurvePoint[];
  maxDrawdownDate: Date | null;
}

export function EquityCurve({ data, maxDrawdownDate }: Props) {
  const chartData = data.map((p) => ({
    t: new Date(p.date).getTime(),
    equity: Number(p.equity),
  }));
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium text-foreground mb-3">账户净值曲线</h3>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={chartData}>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
          <XAxis
            dataKey="t"
            tickFormatter={(ms) => new Date(ms).toISOString().slice(5, 10)}
            stroke="hsl(var(--muted-foreground))"
            fontSize={11}
          />
          <YAxis
            tickFormatter={(v) => `$${v.toFixed(0)}`}
            stroke="hsl(var(--muted-foreground))"
            fontSize={11}
            domain={["auto", "auto"]}
          />
          <Tooltip
            labelFormatter={(ms) => new Date(ms as number).toISOString().slice(0, 10)}
            formatter={(v: number) => `$${v.toFixed(2)}`}
            contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
          />
          <Line type="monotone" dataKey="equity" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
          {maxDrawdownDate && (
            <ReferenceLine
              x={new Date(maxDrawdownDate).getTime()}
              stroke="hsl(var(--destructive))"
              strokeDasharray="3 3"
              label={{ value: "max DD", position: "top", fill: "hsl(var(--destructive))", fontSize: 10 }}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 2: daily-pnl-histogram.tsx**

Create:

```tsx
"use client";
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from "recharts";

interface Props {
  data: { bin: number; count: number }[];
}

export function DailyPnlHistogram({ data }: Props) {
  const chartData = data.map((d) => ({
    bin: d.bin.toFixed(2),
    count: d.count,
    positive: d.bin >= 0,
  }));
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium text-foreground mb-3">每笔交易 P&L 分布</h3>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={chartData}>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
          <XAxis dataKey="bin" stroke="hsl(var(--muted-foreground))" fontSize={10} />
          <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
          <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
          <Bar dataKey="count" fill="hsl(var(--primary))" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 3: by-exchange-pair.tsx**

Create:

```tsx
"use client";
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Cell } from "recharts";

interface Props {
  data: { key: string; netPnl: number; count: number }[];
}

export function ByExchangePair({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-medium text-foreground mb-3">按交易所对 P&L</h3>
        <p className="text-xs text-muted-foreground">（无数据）</p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium text-foreground mb-3">按交易所对 P&L</h3>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} layout="vertical">
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
          <XAxis type="number" stroke="hsl(var(--muted-foreground))" fontSize={11} />
          <YAxis dataKey="key" type="category" stroke="hsl(var(--muted-foreground))" fontSize={11} width={120} />
          <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
          <Bar dataKey="netPnl">
            {data.map((d, i) => (
              <Cell key={i} fill={d.netPnl >= 0 ? "hsl(var(--positive))" : "hsl(var(--destructive))"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

```
pnpm tsc --noEmit
```

Expected: clean。

- [ ] **Step 5: Commit**

```
git add src/components/backtest/charts/equity-curve.tsx \
        src/components/backtest/charts/daily-pnl-histogram.tsx \
        src/components/backtest/charts/by-exchange-pair.tsx
git commit -m "feat(backtest-ui): equity-curve + daily-pnl + by-exchange-pair charts"
```

---

## Task 9: Chart 组件（2/3）— by-symbol + fee-pie + hold-duration

**Files:**
- Create: `src/components/backtest/charts/by-symbol.tsx`
- Create: `src/components/backtest/charts/fee-pie.tsx`
- Create: `src/components/backtest/charts/hold-duration.tsx`

- [ ] **Step 1: by-symbol.tsx**

Create:

```tsx
"use client";
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Cell } from "recharts";

interface Props {
  data: { key: string; netPnl: number; count: number }[];
}

export function BySymbol({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-medium text-foreground mb-3">按币种 P&L</h3>
        <p className="text-xs text-muted-foreground">（无数据）</p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium text-foreground mb-3">按币种 P&L</h3>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data}>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
          <XAxis dataKey="key" stroke="hsl(var(--muted-foreground))" fontSize={11} />
          <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
          <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
          <Bar dataKey="netPnl">
            {data.map((d, i) => (
              <Cell key={i} fill={d.netPnl >= 0 ? "hsl(var(--positive))" : "hsl(var(--destructive))"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 2: fee-pie.tsx**

Create:

```tsx
"use client";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from "recharts";

interface Props {
  totalFees: number;
  netPnl: number;
}

export function FeePie({ totalFees, netPnl }: Props) {
  const data = [
    { name: "总手续费", value: Math.max(0, totalFees) },
    { name: "净收益", value: Math.max(0, netPnl) },
  ];
  const allZero = data.every((d) => d.value === 0);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium text-foreground mb-3">手续费 vs 净收益</h3>
      {allZero ? (
        <p className="text-xs text-muted-foreground">（无数据）</p>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" outerRadius={90} label>
              <Cell fill="hsl(var(--destructive))" />
              <Cell fill="hsl(var(--positive))" />
            </Pie>
            <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
```

- [ ] **Step 3: hold-duration.tsx**

Create:

```tsx
"use client";
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from "recharts";

interface Props {
  data: { bucket: string; count: number }[];
}

export function HoldDuration({ data }: Props) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium text-foreground mb-3">持仓时长分布</h3>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data}>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
          <XAxis dataKey="bucket" stroke="hsl(var(--muted-foreground))" fontSize={11} />
          <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
          <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
          <Bar dataKey="count" fill="hsl(var(--primary))" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck + commit**

```
pnpm tsc --noEmit
git add src/components/backtest/charts/by-symbol.tsx \
        src/components/backtest/charts/fee-pie.tsx \
        src/components/backtest/charts/hold-duration.tsx
git commit -m "feat(backtest-ui): by-symbol + fee-pie + hold-duration charts"
```

---

## Task 10: Heatmap 组件（@visx/heatmap）

**Files:**
- Create: `src/components/backtest/charts/heatmap.tsx`

- [ ] **Step 1: 实现**

Create `src/components/backtest/charts/heatmap.tsx`:

```tsx
"use client";
import { Group } from "@visx/group";
import { scaleLinear } from "@visx/scale";
import { HeatmapRect } from "@visx/heatmap";

interface GroupStat {
  key: string;
  count: number;
  netPnl: number;
}

interface Props {
  byDayOfWeek: GroupStat[];
  byHourOfDay: GroupStat[];
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS = Array.from({ length: 24 }, (_, i) => String(i));

/**
 * Plan 4 HTML report's heatmap simplification: cell[day][hour] = byDay[day].count * byHour[hour].count
 * Not a true per-cell aggregation, but consistent with the existing baseline.
 */
export function Heatmap({ byDayOfWeek, byHourOfDay }: Props) {
  const byDay = new Map(byDayOfWeek.map((g) => [g.key, g.count]));
  const byHour = new Map(byHourOfDay.map((g) => [g.key, g.count]));

  // Build 2D grid: bins[day-idx] = { bin: day, bins: [{bin: hour, count}] }
  const bins = DAYS.map((_, dayIdx) => ({
    bin: dayIdx,
    bins: HOURS.map((_, hourIdx) => ({
      bin: hourIdx,
      count: (byDay.get(String(dayIdx)) ?? 0) * (byHour.get(String(hourIdx)) ?? 0),
    })),
  }));

  const maxCount = Math.max(1, ...bins.flatMap((d) => d.bins.map((b) => b.count)));

  const width = 720;
  const height = 180;
  const margin = { top: 8, left: 40, right: 8, bottom: 24 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const binWidth = innerW / 24;
  const binHeight = innerH / 7;

  const xScale = scaleLinear<number>({ domain: [0, 24], range: [0, innerW] });
  const yScale = scaleLinear<number>({ domain: [0, 7], range: [0, innerH] });
  const colorScale = scaleLinear<string>({
    range: ["hsl(var(--muted))", "hsl(var(--primary))"],
    domain: [0, maxCount],
  });

  if (maxCount === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-medium text-foreground mb-3">机会热力图（星期 × 小时, UTC）</h3>
        <p className="text-xs text-muted-foreground">（无数据）</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium text-foreground mb-3">机会热力图（星期 × 小时, UTC）</h3>
      <svg width={width} height={height}>
        <Group top={margin.top} left={margin.left}>
          <HeatmapRect
            data={bins}
            xScale={(v) => xScale(v) ?? 0}
            yScale={(v) => yScale(v) ?? 0}
            colorScale={colorScale}
            binWidth={binWidth}
            binHeight={binHeight}
            gap={1}
          >
            {(heatmap) =>
              heatmap.map((heatmapBins) =>
                heatmapBins.map((bin) => (
                  <rect
                    key={`${bin.row}-${bin.column}`}
                    width={bin.width}
                    height={bin.height}
                    x={bin.x}
                    y={bin.y}
                    fill={bin.color}
                    stroke="hsl(var(--border))"
                  />
                )),
              )
            }
          </HeatmapRect>
          {DAYS.map((d, i) => (
            <text
              key={d}
              x={-6}
              y={yScale(i + 0.5)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={10}
              fill="hsl(var(--muted-foreground))"
            >
              {d}
            </text>
          ))}
          {HOURS.filter((_, i) => i % 3 === 0).map((h, idx) => {
            const i = idx * 3;
            return (
              <text
                key={h}
                x={xScale(i + 0.5)}
                y={innerH + 14}
                textAnchor="middle"
                fontSize={10}
                fill="hsl(var(--muted-foreground))"
              >
                {h}
              </text>
            );
          })}
        </Group>
      </svg>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```
pnpm tsc --noEmit
```

Expected: clean。如果 @visx 类型报错，可能是 peer deps 需要 `pnpm add @visx/annotation`（看报错信息）。

- [ ] **Step 3: Commit**

```
git add src/components/backtest/charts/heatmap.tsx
git commit -m "feat(backtest-ui): day × hour heatmap via @visx/heatmap"
```

---

## Task 11: UI 骨架 — MetadataBar + StatCards + EmptyState

**Files:**
- Create: `src/components/backtest/metadata-bar.tsx`
- Create: `src/components/backtest/stat-cards.tsx`
- Create: `src/components/backtest/empty-state.tsx`

- [ ] **Step 1: metadata-bar.tsx**

Create:

```tsx
"use client";
import { useState } from "react";

interface Props {
  from: Date;
  to: Date;
  config: unknown;
}

export function MetadataBar({ from, to, config }: Props) {
  const [open, setOpen] = useState(false);
  const fromStr = new Date(from).toISOString().slice(0, 10);
  const toStr = new Date(to).toISOString().slice(0, 10);
  return (
    <div className="mb-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-foreground">
          <span className="text-muted-foreground">回测区间</span>{" "}
          <span className="font-mono">{fromStr}</span>
          <span className="mx-2 text-muted-foreground">→</span>
          <span className="font-mono">{toStr}</span>
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-xs text-primary hover:underline"
        >
          {open ? "收起参数" : "展开参数"}
        </button>
      </div>
      {open && (
        <pre className="mt-3 p-3 text-xs bg-muted/30 rounded overflow-x-auto">
          {JSON.stringify(config, null, 2)}
        </pre>
      )}
    </div>
  );
}
```

- [ ] **Step 2: stat-cards.tsx**

Create:

```tsx
"use client";
import type { OverallStats } from "@/lib/backtest-aggregate";
import { StatCard } from "@/components/ui/stat-card";
import { TrendingUp, DollarSign, Hash, Percent, TrendingDown } from "lucide-react";

interface Props {
  overall: OverallStats;
}

export function StatCards({ overall }: Props) {
  const roiPct = (overall.roi * 100).toFixed(2);
  const winPct = (overall.winRate * 100).toFixed(1);
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
      <StatCard
        label="ROI"
        value={`${roiPct}%`}
        icon={TrendingUp}
        deltaTone={overall.roi >= 0 ? "positive" : "negative"}
      />
      <StatCard
        label="净收益"
        value={`$${overall.netPnl.toFixed(0)}`}
        icon={DollarSign}
        deltaTone={overall.netPnl >= 0 ? "positive" : "negative"}
      />
      <StatCard label="交易数" value={String(overall.totalTrades)} icon={Hash} />
      <StatCard label="胜率" value={`${winPct}%`} icon={Percent} />
      <StatCard
        label="最大回撤"
        value={`$${overall.maxDrawdown.toFixed(0)}`}
        icon={TrendingDown}
        deltaTone="negative"
      />
    </div>
  );
}
```

- [ ] **Step 3: empty-state.tsx**

Create:

```tsx
"use client";
import { History } from "lucide-react";

export function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full p-8 gap-4 text-center">
      <div className="h-12 w-12 rounded-xl bg-muted flex items-center justify-center">
        <History className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="max-w-md space-y-2">
        <h2 className="text-lg font-semibold text-foreground">还没有回测记录</h2>
        <p className="text-sm text-muted-foreground">
          用 CLI 跑第一次回测，页面会自动显示。
        </p>
      </div>
      <pre className="text-xs bg-muted/30 rounded px-3 py-2 text-foreground">
        pnpm tsx src/server/services/backtest/cli.ts --phase 0
      </pre>
      <pre className="text-xs bg-muted/30 rounded px-3 py-2 text-foreground">
        pnpm tsx src/server/services/backtest/cli.ts
      </pre>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck + commit**

```
pnpm tsc --noEmit
git add src/components/backtest/metadata-bar.tsx \
        src/components/backtest/stat-cards.tsx \
        src/components/backtest/empty-state.tsx
git commit -m "feat(backtest-ui): metadata bar + stat cards + empty state"
```

---

## Task 12: RunList + URL state

**Files:**
- Create: `src/components/backtest/run-list.tsx`

- [ ] **Step 1: 实现**

Create `src/components/backtest/run-list.tsx`:

```tsx
"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

interface Props {
  onSelect?: (id: string) => void;
}

export function RunList({ onSelect }: Props) {
  const search = useSearchParams();
  const currentId = search.get("run");
  const { data, isLoading } = trpc.backtest.list.useQuery();

  if (isLoading) {
    return (
      <aside className="w-60 border-r border-border p-3 text-xs text-muted-foreground">
        加载中...
      </aside>
    );
  }

  if (!data || data.length === 0) {
    return (
      <aside className="w-60 border-r border-border p-3 text-xs text-muted-foreground">
        （无历史记录）
      </aside>
    );
  }

  return (
    <aside className="w-60 border-r border-border overflow-y-auto">
      <ul>
        {data.map((run) => {
          const isSelected = run.id === currentId;
          const roiPct = (Number(run.roi) * 100).toFixed(2);
          const roiTone = Number(run.roi) >= 0 ? "text-positive" : "text-destructive";
          return (
            <li key={run.id}>
              <Link
                href={`/backtest?run=${run.id}`}
                onClick={() => onSelect?.(run.id)}
                className={cn(
                  "block border-l-2 px-3 py-3 hover:bg-accent transition-colors",
                  isSelected ? "border-primary bg-accent" : "border-transparent",
                )}
              >
                <div className="text-xs text-muted-foreground">
                  {new Date(run.startedAt).toISOString().slice(0, 16).replace("T", " ")}
                </div>
                <div className={cn("text-sm font-semibold", roiTone)}>
                  {Number(run.roi) >= 0 ? "+" : ""}
                  {roiPct}%
                </div>
                <div className="text-xs text-muted-foreground">
                  {run.totalTrades} trades
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```
pnpm tsc --noEmit
git add src/components/backtest/run-list.tsx
git commit -m "feat(backtest-ui): RunList with URL-based selection"
```

---

## Task 13: RunDetail + ChartGrid

**Files:**
- Create: `src/components/backtest/chart-grid.tsx`
- Create: `src/components/backtest/run-detail.tsx`

- [ ] **Step 1: chart-grid.tsx**

Create `src/components/backtest/chart-grid.tsx`:

```tsx
"use client";
import type { Aggregated } from "@/lib/backtest-aggregate";
import type { EquityCurvePoint } from "@/server/services/backtest/types";
import { EquityCurve } from "./charts/equity-curve";
import { DailyPnlHistogram } from "./charts/daily-pnl-histogram";
import { ByExchangePair } from "./charts/by-exchange-pair";
import { BySymbol } from "./charts/by-symbol";
import { FeePie } from "./charts/fee-pie";
import { HoldDuration } from "./charts/hold-duration";
import { Heatmap } from "./charts/heatmap";

interface Props {
  agg: Aggregated;
  equityCurve: EquityCurvePoint[];
}

export function ChartGrid({ agg, equityCurve }: Props) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <EquityCurve data={equityCurve} maxDrawdownDate={agg.overall.maxDrawdownDate} />
        <DailyPnlHistogram data={agg.dailyPnlHistogram} />
        <ByExchangePair data={agg.byExchangePair} />
        <BySymbol data={agg.bySymbol} />
        <FeePie totalFees={agg.overall.totalFees} netPnl={agg.overall.netPnl} />
        <HoldDuration data={agg.holdDurationBuckets} />
      </div>
      <Heatmap byDayOfWeek={agg.byDayOfWeek} byHourOfDay={agg.byHourOfDay} />
    </div>
  );
}
```

- [ ] **Step 2: run-detail.tsx**

Create `src/components/backtest/run-detail.tsx`:

```tsx
"use client";
import { trpc } from "@/lib/trpc";
import type { ClosedTrade, EquityCurvePoint } from "@/server/services/backtest/types";
import { aggregate } from "@/lib/backtest-aggregate";
import { MetadataBar } from "./metadata-bar";
import { StatCards } from "./stat-cards";
import { ChartGrid } from "./chart-grid";

interface Props {
  runId: string;
}

export function RunDetail({ runId }: Props) {
  const { data: run, isLoading, error } = trpc.backtest.get.useQuery({ id: runId });

  if (isLoading) {
    return <div className="p-8 text-sm text-muted-foreground">加载中...</div>;
  }
  if (error || !run) {
    return <div className="p-8 text-sm text-destructive">加载失败：{error?.message ?? "unknown"}</div>;
  }

  // Prisma JSON columns come through as `unknown` — cast to our known runtime shapes
  const closedTrades = (run.closedTrades as unknown as ClosedTrade[]).map((t) => ({
    ...t,
    openedAt: new Date(t.openedAt),
    closedAt: new Date(t.closedAt),
  }));
  const equityCurve = (run.equityCurve as unknown as EquityCurvePoint[]).map((p) => ({
    ...p,
    date: new Date(p.date),
  }));
  const initialCapital =
    typeof (run.config as { initialCapital?: number })?.initialCapital === "number"
      ? (run.config as { initialCapital: number }).initialCapital
      : 10_000;

  const agg = aggregate(closedTrades, equityCurve, initialCapital);

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <MetadataBar from={run.fromDate} to={run.toDate} config={run.config} />
      <StatCards overall={agg.overall} />
      <ChartGrid agg={agg} equityCurve={equityCurve} />
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + commit**

```
pnpm tsc --noEmit
git add src/components/backtest/chart-grid.tsx src/components/backtest/run-detail.tsx
git commit -m "feat(backtest-ui): RunDetail container + ChartGrid composition"
```

---

## Task 14: Main `/backtest` 页面

**Files:**
- Modify: `src/app/(dashboard)/backtest/page.tsx`（替换占位符）
- Create: `src/components/backtest/page.tsx`（client component wrapping RunList + RunDetail）

- [ ] **Step 1: client page component**

Create `src/components/backtest/page.tsx`:

```tsx
"use client";
import { useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { RunList } from "./run-list";
import { RunDetail } from "./run-detail";
import { EmptyState } from "./empty-state";

export function BacktestPage() {
  const search = useSearchParams();
  const urlRunId = search.get("run");
  const { data: runs, isLoading } = trpc.backtest.list.useQuery();

  if (isLoading) {
    return <div className="flex-1 p-8 text-sm text-muted-foreground">加载中...</div>;
  }
  if (!runs || runs.length === 0) {
    return (
      <div className="flex-1 flex">
        <EmptyState />
      </div>
    );
  }

  const selectedId = urlRunId ?? runs[0].id;

  return (
    <div className="flex-1 flex overflow-hidden">
      <RunList />
      <RunDetail runId={selectedId} />
    </div>
  );
}
```

- [ ] **Step 2: 替换 server page 占位符**

Overwrite `src/app/(dashboard)/backtest/page.tsx`:

```tsx
import { Suspense } from "react";
import { BacktestPage } from "@/components/backtest/page";

export default function Page() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-muted-foreground">加载中...</div>}>
      <BacktestPage />
    </Suspense>
  );
}
```

Suspense 是因为 BacktestPage 用 `useSearchParams` — Next 16 SSG 要求包在边界内，和 `/login` 同理。

- [ ] **Step 3: 冒烟**

启动 dev 环境若未启动：`./dev.sh`（另一个终端；已在跑则跳过）。登录后浏览器访问 `/backtest`：
- 若 `BacktestRun` 表为空 → EmptyState
- 若有数据 → 左列表 + 右详情

用 curl 直接测路由不 404：
```
curl -si http://localhost:3000/backtest 2>&1 | head -5
```
Expected: 307 to `/login` when no cookie (middleware L1), 200 when authenticated.

- [ ] **Step 4: Commit**

```
git add src/components/backtest/page.tsx src/app/\(dashboard\)/backtest/page.tsx
git commit -m "feat(backtest-ui): /backtest page wires list + detail with URL state"
```

---

## Task 15: 手动 E2E smoke

**Files:** none（验证，不 commit）

前置：一份真实 BacktestRun 数据。两种获取方式：

- [ ] **Option A: 跑一次极短回测（推荐，快）**

```
# 清库并 seed 一点点合成数据
docker compose exec postgres psql -U arbitrage -c "TRUNCATE backtest_runs, funding_rate_snapshots, funding_rate_hourly, ohlcv_snapshots, settlements, trade_logs, positions, opportunities, exchanges CASCADE;"

# 在容器内手动 insert 2 条 binance/okx exchange + 48h OHLCV + 5 个 funding rate（沿用 Plan 4 E2E test 的 seed pattern）
# 然后跑 CLI:
docker compose run --rm app pnpm tsx src/server/services/backtest/cli.ts \
  --from 2025-01-01T00:00:00Z --to 2025-01-03T00:00:00Z
```

跑完后 `pnpm prisma studio` 能看到 `backtest_runs` 里 1 行。

- [ ] **Option B: 手动 insert 一条行（最快）**

```
docker compose exec postgres psql -U arbitrage << 'EOF'
INSERT INTO backtest_runs (
  id, started_at, finished_at, from_date, to_date, config,
  total_trades, win_rate, roi, net_pnl, max_drawdown, sharpe_ratio,
  closed_trades, equity_curve, created_at
) VALUES (
  'c-smoke-001',
  NOW() - interval '1 day', NOW() - interval '1 day' + interval '1 minute',
  NOW() - interval '180 days', NOW(),
  '{"initialCapital":10000,"positionSize":500,"seed":"smoke"}'::jsonb,
  0, 0, 0, 0, 0, 0,
  '[]'::jsonb,
  '[{"date":"2025-10-21T00:00:00Z","equity":10000,"grossPnl":0,"netPnl":0,"totalFees":0}]'::jsonb,
  NOW()
);
EOF
```

- [ ] **验证清单**

浏览器里走一遍：

- [ ] 1. `/backtest` — 显示左侧 run 列表（1 条）+ 右侧详情
- [ ] 2. 点击 run 项 — URL 变 `/backtest?run=c-smoke-001`
- [ ] 3. 详情页 — MetadataBar 显示 from→to + 可展开 JSON；StatCards 显示 5 指标（0 trades 情况全零）；7 图表每个都有 container（有数据展示图、无数据显示"（无数据）"）
- [ ] 4. URL `/backtest?run=不存在` → 右侧 "加载失败" 错误（NOT_FOUND）
- [ ] 5. 清空 `backtest_runs` 表后刷新 → EmptyState 引导
- [ ] 6. 无痕窗口访问 `/backtest` → middleware 302 /login
- [ ] 7. curl `/api/trpc/backtest.list` 无 cookie → UNAUTHORIZED
- [ ] 8. curl `/api/trpc/backtest.get?input=...` + cookie → 正常数据

---

## 最终验收

所有跟 CI 相关的（都需要绿）：

- [ ] `pnpm lint` — 0 errors
- [ ] `pnpm tsc --noEmit` — clean
- [ ] `pnpm test tests/unit` — 127 + N passing（N ≈ 10 新测试：persist-run 3 + backtest-router list/get 7）
- [ ] `pnpm test tests/integration/backtest/end-to-end.test.ts` — 3 passing（Plan 4 的 3 个测试 + 新的断言扩展）
- [ ] `pnpm next build` — clean，`/backtest` 出现在 routes 清单，bundle 增量 ≤ 70KB gzipped

---

## Self-Review 备忘

- **Spec 覆盖**：§4.1 schema → T1；§4.3 aggregate 迁移 → T2；§4.4 persist-run → T3/T4；§4.2 backtestRouter → T5/T6；§4.6 chart components → T7/T8/T9/T10；§4.5 UI 组件 → T11/T12/T13/T14；§6.4 手动验证 → T15
- **占位扫描**：所有 step 都含具体代码或 shell 命令，无 "TBD"
- **类型一致**：`BacktestRun` 表字段 / `persistRun()` / `backtestRouter.list()` / `backtestRouter.get()` / `OverallStats` / `Aggregated` / `ClosedTrade` / `EquityCurvePoint` 在首次定义后始终保持同名同形
- **Plan 4 回归**：T2 的 aggregate 搬家 + T4 的 CLI 改动 可能影响 Plan 4 的 E2E 测试 — T4 Step 3 显式验证 3 个原有测试全过
