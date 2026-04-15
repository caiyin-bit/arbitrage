# Plan 4 Design — 回测引擎（Backtest Engine）

**Date**: 2026-04-15
**Status**: Approved
**Scope**: 构建一套离线回测引擎，用历史资金费率 + OHLCV 数据验证资金费率套利策略的真实收益。不含前端 `/backtest` 页面集成、参数扫描、实时回测等，这些留给后续 plan。

---

## 1. 背景与目标

### 1.1 为什么现在做回测

Plan 1-3 已经完成：

- **Plan 1**: 数据采集 + `detector.findOpportunities()` 的纯函数策略
- **Plan 2**: 执行器（三层 idempotency / rescue / volatility pause / settlement）+ 通知
- **Plan 3**: CI/CD + 生产部署（Vultr Tokyo 已跑起来）

但**策略本身从未在历史数据上验证过**。当前 detector 的核心逻辑：

```typescript
const spread = maxRate.currentRate - minRate.currentRate;
const annualizedYield = spread * (24 / intervalHours) * 365;
if (annualizedYield >= config.minAnnualizedYield) emit opportunity
```

这个公式假设"资金费率的价差会转化为实际收益"，但实盘里要扣除手续费、滑点、订单失败率、volatility pause 等开销。**不回测直接上实盘 = 花钱买经验**。

### 1.2 目标

- 用 ccxt 拉 3 个主要交易所（Binance / OKX / Bybit）× 5 个币种（BTC/ETH/SOL/BNB/XRP）× 6 个月的历史数据
- 构建一套模拟器，把**生产 executor 代码**（Plan 2 写的）以依赖注入方式复用到回测路径
- 跑完后产出一份可读的 HTML 报告（7 张图表）+ Markdown 摘要 + CSV 原始数据
- 有一个 **Phase 0 sanity check** 作为 go/no-go gate：大工作投入之前先用极简方式验证"历史数据里有没有正收益信号"

### 1.3 不在 Plan 4 范围

- 前端 `/backtest` 页面接入（HTML 独立文件就够了）
- 参数扫描 / grid search
- Monte Carlo bootstrap
- 实时回测（跑到当天数据）
- 支持 > 3 家交易所
- Kelly 仓位算法
- BullMQ worker 集成（回测是 CLI 离线工具）

### 1.4 前置事实

- Plan 1 的 `FundingRateSnapshot` 表已存在（字段：`exchangeId`、`symbol`、`currentRate`、`collectedAt`、`intervalHours`），可直接复用存历史数据
- Plan 2 的 executor 目录 `src/server/services/executor/` 下所有文件当前都直接 `import { prisma }` / `import { redis }`，**这是 Plan 4 最大的改动点**
- Plan 3 上线后生产跑在 Vultr Tokyo，任何 executor 改动都要经过生产 smoke test

---

## 2. 决策 & 讨论过程

本节记录 brainstorm 阶段 Q1-Q5 的每个决策点，包括考虑过的备选、最终选择、以及选择理由。未来重读时能快速理解"为什么选 X 而不是 Y"。

### Q1. 历史数据来源

**备选**：
- A. 交易所官方 API（5 个适配器 × 自己实现）
- B. ccxt 的 `fetchFundingRateHistory`（统一接口）
- C. 第三方数据聚合（CoinGlass 等，收费）
- D. Kaggle 开源数据集
- E. 只做单交易所 POC

**选择 B + 限定 Binance/OKX/Bybit 三家**

**理由**：
1. ccxt 已经是项目的核心依赖，一致性高
2. 这三家交易所在资金费率套利场景里覆盖 ~70% 的真实机会
3. Gate.io 和 HTX 边际价值低，Plan 4 不做，将来需要时用同样模板扩展
4. 历史资金费率是**公开 endpoint**，不需要 API key，loader 可以在没配 key 的机器上运行（包括 CI 环境）
5. 单交易所 POC（选项 E）**在统计上没意义**：资金费率套利的本质是"跨交易所对冲"，单个交易所的历史序列没法模拟真实套利

---

### Q2. 回测引擎的执行模型

**备选**：
- A. 复用生产 executor 代码（DI 重构 + fake 依赖）
- B. 独立写一个简化模拟器（两份代码）
- C. 纯策略回测（忽略所有执行复杂度）

**选择 A + C 作为 Phase 0**

**理由**：
1. **方案 B 的致命问题是 drift** —— 任何时候生产 executor 改手续费计算 / rescue 逻辑 / 滑点处理，回测必须手动同步。几个月后实盘和回测一定会对不上
2. Plan 2 的 executor 代码是工程价值最高的资产（三层 idempotency、rescue、volatility pause 等），重新写一份等于白白丢掉
3. **依赖注入重构是对生产代码的正向投入**，重构后 executor 也变得可单元测试（不需要 `docker compose up postgres`）
4. **方案 C 作为 Phase 0 sanity check 有独立价值**：< 200 行代码 5 秒出结果，是"要不要投入方案 A 重构"的 go/no-go 决策点

**Phase 0 的 gate 含义**：
- Phase 0 显示正收益信号（理论 ROI > 10%）→ 继续完整 runner
- Phase 0 显示零或负收益 → **停下来重新设计策略**，不要盲目继续投入 DI 重构
- Phase 0 微弱正收益（0-10%）→ 继续但调低预期

---

### Q3. 回测报告输出格式

**备选**：
- A. 精简版（5 个核心指标，terminal 输出）
- B. 标准版（指标 + 拆分 + markdown/CSV）
- C. 完整版（前端页面 + 图表）
- D. 文字 + 单张净值曲线

**选择 B + 图表丰富化**

**最终形态**：
- `report.html` 自包含（内嵌 ECharts CDN，7 张图表）
- `report.md` 文字摘要（可 git 追踪）
- `trades.csv` 每笔持仓原始数据
- `daily.csv` 每日聚合

**7 张图表**：
1. 账户净值曲线（叠加回撤阴影）
2. 每日收益分布直方图
3. 按交易所对拆分 P&L（水平条形）
4. 按币种拆分 P&L
5. 手续费 vs 净收益 饼图
6. 持仓时长分布（柱状图）
7. 按"星期 × 小时"的机会热力图

**理由**：
1. **自包含 HTML** 比前端页面集成简单得多：不需要新 Prisma 表、tRPC endpoint、UI state management；不需要 dev server；可邮件分享
2. **Markdown 文件可 git 追踪**是核心价值 —— 下次回测后 `git diff` 看 ROI 变化
3. **CSV 导出**给 Excel/Python 做深度分析留出口子
4. 前端 `/backtest` 页面**留给后续 plan**，等用过 HTML 版几次之后对"真正有用的图表"有更好的认知

---

### Q4. 模拟保真度

| 项 | 选择 | CLI flag |
|---|---|---|
| 4.1 手续费 | 用 `Exchange.feeRate` 表的真实值 | — |
| 4.2 滑点 | 固定 3 bps | `--slippage-bps` |
| 4.3 订单失败率 | 2% 随机 + seeded PRNG | `--failure-rate`, `--seed` |
| 4.4 Volatility pause | 启用，用 1h K 线的 high/low 近似 | `--no-vol-pause` |
| 4.5 Funding payment | 直接读历史费率，不复用 settlement monitor | — |

**设计原则**：每项都能通过 CLI flag 关闭，方便跑"最好情况 vs 最差情况"的对比回测。

**订单失败率的 seeded PRNG**：用固定 seed 让回测**结果完全可重复**。同一份历史数据跑两次，每一笔订单是否失败、哪一笔触发 rescue，都必须完全相同。这是回测可信度的基石。

---

### Q5. 回测参数默认值

| 项 | 默认值 | CLI flag |
|---|---|---|
| 时间范围 | 最近 6 个月 | `--from`, `--to` |
| 初始资金 | $10,000 | `--capital` |
| 单次仓位 | 固定 $500 | `--size` |
| 并发仓位上限 | 3 | `--max-concurrent` |

**选固定仓位而不是 % of equity**：Plan 4 的目标是**验证策略有没有 edge**，不是调仓位算法。固定仓位让不同时段的 P&L 可直接比较。复利 / Kelly / 其它仓位算法是将来的事。

**并发仓位上限 3**：防"开仓潮"。你只有 5 个币可做，全开就是全仓，风险集中。3 个是风控合理边界。

---

## 3. 整体架构

### 3.1 数据流

```
  历史数据加载器
    ↓ (ccxt 拉 6 个月数据)
  Postgres
    ├─ FundingRateSnapshot  (复用 Plan 1 表)
    └─ OhlcvSnapshot        (Plan 4 新增)
    ↓ (回测读取)
  Backtest Runner
    ├─ VirtualClock
    ├─ HistoricalAdapter  (实现 ExchangeAdapter 接口)
    ├─ InMemoryStore      (实现 PositionStore 接口)
    ├─ Seeded PRNG        (失败率)
    └─ SlippageModel
    ↓ (主循环顺序处理事件)
  生产 Executor 函数
    ├─ executeOpen(ctx, params)
    ├─ executeClose(ctx, params)
    ├─ rescue 逻辑
    └─ ...
    ↓ (ctx 里的 fake store 收集状态)
  BacktestResult
    ├─ ClosedTrade[]
    └─ EquityCurvePoint[]
    ↓
  Report Generator
    ↓
  docs/backtest-reports/<timestamp>/
    ├─ report.html   (ECharts × 7 图表)
    ├─ report.md     (文字摘要, git 追踪)
    ├─ trades.csv    (每笔交易)
    └─ daily.csv     (每日聚合)
```

### 3.2 四个子系统的职责

| # | 模块 | 输入 | 输出 | 依赖 |
|---|---|---|---|---|
| 1 | 数据加载器 | 空 DB + ccxt | 填满的 `FundingRateSnapshot` + `OhlcvSnapshot` | ccxt, prisma |
| 2 | Executor DI 重构 | — | 接受 ctx 参数的 executor 函数 | 只依赖接口定义 |
| 3 | Backtest Runner | 历史数据 + CLI 参数 | `ClosedTrade[]` + `EquityCurvePoint[]` | executor 函数、接口内存实现 |
| 4 | 报告生成器 | `BacktestResult` | HTML + MD + CSV 文件 | 无外部依赖（纯函数） |

**关键解耦**：
- ② 对 ③ 是前置依赖，但 ② 本身是独立的、对生产代码有正向收益的重构
- ① 和 ③ 通过 Prisma 表解耦
- ④ 和 ③ 通过数据结构解耦

### 3.3 目录结构

```
src/server/services/
├── backtest/                       (新增)
│   ├── data-loader/
│   │   ├── funding-rate-loader.ts
│   │   ├── ohlcv-loader.ts
│   │   ├── loader.ts
│   │   └── cli.ts
│   ├── runner/
│   │   ├── virtual-clock.ts
│   │   ├── historical-adapter.ts
│   │   ├── in-memory-store.ts
│   │   ├── in-memory-redis.ts
│   │   ├── failure-injector.ts
│   │   ├── slippage.ts
│   │   ├── timeline.ts
│   │   └── runner.ts
│   ├── reporter/
│   │   ├── aggregate.ts
│   │   ├── html-template.ts
│   │   ├── markdown-template.ts
│   │   ├── csv-writer.ts
│   │   └── reporter.ts
│   ├── types.ts
│   ├── phase0-sanity-check.ts
│   └── cli.ts
│
├── executor/                       (现有, 做 DI 重构)
│   ├── types.ts                    (+ PositionStore / Clock / RedisLike 等)
│   ├── context-prod.ts             (新增)
│   ├── prisma-position-store.ts    (新增)
│   └── (其余文件签名改为 ctx: ExecutorContext)
│
prisma/
├── schema.prisma                   (+ OhlcvSnapshot model, + unique)
└── migrations/
    ├── 1_ohlcv_snapshot/
    └── 2_funding_snapshot_unique/

docs/
└── backtest-reports/
    └── example/                    (第一次跑通后手动 commit 作为 baseline)
```

---

## 4. 组件设计

### 4.1 历史数据加载器

**数据源**：ccxt 的 `fetchFundingRateHistory` 和 `fetchOHLCV`，公开 endpoint 不需要 API key。

**数据量估算**：
- 资金费率: 6 个月 × 每 8h 1 次 × 5 币种 × 3 交易所 = ~8,200 条
- OHLCV 1h: 6 个月 × 24h × 5 × 3 = ~65,800 条
- 合计 ~7 MB，Postgres 毫无压力

**Schema 改动**：

```prisma
model OhlcvSnapshot {
  id          String   @id @default(uuid())
  exchangeId  String   @map("exchange_id")
  symbol      String
  timeframe   String   // "1h"
  openTime    DateTime @map("open_time")
  open        Decimal  @db.Decimal(20, 8)
  high        Decimal  @db.Decimal(20, 8)
  low         Decimal  @db.Decimal(20, 8)
  close       Decimal  @db.Decimal(20, 8)
  volume      Decimal  @db.Decimal(30, 8)

  exchange    Exchange @relation(fields: [exchangeId], references: [id])

  @@unique([exchangeId, symbol, timeframe, openTime])
  @@index([symbol, openTime])
  @@map("ohlcv_snapshots")
}
```

**且 `FundingRateSnapshot` 需要加一个 unique constraint**（支持 loader 的 `createMany + skipDuplicates`）：

```prisma
model FundingRateSnapshot {
  // ... 已有字段
  @@unique([exchangeId, symbol, collectedAt])  // 新增
}
```

**Loader 伪代码**：

```typescript
async function loadFundingRateHistory(
  adapter: ccxt.Exchange,
  exchangeId: string,
  symbol: string,
  from: Date,
  to: Date,
): Promise<{ inserted: number; skipped: number }> {
  let since = from.getTime();
  while (since < to.getTime()) {
    const batch = await adapter.fetchFundingRateHistory(symbol, since, 1000);
    if (batch.length === 0) break;
    await prisma.fundingRateSnapshot.createMany({
      data: batch.map(r => ({ exchangeId, symbol, /* ... */ })),
      skipDuplicates: true,
    });
    since = batch[batch.length - 1].timestamp! + 1;
    await sleep(adapter.rateLimit ?? 200);
  }
}
```

**CLI**：`pnpm tsx src/server/services/backtest/data-loader/cli.ts [--from ...] [--to ...] [--symbols ...]`

**耗时预估**：3 交易所 × 5 币种 × (funding + ohlcv) × ~400ms × 分页 = 2-4 分钟

---

### 4.2 Executor 依赖注入重构

**范围**：只改 `src/server/services/executor/` 目录 + 调用它的 routers / workers 的构造 ctx 方式。

**新接口定义**（`src/server/services/executor/types.ts` 新增）：

```typescript
export interface ExecutorContext {
  store: PositionStore;
  redis: RedisLike;
  adapterFor: (exchange: string) => ExchangeAdapter;
  clock: Clock;
  random: () => number;
  log: (msg: string) => void;
}

export interface PositionStore {
  createPosition(data: PositionCreateInput): Promise<Position>;
  updatePosition(id: string, data: PositionUpdateInput): Promise<Position>;
  findPosition(id: string): Promise<Position | null>;
  listOpenPositions(): Promise<Position[]>;
  createTradeLog(data: TradeLogCreateInput): Promise<TradeLog>;
  listTradeLogs(positionId: string): Promise<TradeLog[]>;
  createSettlement(data: SettlementCreateInput): Promise<Settlement>;
  // 只暴露 executor 真正用到的操作, 不是整个 Prisma API
}

export interface Clock {
  now(): Date;
}

export interface RedisLike {
  set(key: string, value: string, mode: "NX" | "XX", ttl: number): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}
```

**改动模式示例**：

```typescript
// 改前
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";

export async function executeOpen(params: OpenParams): Promise<...> {
  const lock = await redis.set(`idem:lock:${params.idemKey}`, "1", "NX", 300);
  const position = await prisma.position.create({ data: {...} });
}

// 改后
import type { ExecutorContext, OpenParams } from "./types";

export async function executeOpen(
  ctx: ExecutorContext,
  params: OpenParams,
): Promise<...> {
  const lock = await ctx.redis.set(`idem:lock:${params.idemKey}`, "1", "NX", 300);
  const position = await ctx.store.createPosition({...});
}
```

**生产入口接线**：

```typescript
// src/server/services/executor/context-prod.ts (新增)
export async function buildProdContext(): Promise<ExecutorContext> {
  return {
    store: new PrismaPositionStore(prisma),
    redis,
    adapterFor: (name) => /* decrypted adapter */,
    clock: { now: () => new Date() },
    random: Math.random,
    log: console.log,
  };
}

// src/server/api/routers/position.ts
const ctx = await buildProdContext();
const result = await executeOpen(ctx, {...});
```

**不改的部分**：tRPC routers（应用层入口）、collector、detector（已是纯函数）、monitor workers（独立子系统）。

**Phase 拆分**：
- **2A**: 新增 types.ts + PrismaPositionStore + buildProdContext（纯加法，不动旧代码）
- **2B**: 逐个改 executor 函数签名 + 调用方改传 ctx
- **2C**: 删除旧的 `import prisma` / `import redis` 残留

每个阶段都可回滚。Phase 2B 必须每改一个函数立即跑单元测试。

---

### 4.3 Backtest Runner

#### 4.3.1 事件驱动模型

真实系统有 3 个后台 worker：funding collection / health check / settlement monitor。回测把它们转成**事件队列**：

```typescript
type VirtualEvent =
  | { type: 'funding_collection'; at: Date }
  | { type: 'health_check'; at: Date }
  | { type: 'settlement'; at: Date; symbol: string; exchange: string; fundingRate: number };
```

**事件构造**：
- funding collection: 每 5 分钟一次（和生产一致）
- health check: 每 5 分钟一次（生产是 30s，简化为 5min 是为了回测速度，`--health-interval-sec` 可覆盖）
- settlement: **从 `FundingRateSnapshot` 表的历史数据派生**，保证和真实结算时间一致

#### 4.3.2 主循环

```typescript
async function runBacktest(config: BacktestConfig): Promise<BacktestResult> {
  const timeline = await buildTimeline(config);
  const ctx: ExecutorContext = {
    store: new InMemoryPositionStore(),
    clock: new VirtualClock(config.from),
    redis: new InMemoryRedisLike(),
    adapterFor: (name) => historicalAdapter.forExchange(name),
    random: seedrandom(config.seed ?? 'default'),
    log: logCollector,
  };

  for (const event of timeline) {
    ctx.clock.setTime(event.at);
    switch (event.type) {
      case 'funding_collection': await handleFundingCollection(ctx, config); break;
      case 'health_check':       await handleHealthCheck(ctx, config);       break;
      case 'settlement':         await handleSettlement(ctx, event);         break;
    }
    if (isNewDay(event.at, equityCurve)) {
      equityCurve.push({ date: event.at, equity: store.computeTotalEquity(), /* ... */ });
    }
  }

  await forceCloseAll(ctx, config.to);  // 结束强制平仓
  return { closedTrades: store.listClosedTrades(), equityCurve, config };
}
```

#### 4.3.3 Handler 职责

- **handleFundingCollection**: 读 `ctx.clock.now()` 时刻的费率快照 → 跑 `findOpportunities()` → 对每个机会调 `executeOpen(ctx, ...)`，受 `maxConcurrent` 限制
- **handleSettlement**: 找到所有持有该 symbol 的 position → 按 long/short 计算 funding payment → 写 settlement 记录
- **handleHealthCheck**: 对每个 open position 调用 Plan 2 的 health 判断逻辑 → 如需平仓则 `executeClose(ctx, ...)`

#### 4.3.4 HistoricalAdapter

实现 `ExchangeAdapter` 接口，所有查询以 `clock.now()` 为时间截断：

```typescript
async getPrice(symbol: string): Promise<Ticker> {
  const kline = await prisma.ohlcvSnapshot.findFirst({
    where: { exchange: { name: this.name }, symbol, openTime: { lte: this.clock.now() } },
    orderBy: { openTime: 'desc' },
  });
  return { ...kline as Ticker };
}

async openPosition(params: OpenParams): Promise<Order> {
  const price = await this.getPrice(params.symbol);
  const execPrice = params.side === 'long'
    ? price.last * (1 + this.slippageBps / 10000)
    : price.last * (1 - this.slippageBps / 10000);
  if (this.failureInjector.shouldFail('open')) {
    throw new ExchangeError("Simulated order failure");
  }
  return {
    id: `backtest-${randomId()}`,
    clientOrderId: params.clientOrderId,
    status: 'filled',
    /* ... */
  };
}
```

**关键原则**：所有 DB 查询的 `WHERE` 条件都必须带 `<= clock.now()`。**防止未来数据泄漏是回测最容易犯的致命错误**。

#### 4.3.5 InMemoryPositionStore

实现 `PositionStore` 接口，数据全在 JS Map 里。单线程顺序执行，不做事务 / 锁。

### 4.4 Phase 0 Sanity Check

**独立的小回测，不经过 executor 重构**，作为 gate：

```typescript
// src/server/services/backtest/phase0-sanity-check.ts
async function phase0SanityCheck(from: Date, to: Date) {
  const rates = await loadAllHistoricalRates(from, to);
  const opportunities: OpSnapshot[] = [];

  for (let t = from.getTime(); t < to.getTime(); t += 5 * 60 * 1000) {
    const ratesAtT = /* 过滤 collectedAt <= t 的最新每个 symbol×exchange 组合 */;
    const ops = findOpportunities(ratesAtT, config);
    opportunities.push(...ops.map(op => ({ ...op, at: new Date(t) })));
  }

  let totalPnl = 0;
  for (const op of opportunities) {
    // 假设持有一次结算 = spread * notional
    totalPnl += op.rateSpread * 500;
  }

  console.log(`Phase 0 理论 P&L: $${totalPnl.toFixed(2)}`);
  console.log(`机会数: ${opportunities.length}`);
  console.log(`判断: ${totalPnl > 0 ? '✅ 有正收益信号' : '❌ 策略需要重新思考'}`);
}
```

**忽略的复杂度**：手续费、滑点、订单失败率、rescue、volatility pause。所以 Phase 0 的数字是**理论上限**，实际完整回测的数字会更低。

**Phase 0 → Phase 2+ 的过渡**：
- Phase 0 显示 ROI > 10% → 继续完整 runner
- Phase 0 显示 ROI < 0 → **停下来重新评估**，不要做 DI 重构
- Phase 0 显示 ROI 0-10% → 继续但调低预期

---

### 4.5 报告生成器

#### 4.5.1 输入输出

**输入**：`BacktestResult { config, closedTrades, equityCurve, startTime, endTime, durationMs }`

**输出**：`docs/backtest-reports/<ISO_timestamp>/` 目录下 4 个文件：
- `report.html` — 自包含（ECharts CDN），7 张图表 + 5 个卡片 + 参数块
- `report.md` — 文字摘要，可 git 追踪
- `trades.csv` — 每笔 ClosedTrade 一行
- `daily.csv` — 每日 EquityCurvePoint 一行

#### 4.5.2 Aggregate（纯函数）

```typescript
export function aggregate(trades: ClosedTrade[], equityCurve: EquityCurvePoint[]) {
  return {
    overall: computeOverall(trades, equityCurve),
    byDay: groupByDay(trades),
    byExchangePair: groupByExchangePair(trades),
    bySymbol: groupBySymbol(trades),
    byHoldDuration: groupByHoldDuration(trades),
    byHourOfDay: groupByHourOfDay(trades),
    byDayOfWeek: groupByDayOfWeek(trades),
    feeBreakdown: computeFeeBreakdown(trades),
    dailyPnlHistogram: computePnlHistogram(trades),
  };
}

interface OverallStats {
  totalTrades: number;
  winRate: number;
  grossPnl: number;
  netPnl: number;
  totalFees: number;
  feeRatio: number;
  maxDrawdown: number;
  maxDrawdownDate: Date;
  initialCapital: number;
  finalEquity: number;
  roi: number;
  annualizedRoi: number;
  sharpeRatio: number;
  avgHoldHours: number;
}
```

纯函数 + 固定输入输出，**单元测试覆盖率目标 80%+**。

#### 4.5.3 HTML 模板

用 ECharts 5.5.1 CDN，所有数据内嵌 JSON，函数返回字符串。7 张图：

1. 账户净值曲线（叠加回撤阴影）
2. 每日收益分布直方图
3. 按交易所对 P&L（水平条形）
4. 按币种 P&L
5. 手续费占比饼图
6. 持仓时长分布
7. 星期 × 小时热力图

HTML 布局：顶部 5 个核心数字卡片 → 参数 JSON 块 → 7 个图表容器。

**字体用系统字体**，不引入 webfont。**颜色有意义**：正绿负红。

#### 4.5.4 Markdown 模板

纯文字 + 表格。目的是**可 git 追踪** → `git diff` 看两次 run 的 ROI 变化。

```markdown
# 回测报告 — 2025-10-15 到 2026-04-15

## 核心指标

| 指标 | 值 |
|---|---|
| 初始资金 | $10,000 |
| 最终净值 | $12,341 |
| **ROI** | **+23.4%** |
| ...

## 按交易所对 P&L
...
```

#### 4.5.5 CSV Writer

标准库 `Array.join`，不引入 csv 库。字段转义处理含逗号 / 引号 / null 的单元。

#### 4.5.6 `.gitignore` 策略

```
/docs/backtest-reports/*
!/docs/backtest-reports/example/
```

本地跑的报告不进 git，但保留一份 `example/` 作为 baseline reference。

---

### 4.6 CLI 入口

两个 CLI：

**`data-loader/cli.ts`** — 拉历史数据
```bash
pnpm tsx src/server/services/backtest/data-loader/cli.ts [--from ...] [--to ...] [--symbols ...]
```

**`cli.ts`** — 跑回测
```bash
pnpm tsx src/server/services/backtest/cli.ts \
  [--phase 0|2]                  # 默认 2
  [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  [--capital 10000] [--size 500]
  [--max-concurrent 3]
  [--min-spread 0.0005] [--min-apy 0.1]
  [--slippage-bps 3] [--failure-rate 0.02]
  [--seed abc123]
  [--no-vol-pause]
  [--output docs/backtest-reports]
```

---

## 5. Phase 分组 & 实施顺序

| Phase | 内容 | 预估 | 可独立运行? |
|---|---|---|---|
| **1** | Schema 改动 + 数据加载器 | 1 天 | ✅ CLI 跑完能看到数据 |
| **2** | Phase 0 sanity check | 半天 | ✅ 直接出结果 |
| **🛑 Gate** | **Phase 0 结果评估** | — | — |
| **3** | Executor DI 重构（2A/2B/2C 分步）| 1.5 天 | ✅ CI 全绿 |
| **4** | Backtest Runner | 2 天 | ✅ 能跑完不崩 |
| **5** | Reporter | 1 天 | ✅ 能出报告文件 |
| **6** | CLI wire up + end-to-end test + example report | 半天 | ✅ 完整 plan 完成 |

**总计**：约 6-7 个工作日。

### Gate 语义

Phase 2 跑完后**必须停下来看 Phase 0 的数字**：
- **正收益信号（>10%）** → 继续 Phase 3-6
- **零或负收益** → **停下来重新评估策略**。可能需要调整 detector 阈值、换币种、或者承认"这策略在 6 个月数据里没 edge"
- **微弱正收益（0-10%）** → 继续但心理预期调低

这个 gate 是整个 Plan 4 最有价值的设计之一 —— 6 天大投入之前有一个 4 小时小投入的决策点。

---

## 6. 交付物清单

### 6.1 代码改动

**新增（Plan 4 核心）**：
- `prisma/schema.prisma` — +OhlcvSnapshot, +FundingRateSnapshot unique
- `prisma/migrations/1_ohlcv_snapshot/`
- `prisma/migrations/2_funding_snapshot_unique/`
- `src/server/services/backtest/` 完整目录（~1700 行）
- `src/server/services/executor/context-prod.ts`
- `src/server/services/executor/prisma-position-store.ts`

**修改（DI 重构）**：
- `src/server/services/executor/types.ts`（+接口定义）
- `src/server/services/executor/execute-open.ts`（签名改）
- `src/server/services/executor/execute-close.ts`（签名改）
- `src/server/services/executor/trade-recorder.ts`（签名改）
- `src/server/services/executor/aggregate.ts`（签名改）
- `src/server/services/executor/reconcile.ts`（签名改）
- `src/server/services/executor/rescue.ts`（签名改）
- `src/server/services/executor/post-reconcile.ts`（签名改）
- `src/server/api/routers/position.ts`（调用 buildProdContext）
- Plan 2 的 monitor workers（调用 ctx）

**配置**：
- `.gitignore` — 加 backtest-reports 白名单

### 6.2 测试

- `tests/unit/backtest/aggregate.test.ts`
- `tests/unit/backtest/csv-writer.test.ts`
- `tests/unit/backtest/virtual-clock.test.ts`
- `tests/unit/backtest/failure-injector.test.ts`
- `tests/unit/backtest/timeline.test.ts`
- `tests/integration/backtest/end-to-end.test.ts`
- **原有 executor 测试**保持绿（`tests/unit/aggregate.test.ts`、`rescue-decision.test.ts` 等）
- **原有 integration 测试**保持绿（改签名后）

### 6.3 文档

- `docs/superpowers/specs/2026-04-15-plan4-backtest-engine-design.md` — 本 spec
- `docs/superpowers/plans/2026-04-15-plan4-backtest-engine.md` — 实施 plan（下一步写）
- `docs/backtest/README.md` — 用户手册：怎么跑 + 怎么解读结果
- `docs/backtest/executor-di-migration.md` — executor 重构 before/after 对照
- `docs/backtest-reports/example/` — 第一次跑通的 baseline 报告（git 追踪）

---

## 7. 验收标准

Plan 4 完成的标志 —— 所有这些都要满足：

1. **数据加载器能跑**：`pnpm tsx data-loader/cli.ts` 跑完后 `FundingRateSnapshot` 和 `OhlcvSnapshot` 表里有近 6 个月的数据（3 交易所 × 5 币种）
2. **Phase 0 sanity check 能出结果**：输出一个理论收益数字，有明确的 ✅/❌ 判断
3. **Executor DI 重构完成**：
   - `src/server/services/executor/` 目录下没有直接 `import { prisma }` 或 `import { redis }`
   - 所有原有单元测试 + 集成测试全部绿
   - **生产 smoke test**：推 tag v0.2.0 到 Vultr，从 UI 手动触发一次 test-only 开仓（比如 BTC 最小单位），确认下单成功、平仓也成功、positions 表正确更新
4. **完整回测能跑通**：`pnpm tsx backtest/cli.ts --phase 2` 不崩、产出 ClosedTrade[] 非空
5. **Reporter 生成 4 个文件**：report.html / report.md / trades.csv / daily.csv
6. **HTML 报告双击能看**：浏览器打开看到 5 张卡片 + 7 张 ECharts 图表，数字一致
7. **example 报告 committed**：`docs/backtest-reports/example/` 里有一份真实跑出来的 baseline 报告
8. **CI 全绿**：lint、tsc、单元测试、集成测试
9. **Plan 4 的 follow-up 有记录**（如果过程中发现的零碎问题）

---

## 8. 风险 & 应对

| 风险 | 可能性 | 影响 | 应对 |
|---|---|---|---|
| ccxt `fetchFundingRateHistory` 对某家交易所不支持或返回空 | 中 | 高（数据源少一家）| Phase 1 完成后检查数据完整性；Bybit/OKX 有空洞时写 fallback 直连 REST API |
| Executor DI 重构引入生产回归 | 中 | 极高（影响实盘）| Phase 3 每小步都跑测试 + 强制生产 smoke test；`buildProdContext` 保留可快速回滚 |
| Phase 0 显示策略不赚钱 | 中 | 中（"好的失败"）| Gate 停下来，不盲目继续 |
| ECharts CDN 挂掉 | 低 | 低（报告看不见图）| 后备：`--embed-echarts` flag 内联源码（+1MB） |
| Runner 跑 6 个月太慢（>5 分钟）| 中 | 中 | 优化 HistoricalAdapter：一次加载所有数据到内存 Map，避免 per-event DB query |
| 历史 funding rate 数据有空洞 | 中 | 低 | detector 自然跳过，log warning |
| 单元测试覆盖不够，bug 逃到 runner 主循环 | 中 | 中 | aggregate / csv-writer / timeline 强制 80%+ 覆盖 |

---

## 9. 明确不在 Plan 4 范围（Follow-up 候选）

- **前端 `/backtest` 页面接入**：HTML 独立报告，Next.js 页面另开 plan
- **参数扫描 / grid search**：一次跑一组参数
- **Monte Carlo bootstrap 置信区间**：进阶统计
- **实时回测**（跑到当天数据）：只拉到 today - 1d
- **支持 > 3 家交易所**：只跑 Binance/OKX/Bybit
- **自动敏感性分析报告**（多组参数对比）：一次跑一组
- **Kelly criterion 仓位算法**：进阶
- **多时间粒度**（比如 1d K 线）：只用 1h
- **BullMQ worker 集成**：纯 CLI 离线工具

---

## 10. 未来演进路径

Plan 4 成果之上可做的事（记录在这里便于连贯性）：

- **策略参数扫描**：wrapper 脚本跑 10 组参数回测，生成对比报告
- **前端 /backtest 页面**：从 `docs/backtest-reports/` 读历史报告，UI 呈现
- **实时 mode**：把 InMemoryStore 换回 PrismaStore → runner 能跑"假想的下 8 小时会怎样"
- **策略重设计**：如果 Phase 0 显示资金费率套利在 6 个月数据里 edge 很小，Plan 5 可能转向其它策略（统计套利、做市）
- **多策略框架**：把 `findOpportunities()` 抽象成 `Strategy` 接口，支持多策略对比回测

---

## 11. 开放问题（实现期再定）

- **回滚策略**：如果 Phase 3 DI 重构的生产 smoke test 发现回归，具体怎么回滚？（建议：`git revert`，并立刻用 v0.2.0-rollback tag 重新部署）
- **Phase 0 的"正收益阈值"**：10% 只是我随口定的，实现时可能需要根据机会频率和样本数动态判断
- **Reporter 的 sharpe ratio 计算**：日收益序列太短（6 个月 ≈ 180 个点）时 sharpe 意义不大，是否要加最小样本量的 guard？
- **HistoricalAdapter 的 `rescue` 调用路径**：Plan 2 的 rescue executor 在生产里会重试几次真实订单，回测里如何模拟？（建议：rescue 调用仍走 HistoricalAdapter，但失败率降到 0 —— 即"rescue 模拟总是成功"）
