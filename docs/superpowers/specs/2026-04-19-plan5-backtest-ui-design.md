# Plan 5 Design — 回测 UI 集成 (Phase A: History Viewer)

**Date**: 2026-04-19
**Status**: Approved
**Scope**: 把 `/backtest` 页面从 Plan 1 的占位符变成历史回测报告 viewer —— 列出所有 run、点进去在 dashboard 里用 React + 图表展示结果。Phase A 仅 "UI 看"，Phase B（UI 触发 + BullMQ）留给下个 plan。

---

## 1. 背景

Plan 4 交付了离线回测引擎：CLI + 独立 HTML 报告（`docs/backtest-reports/<ts>/report.html`）。Spec §Q3 刻意把 `/backtest` 前端集成划出了 Plan 4 范围：

> 自包含 HTML 比前端页面集成简单得多：不需要新 Prisma 表、tRPC endpoint、UI state management；不需要 dev server；可邮件分享
>
> 前端 `/backtest` 页面**留给后续 plan**，等用过 HTML 版几次之后对"真正有用的图表"有更好的认知

v0.2.0 部署后在 Vultr 跑了 1 次 baseline（0 trades），已经验证 HTML 报告的价值是"自包含 + 可邮件"。现在的痛点是：
- 打开要翻 `docs/backtest-reports/` 找时间戳目录
- 多次 run 之间切换对比麻烦（要开多个浏览器 tab）
- 团队成员没法通过 URL 分享具体 run

Plan 5 Phase A 解决前两条，Phase B 再解决"UI 触发"。

---

## 2. 决策 & 讨论过程

### Q1. 触发模型

**备选**：
- A. UI 只看不触发，回测仍 CLI 跑
- B. UI 触发 + BullMQ 异步作业（worker 消费）
- C. UI 触发 + child_process spawn（简单但不可靠）
- D. Trigger 先不做，以后再说

**选择 A 作为 Phase A，B 作为 Phase B（两个独立可 ship 的 phase）**

**理由**：
1. 回测单次 30-60 分钟（Vultr 实测 45 分钟），同步 HTTP 不可能，必须异步
2. BullMQ 已经是项目核心依赖（Plan 1-2 用来跑 collector / health-check 等 worker），加 backtest queue 自然
3. 但异步队列 + worker + status UI + parameter form 是 2-3 天工作量，独立价值也大
4. "UI 看"是 1 天工作量，价值立刻兑现（打开报告不再翻文件系统）
5. Phase A 上线后先用几次积累 Phase B 的需求认知（哪些参数真的需要调？进度展示要多细？）

### Q2. 报告存储

**备选**：
- A. 数据库（新 `BacktestRun` 表存配置 + 预聚合指标 + 明细 JSON）
- B. 文件系统扫描 `docs/backtest-reports/`
- C. 混合（DB 存 metadata，文件系统存明细）

**选择 A（DB 全存）**

**理由**：
1. 生产镜像是 standalone build，没有 `docs/` 目录挂载 —— 方案 B 在生产上不可用
2. tRPC 列表查询要按时间排序、筛选，SQL 天然擅长，文件系统要扫目录 + 解析 JSON
3. 明细数据（6 个月 equity curve + 所有 trades）压缩后 < 100KB，放 JSON 列无压力
4. 文件报告（HTML/MD/CSV）照旧写到 `docs/backtest-reports/<ts>/`，UI 不读它们 —— 用户需要离线分享时还能用

### Q3. 图表库

**备选**：
- A. recharts（项目已在用）+ @visx/heatmap 单点补热力图
- B. 全部换 Nivo（按图表类型引 @nivo/line 等）
- C. 全部 visx 重写
- D. 引回 ECharts（和 Plan 4 HTML 报告一致）

**选择 A**

**理由**：
1. recharts 已经在 dashboard 用了（Plan 1），加一个 backtest 页继续用一致性强
2. recharts 覆盖 6/7 图表轻松（line/bar/pie 基础齐全），弱项是热力图
3. 单独引 `@visx/heatmap`（~50KB gzipped）填热力图，总包增量可控
4. 引回 ECharts（~300KB）会让 bundle 跳一档且全站图表库分裂
5. Nivo 最丰富但包重且第二套图表库心智负担

### Q4. 前端聚合 vs 后端聚合

**备选**：
- A. 后端预聚合 6 指标 + 明细原样，前端再用 `aggregate.ts` 跑一次分组聚合
- B. 后端跑完整 aggregate（所有分组），前端直接渲染
- C. 后端按表存每种分组（多表拆分）

**选择 A**

**理由**：
1. `aggregate.ts` 是纯函数无副作用，server/client 共用没问题
2. 6 月 × 5 min tick 的 equityCurve 约 180 个点 + 最多 100 个 trades，前端聚合耗时 < 10ms
3. 后端存明细 = 所有分析字段都是派生的，将来加新分组（比如 "by leverage" 或 "by hold bucket v2"）无需迁移数据库
4. 把 `aggregate.ts` 从 `src/server/services/backtest/reporter/` 挪到 `src/lib/backtest-aggregate.ts` 作为 server/client 共用模块

---

## 3. 架构总览

3 层数据流：

```
runner.ts (CLI 跑完, writeReport)
   ↓ persist-run.ts (新增)
Postgres.BacktestRun (新表)
   ↓ tRPC backtestRouter.list / get
dashboard /backtest 页面 (server component + client components)
   ↓ src/lib/backtest-aggregate.ts (前端聚合)
recharts 6 图 + visx 热力图
```

### 3.1 数据模型

新增 `BacktestRun`：
- 预聚合的 6 个核心 metric 作为列（totalTrades / winRate / roi / netPnl / maxDrawdown / sharpeRatio）—— 列表页快速排序/过滤
- `config` Json 列存完整 `BacktestConfig` 快照
- `closedTrades` + `equityCurve` Json 列存明细 —— 详情页一次拉出
- 不存 HTML/MD/CSV 文件路径 —— 生产容器没这些目录，文件系统报告仅供 dev 用户参考

### 3.2 tRPC 接口

两个 procedure，都 `protectedProcedure`：
- `backtest.list` — `Array<{id, startedAt, from, to, totalTrades, roi, netPnl, winRate}>`，按 `startedAt desc`，可选 `limit` 参数（默认 50）
- `backtest.get({ id })` — 完整 `BacktestRun` 行（含 JSON 明细）

### 3.3 写入路径

CLI → runBacktest → writeReport 原样写 4 个文件 → **新增**：在 cli.ts 里调 `persistRun(prisma, result)` 写一行进 `BacktestRun`。

不让 reporter 依赖 prisma（保持纯函数），由 CLI 层在 aggregate 之后自己调。

### 3.4 UI 路由

`/backtest`：
- 默认：选最新 run 展示
- `/backtest?run=<id>`：深链到具体 run
- 未登录：middleware 302 /login（全站一致）
- 空状态：无 run 时显示引导卡片 + CLI 命令示例

---

## 4. 组件设计

### 4.1 Prisma schema

```prisma
model BacktestRun {
  id           String   @id @default(cuid())
  startedAt    DateTime @map("started_at")
  finishedAt   DateTime @map("finished_at")
  fromDate     DateTime @map("from_date")
  toDate       DateTime @map("to_date")
  config       Json                                      // BacktestConfig 快照

  // 预聚合的核心指标
  totalTrades  Int      @map("total_trades")
  winRate      Decimal  @db.Decimal(6, 4) @map("win_rate")
  roi          Decimal  @db.Decimal(10, 6)
  netPnl       Decimal  @db.Decimal(18, 4) @map("net_pnl")
  maxDrawdown  Decimal  @db.Decimal(18, 4) @map("max_drawdown")
  sharpeRatio  Decimal  @db.Decimal(10, 4) @map("sharpe_ratio")

  // 明细
  closedTrades Json     @map("closed_trades")
  equityCurve  Json     @map("equity_curve")

  createdAt    DateTime @default(now()) @map("created_at")

  @@index([startedAt])
  @@map("backtest_runs")
}
```

Migration：`prisma migrate dev --name backtest_run`。

### 4.2 tRPC backtestRouter

```ts
export const backtestRouter = router({
  list: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(500).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.prisma.backtestRun.findMany({
        orderBy: { startedAt: "desc" },
        take: input?.limit ?? 50,
        select: {
          id: true, startedAt: true, fromDate: true, toDate: true,
          totalTrades: true, winRate: true, roi: true, netPnl: true,
        },
      });
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.backtestRun.findUniqueOrThrow({ where: { id: input.id } });
    }),
});
```

挂到 `src/server/api/root.ts`。

### 4.3 Aggregate 模块迁移

`src/lib/backtest-aggregate.ts`（纯函数，无 import 副作用，可 server + client 共用）：

把 `src/server/services/backtest/reporter/aggregate.ts` 整体挪过去，保持同样的导出名（`aggregate`、`OverallStats`、`GroupStat`、`Aggregated`、`histogram`）。原来的 reporter 路径改成 `export * from "@/lib/backtest-aggregate"`，保持向后兼容。

### 4.4 Persist run

`src/server/services/backtest/reporter/persist-run.ts`（新增）：

```ts
import type { PrismaClient } from "@prisma/client";
import type { BacktestResult } from "@/server/services/backtest/types";
import { aggregate } from "@/lib/backtest-aggregate";

export async function persistRun(prisma: PrismaClient, result: BacktestResult): Promise<string> {
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

CLI 里调用：

```ts
// src/server/services/backtest/cli.ts 加
import { prisma } from "@/server/db/client";
import { persistRun } from "./reporter/persist-run";
// ... after writeReport:
const runId = await persistRun(prisma, result);
console.log(`[bt] persisted run ${runId}`);
```

### 4.5 UI 组件

**`/backtest` 页面**（`src/app/(dashboard)/backtest/page.tsx`）：
替换现有占位符，改成 client component 的 wrapper 传入 `searchParams.run`。

```tsx
import { BacktestPage } from "@/components/backtest/page";

export default function Page({ searchParams }: { searchParams: { run?: string } }) {
  return <BacktestPage initialRunId={searchParams.run} />;
}
```

**布局**：左侧 240px RunList + 右侧 RunDetail。移动端 stack（先 RunList 再 RunDetail）。

**RunList**：
```tsx
const { data } = trpc.backtest.list.useQuery();
// 每行：时间（相对 / 绝对 hover）| ROI 绿红 | "N trades"
// 点击更新 URL router.replace(`/backtest?run=${id}`, { scroll: false })
// 当前选中行加左边 primary 色竖条
```

**RunDetail**：
```tsx
const { data: run } = trpc.backtest.get.useQuery({ id: runId });
if (!run) return <LoadingSkeleton />;
const agg = aggregate(run.closedTrades, run.equityCurve, run.config.initialCapital);
return (
  <>
    <MetadataBar from={run.fromDate} to={run.toDate} config={run.config} />
    <StatCards overall={agg.overall} />
    <ChartGrid agg={agg} equityCurve={run.equityCurve} maxDrawdownDate={agg.overall.maxDrawdownDate} />
  </>
);
```

**ChartGrid**：7 个 chart 组件按 2 列 3-4 行排列，最底部 Heatmap 全宽。

**空状态**：`data?.length === 0` 时 `<EmptyState />` 显示 CLI 命令 + 引导文字。

### 4.6 Chart 组件

每个图表是独立 `"use client"` 组件，接受聚合数据作为 props。示例：

```tsx
// src/components/backtest/charts/equity-curve.tsx
"use client";
import { LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from "recharts";
import type { EquityCurvePoint } from "@/server/services/backtest/types";

export function EquityCurve({ data, maxDrawdownDate }: { data: EquityCurvePoint[]; maxDrawdownDate: Date | null }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data.map((p) => ({ date: p.date.getTime(), equity: p.equity }))}>
        <XAxis dataKey="date" tickFormatter={(ms) => new Date(ms).toISOString().slice(5, 10)} />
        <YAxis domain={["auto", "auto"]} tickFormatter={(v) => `$${v}`} />
        <Tooltip labelFormatter={(ms) => new Date(ms).toISOString().slice(0, 10)} />
        <Line type="monotone" dataKey="equity" stroke="hsl(var(--primary))" dot={false} />
        {maxDrawdownDate && <ReferenceLine x={maxDrawdownDate.getTime()} stroke="hsl(var(--destructive))" strokeDasharray="3 3" />}
      </LineChart>
    </ResponsiveContainer>
  );
}
```

其它 5 个 recharts 图表类似，逻辑从 Plan 4 的 `html-template.ts` 直接翻译。

**Heatmap**：`@visx/heatmap` 做 24 小时 × 7 天的双重网格。数据取自 `agg.byDayOfWeek` + `agg.byHourOfDay` 的笛卡尔组合（保持和 html-template 同样的简化逻辑）。

### 4.7 新增依赖

```json
{
  "dependencies": {
    "@visx/heatmap": "^3.x",
    "@visx/scale": "^3.x",
    "@visx/group": "^3.x"
  }
}
```

gzipped 合计 ~60KB。

---

## 5. 数据迁移

v0.2.0 baseline 已经存在于 `docs/backtest-reports/example/`。迁移策略：

**不迁移**。example/ 是 0 trades 的空报告，导进 UI 也显示不出意义。Plan 5 上线后，跑一次新回测（用作 Phase A 的 E2E 烟测）就自动有数据。

如果将来有价值的历史报告需要入库，再单独写 `scripts/import-legacy-backtest.ts`。

---

## 6. 测试策略

### 6.1 单元测试

- `tests/unit/backtest-aggregate.test.ts` — 把原 `tests/unit/backtest/aggregate.test.ts` 搬到新路径（import path 改），加 3-4 个分组断言（byExchangePair / byHourOfDay / byDayOfWeek / holdDurationBuckets）
- `tests/unit/trpc/backtest-router.test.ts`（新）— list 返回按 startedAt desc + 分页、get 返回完整行、未登录 UNAUTHORIZED

### 6.2 集成测试

- `tests/integration/backtest-persistence.test.ts`（新）— 跑一次 mini `runBacktest()`（48h 合成数据，复用 Plan 4 E2E 的 seed 模式）→ CLI 写入 BacktestRun → `trpc.backtest.list` 返回一条、`trpc.backtest.get` 返回完整行
- **回归**：Plan 4 的 `tests/integration/backtest/end-to-end.test.ts` 仍绿，并加一条断言：写入后 `BacktestRun` 表多一行

### 6.3 前端测试

项目目前没有 React 组件测试基础设施。Plan 5 不引入，靠手动 E2E。

### 6.4 手动 E2E 验收清单（dev 环境）

```
1. ./dev.sh 启动 + 登录
2. 浏览器 /backtest → 空状态引导卡片
3. pnpm tsx src/server/services/backtest/cli.ts --from <short> --to <short>
   （缩小窗口到 2 天让 runner 快出结果；需要 funding_rate_snapshots 里有数据，
   可先 pnpm tsx src/server/services/backtest/data-loader/cli.ts --from ... --to ...）
4. 浏览器刷新 /backtest → 列表出现 1 条
5. 点开 → 5 cards + 7 图表渲染
6. 切换 URL ?run=<另一个 id> → 右侧切换
7. 配置 JSON 展开/折叠正常
8. 无痕窗口直接打开 /backtest → middleware 302 /login
9. curl /api/trpc/backtest.list 无 cookie → UNAUTHORIZED
10. curl -H 'Origin: https://evil.example' -X POST /api/trpc/backtest.get → FORBIDDEN（CSRF）
```

---

## 7. 实施顺序（writing-plans 拆任务粒度）

1. Prisma schema + migration（BacktestRun）
2. Aggregate 模块迁移到 `src/lib/backtest-aggregate.ts` + 更新现有 import 路径 + 现有测试跑绿
3. persist-run.ts + CLI 集成 + 集成测试
4. backtestRouter + 挂到 root + unit tests
5. 新增 @visx 依赖 + chart components（7 个）
6. `/backtest` 页面（RunList + RunDetail + MetadataBar + StatCards + ChartGrid + EmptyState）
7. URL state（?run= 深链）
8. 手动 E2E

约 1 天工作量。

---

## 8. 验收标准

Phase A 完成的标志 —— 所有这些都要满足：

1. Prisma `BacktestRun` 表已建、migration 可应用
2. CLI 跑完回测后，`BacktestRun` 表多一行，6 metric + config + closedTrades + equityCurve 字段正确
3. `trpc.backtest.list` 返回列表，按时间倒序
4. `trpc.backtest.get(id)` 返回完整行
5. `/backtest` 页面列出所有 run，点开显示 5 cards + 7 图表
6. 空状态显示 CLI 引导
7. URL `?run=<id>` 深链到指定 run
8. 未登录访问 `/backtest` → 302 /login
9. CI 绿（lint 0 errors + tsc + 所有测试 + next build）
10. bundle 增量 ≤ 70KB gzipped

---

## 9. 明确不在 Phase A 范围

- **UI 触发回测按钮** → Phase B
- **参数表单** → Phase B
- **BullMQ backtest queue + worker** → Phase B
- **运行中状态展示 / 进度 poll** → Phase B
- **对比多个 run（两个 run 图表叠加）** → Plan 6+
- **参数扫描（一次跑多组）** → Plan 6+
- **回测报告导出（下载 HTML/CSV）** → Plan 6+（目前 CLI 已经生成文件）
- **React 组件测试基础设施** → 独立 PR
- **"Run backtest" 按钮在仪表板其它位置出现（比如 Opportunities 页直接跑）** → Plan 6+

---

## 10. Phase B 预告（下个 spec 时写）

Phase A 的数据模型其实已经给 Phase B 留了口子：

- `BacktestRun` 表加 `status: enum(pending, running, done, failed)` + `errorMessage: String?` 字段
- Reporter 的 persist 拆成"先写 pending 行 → 跑完 update 状态"两步
- 新增 `backtest.enqueue` mutation：建 pending row → `backtestQueue.add(jobData, { runId })`
- 新 worker `src/server/jobs/backtest-worker.ts`：消费队列 → `runBacktest(config)` → persist 结果 + update status
- UI RunList 加状态 badge（运行中的转圈）
- "Run Backtest" 按钮组件 + 参数表单（6-7 个核心字段 + Advanced 折叠块放其它）

Phase A 落地稳定后单独开 Plan 6 spec。

---

## 11. 关键文件索引

| 改动类型 | 路径 |
|---|---|
| 新建 | `prisma/schema.prisma`（+BacktestRun model） |
| 新建 | `prisma/migrations/<ts>_backtest_run/` |
| 新建 | `src/lib/backtest-aggregate.ts`（从 reporter/aggregate.ts 搬） |
| 新建 | `src/server/services/backtest/reporter/persist-run.ts` |
| 新建 | `src/server/api/routers/backtest.ts` |
| 新建 | `src/app/(dashboard)/backtest/page.tsx`（替换占位符） |
| 新建 | `src/components/backtest/{run-list,run-detail,metadata-bar,stat-cards,empty-state,page}.tsx` |
| 新建 | `src/components/backtest/charts/{equity-curve,daily-pnl-histogram,by-exchange-pair,by-symbol,fee-pie,hold-duration,heatmap}.tsx` |
| 修改 | `src/server/services/backtest/reporter/aggregate.ts`（re-export from @/lib/backtest-aggregate） |
| 修改 | `src/server/services/backtest/cli.ts`（调 persistRun） |
| 修改 | `src/server/api/root.ts`（挂 backtestRouter） |
| 修改 | `tests/integration/backtest/end-to-end.test.ts`（+ 断言 DB 行写入） |
| 新增测试 | `tests/unit/trpc/backtest-router.test.ts` |
| 新增测试 | `tests/integration/backtest-persistence.test.ts` |
| 新增依赖 | `@visx/heatmap`, `@visx/scale`, `@visx/group` |

---

## 12. 复用现有工具

- [`src/server/services/backtest/reporter/aggregate.ts`](src/server/services/backtest/reporter/aggregate.ts) — 搬到 `src/lib/` 继续用，所有分组逻辑复用
- [`src/components/ui/stat-card.tsx`](src/components/ui/stat-card.tsx) — Plan 1 时建的 stat card，复用作 5 个核心指标卡
- [`src/components/trpc-provider.tsx`](src/components/trpc-provider.tsx) — 已有全局 401→login 兜底，无需改
- Plan 4 的 `BacktestConfig / ClosedTrade / EquityCurvePoint` 类型（`src/server/services/backtest/types.ts`） — 数据库 JSON 列就存这些结构
- recharts（项目已在用）
