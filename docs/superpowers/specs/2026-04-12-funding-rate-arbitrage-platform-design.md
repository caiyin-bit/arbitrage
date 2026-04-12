# 资金费率套利管理平台 — 设计规格

> 创建时间：2026-04-12
> 状态：设计完成，待实现

---

## 一、项目概述

### 1.1 目标

构建一个 CEX-CEX 资金费率套利管理平台，支持在 4 个主流交易所之间检测永续合约费率差异，以半自动方式执行对冲套利，并提供完整的监控、回测和风控能力。

### 1.2 核心功能

- 多交易所实时费率采集与机会检测
- 半自动交易执行（系统推荐，人工确认）
- 持仓管理与结算监控
- 历史数据回测
- 风控告警
- Telegram 通知（后续接入 OpenClaw）

### 1.3 范围约束

- 初期单用户，多租户/权限后续再加
- 仅 CEX 永续合约，不涉及 DEX
- 暗色 + 亮色主题均在初期范围，支持切换

---

## 二、技术栈

| 层 | 选型 | 说明 |
|---|------|------|
| 框架 | Next.js 15 (App Router) | 全栈单体 |
| 语言 | TypeScript | 全栈类型安全 |
| API | tRPC | 前后端类型自动同步 |
| UI 组件 | shadcn/ui + Radix UI | 可定制组件 |
| 样式 | Tailwind CSS | 配合 DESIGN.md token |
| 图表 | Recharts | 收益曲线、费率图表 |
| ORM | Prisma | 类型安全数据库操作 |
| 数据库 | PostgreSQL 15+ | 主存储 |
| 缓存/队列 | Redis 7+ | 实时缓存 + BullMQ 任务队列 |
| 交易所对接 | ccxt (TypeScript) | 统一多所 API |
| 实时推送 | tRPC subscriptions (WebSocket) | 实时更新 |
| 通知 | node-telegram-bot-api | Telegram Bot |
| 容器 | Docker + Docker Compose | 开发 & 生产 |
| CI/CD | GitHub Actions | lint → test → build → deploy |
| 镜像仓库 | ghcr.io | GitHub Container Registry |
| 部署 | 腾讯云海外节点 | Docker Compose |

---

## 三、架构设计

### 3.1 单体架构

```
┌─────────────────────────────────────────────┐
│              Docker Compose                  │
│                                              │
│  ┌─────────────────────────────────────┐     │
│  │         Next.js App (单体)           │     │
│  │                                     │     │
│  │  ┌───────────┐  ┌───────────────┐   │     │
│  │  │  Web UI   │  │  API Routes   │   │     │
│  │  │ App Router│  │  tRPC         │   │     │
│  │  │  React    │  │  Handlers     │   │     │
│  │  └───────────┘  └───────────────┘   │     │
│  │                                     │     │
│  │  ┌───────────────────────────────┐  │     │
│  │  │      后台定时任务 (BullMQ)     │  │     │
│  │  │  · 费率采集 (每1-5min)        │  │     │
│  │  │  · 机会检测 (费率更新时触发)   │  │     │
│  │  │  · 结算监控 (结算前15min)      │  │     │
│  │  │  · 仓位健康检查 (每5min)      │  │     │
│  │  └───────────────────────────────┘  │     │
│  └─────────────────────────────────────┘     │
│                                              │
│  ┌──────────┐  ┌──────────┐                  │
│  │PostgreSQL│  │  Redis   │                  │
│  │  :5432   │  │  :6379   │                  │
│  └──────────┘  └──────────┘                  │
└─────────────────────────────────────────────┘
```

### 3.2 选择单体的理由

- 资金费率套利是低频策略（每几分钟轮询），后台任务资源消耗小
- 单人项目，一个仓库、一次部署的效率优势大
- 后续如需拆分 Worker，从单体迁移到 Next.js + 独立 Worker 方案成本低

---

## 四、数据模型

### 4.1 PostgreSQL Tables

#### exchanges — 交易所配置

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | |
| name | varchar | "binance" / "okx" / "bybit" / "gateio" |
| api_key | varchar | AES-256-GCM 加密存储（见 14.2） |
| api_secret | varchar | AES-256-GCM 加密存储（见 14.2） |
| passphrase | varchar? | OKX 需要，AES-256-GCM 加密存储（见 14.2） |
| is_enabled | boolean | 启用/禁用 |
| fee_rate | decimal | taker 手续费率 |
| created_at | timestamp | |
| updated_at | timestamp | |

#### funding_rate_snapshots — 费率快照

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | |
| exchange_id | uuid FK → exchanges | |
| symbol | varchar | "BTC/USDT:USDT" |
| current_rate | decimal | 当前费率 |
| predicted_rate | decimal? | 预测下期费率 |
| next_settlement | timestamp | 下次结算时间 |
| interval_hours | int | 8 / 4 / 1 |
| collected_at | timestamp | 采集时间 |
| created_at | timestamp | |

数据增长最快的表。按月范围分区（PARTITION BY RANGE (collected_at)），详见 14.3。

#### funding_rate_hourly — 小时级聚合（报表用，非回测）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | |
| exchange_id | uuid FK → exchanges | |
| symbol | varchar | |
| hour | timestamptz | 整点时间戳 |
| avg_rate | decimal | 该小时内费率均值 |
| max_rate | decimal | 最高费率 |
| min_rate | decimal | 最低费率 |
| sample_count | int | 采样点数 |

由归档任务每小时从 funding_rate_snapshots 聚合写入。**仅用于 Dashboard 趋势图和统计报表，回测不使用此表**（详见 14.3、14.4）。

#### opportunities — 套利机会

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | |
| symbol | varchar | |
| long_exchange_id | uuid FK → exchanges | 做多交易所 |
| short_exchange_id | uuid FK → exchanges | 做空交易所 |
| long_rate | decimal | 做多侧费率 |
| short_rate | decimal | 做空侧费率 |
| rate_spread | decimal | 费率差 |
| annualized_yield | decimal | 年化收益估算 |
| suggested_size | decimal | 建议仓位 |
| status | enum | detected / notified / accepted / rejected / expired |
| cooldown_until | timestamp? | 单腿补救后冷却截止时间，冷却期内不再推荐（见 14.1） |
| detected_at | timestamp | |
| created_at | timestamp | |

#### positions — 持仓（聚合态）

positions 只保存汇总状态，不存单个订单号。一个 position 的多/空两侧各可能对应多笔 trade_logs（IOC 部分成交 + 补单 + rescue），entry_price 和 size 均为加权聚合值，由 trade_logs 计算写入。

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | |
| opportunity_id | uuid FK → opportunities | |
| symbol | varchar | |
| long_exchange_id | uuid FK → exchanges | |
| long_size | decimal | 做多总量（trade_logs 聚合） |
| long_avg_entry_price | decimal | 做多加权均价（trade_logs 聚合） |
| short_exchange_id | uuid FK → exchanges | |
| short_size | decimal | 做空总量（trade_logs 聚合） |
| short_avg_entry_price | decimal | 做空加权均价（trade_logs 聚合） |
| status | enum | opening / open / closing / closed / rescue |
| close_reason | enum? | manual / rate_reversal / take_profit / risk_control |
| opened_at | timestamp | |
| closed_at | timestamp? | |
| created_at | timestamp | |
| updated_at | timestamp | |

**signed_qty 语义**：

| action | signed_qty | 对净仓位的影响 |
|--------|-----------|--------------|
| open | +abs(qty) | 增加仓位 |
| close | -abs(qty) | 减少仓位 |
| rescue | -abs(qty) | 减少仓位（反向平仓消除敞口） |

**聚合规则**：每次 trade_logs 写入新记录后，重新计算该 position 的聚合值：
```
-- 净仓位 = 所有已成交单据的 signed_qty 之和
long_size = SUM(signed_qty) WHERE position_id=X AND side='long' AND status='filled'

-- 加权均价仅用 open 单据计算（close/rescue 是平仓价，不是持仓成本）
long_avg_entry_price = SUM(price * signed_qty) / SUM(signed_qty)
    WHERE position_id=X AND side='long' AND action='open' AND status='filled'

（short 侧同理）
```

**示例：单腿补救后的聚合结果**：
```
trade_logs:
  #1  side=long   action=open    signed_qty=+1.0   price=70000  ← 正常开多
  #2  side=short  action=open    signed_qty=+1.0   price=70100  ← 正常开空
  #3  side=short  action=rescue  signed_qty=-0.3   price=70050  ← 空侧部分成交不足，rescue 平掉多余

positions 聚合结果：
  long_size  = 1.0           (只有 open)
  short_size = 1.0 - 0.3 = 0.7  (open - rescue)
  → 两侧不等，说明有 0.3 的未对冲敞口被 rescue 消除了
  → 实际对冲仓位 = min(1.0, 0.7) = 0.7
```

**position ↔ trade_logs 关系**：1:N。所有订单明细（含 rescue）查 trade_logs，positions 只看汇总。

#### settlements — 结算记录

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | |
| position_id | uuid FK → positions | |
| exchange_id | uuid FK → exchanges | |
| side | enum | long / short |
| funding_rate | decimal | 本次实际费率 |
| funding_amount | decimal | 实际收付金额（正=收入，负=支出） |
| settled_at | timestamp | |
| created_at | timestamp | |

#### trade_logs — 交易日志

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | |
| position_id | uuid FK → positions | |
| exchange_id | uuid FK → exchanges | |
| execution_id | uuid | 流程级幂等键：一次开仓/平仓/补救流程共享同一个 execution_id（见 14.1） |
| client_order_id | uuid | 订单级唯一键：每笔具体下单独立生成，作为 ccxt clientOrderId |
| side | enum | long / short |
| action | enum | open / close / rescue |
| order_type | enum | market / limit_ioc |
| price | decimal | |
| signed_qty | decimal | 有符号数量：open 为正（增加仓位），close/rescue 为负（减少仓位） |
| fee | decimal | |
| exchange_order_id | varchar | |
| status | enum | pending / filled / partial / failed |
| executed_at | timestamp | |
| created_at | timestamp | |

#### settings — 系统配置

| 字段 | 类型 | 说明 |
|------|------|------|
| key | varchar PK | 如 "min_rate_spread" |
| value | jsonb | JSON 格式存值 |
| description | varchar | |
| updated_at | timestamp | |

### 4.2 Redis 用途

| Key 模式 | 用途 |
|---|---|
| `rate:{exchange}:{symbol}` | 最新费率缓存 |
| `balance:{exchange}` | 各所账户余额缓存 |
| `opportunity:latest` | 当前最优机会 |
| `price:{exchange}:{symbol}` | 最新 ticker 价格缓存，用于 UI 实时展示和浮盈计算（波动率判定不用此 key，用 K 线接口） |
| `pause:{symbol}` | 极端行情暂停状态 JSON（含 paused/reason/triggered_at/recovery_count，见 14.5） |
| BullMQ queues | 定时任务调度 |

---

## 五、核心模块

### 5.1 目录结构

```
src/
├── app/                          # Next.js 页面
│   ├── layout.tsx
│   ├── (dashboard)/
│   │   ├── page.tsx              # Dashboard 总览
│   │   ├── opportunities/
│   │   │   └── page.tsx          # 套利机会
│   │   ├── positions/
│   │   │   └── page.tsx          # 持仓管理
│   │   ├── backtest/
│   │   │   └── page.tsx          # 回测
│   │   └── settings/
│   │       └── page.tsx          # 系统设置
│   └── api/
│       └── trpc/[trpc]/route.ts  # tRPC handler
├── server/
│   ├── api/
│   │   ├── root.ts               # tRPC root router
│   │   └── routers/
│   │       ├── exchange.ts
│   │       ├── opportunity.ts
│   │       ├── position.ts
│   │       ├── backtest.ts
│   │       ├── settings.ts
│   │       └── dashboard.ts
│   ├── services/
│   │   ├── exchange/
│   │   │   ├── adapter.ts        # ExchangeAdapter 接口
│   │   │   ├── binance.ts
│   │   │   ├── okx.ts
│   │   │   ├── bybit.ts
│   │   │   └── gateio.ts
│   │   ├── collector/
│   │   │   └── funding-rate.ts   # 费率采集
│   │   ├── detector/
│   │   │   └── opportunity.ts    # 机会检测
│   │   ├── executor/
│   │   │   └── trade.ts          # 交易执行
│   │   ├── monitor/
│   │   │   ├── settlement.ts     # 结算监控
│   │   │   └── health.ts         # 仓位健康检查
│   │   ├── backtest/
│   │   │   └── engine.ts         # 回测引擎
│   │   └── notifier/
│   │       ├── telegram.ts
│   │       └── index.ts          # 通知统一入口
│   ├── jobs/
│   │   ├── worker.ts             # BullMQ worker 启动
│   │   ├── collect-rates.ts
│   │   ├── detect-opportunities.ts
│   │   ├── monitor-settlement.ts
│   │   ├── check-health.ts       # 含极端行情波动率检测（见 14.5）
│   │   └── archive-snapshots.ts  # 费率快照归档（月度，见 14.3）
│   ├── scripts/
│   │   └── backfill-history.ts   # 一次性历史费率回填（见 14.4）
│   └── db/
│       ├── schema.prisma
│       ├── migrations/           # Prisma 迁移（含分区 DDL）
│       └── seed.ts
├── lib/
│   ├── types.ts                  # 共享类型
│   ├── constants.ts              # 常量
│   ├── utils.ts                  # 工具函数
│   └── trpc.ts                   # tRPC client setup
└── components/
    ├── ui/                       # shadcn/ui 组件
    ├── layout/
    │   ├── sidebar.tsx
    │   └── header.tsx
    ├── dashboard/
    │   ├── balance-overview.tsx
    │   ├── profit-chart.tsx
    │   └── recent-alerts.tsx
    ├── opportunities/
    │   ├── rate-table.tsx
    │   ├── opportunity-card.tsx
    │   └── open-position-dialog.tsx
    ├── positions/
    │   ├── position-table.tsx
    │   ├── settlement-history.tsx
    │   └── close-position-dialog.tsx
    └── backtest/
        ├── backtest-form.tsx
        └── backtest-results.tsx
```

### 5.2 交易所抽象层

```typescript
interface ExchangeAdapter {
  // 费率
  getFundingRates(symbols: string[]): Promise<FundingRate[]>
  getNextSettlementTime(symbol: string): Promise<Date>

  // 行情
  getPrice(symbol: string): Promise<Ticker>            // UI 实时展示、浮盈计算
  getKline(symbol: string, tf: '1h'|'1d', limit: number): Promise<OHLCV[]>  // 波动率判定（见 14.5）

  // 账户
  getBalances(): Promise<Balance[]>
  getPositions(): Promise<Position[]>

  // 交易
  openPosition(params: OpenParams): Promise<Order>
  closePosition(params: CloseParams): Promise<Order>
  getOrder(orderId: string): Promise<Order>

  // 元数据
  getSymbols(): Promise<SymbolInfo[]>
  getFeeRate(): Promise<number>
}
```

底层用 ccxt 库，每个交易所一个 adapter 实现。adapter 层处理各所特有的参数和边界情况。

### 5.3 核心数据流

```
┌─────────────────── 定时任务 (BullMQ) ──────────────────┐
│                                                         │
│  [费率采集: 每1-5min]                                    │
│    → 并发调用 4 所 getFundingRates()                     │
│    → 写入 DB: funding_rate_snapshots                    │
│    → 更新 Redis 缓存                                    │
│    → 触发机会检测                                        │
│                                                         │
│  [机会检测]                                              │
│    → 从 Redis 读取各所最新费率                            │
│    → 计算跨所费率差 + 年化收益                            │
│    → 过滤：annualized_yield > 阈值                       │
│    → 写入 DB: opportunities                             │
│    → 通知：Telegram + WebSocket 推送前端                  │
│                                                         │
│  [结算监控: 结算前15min]                                  │
│    → 检查所有 open 持仓                                   │
│    → 重新评估费率                                        │
│    → 结算后记录 DB: settlements                          │
│    → 异常告警                                            │
│                                                         │
│  [仓位健康检查: 每5min]                                   │
│    → 查询各所实际仓位和保证金率                            │
│    → 与 DB 记录核对                                      │
│    → 低于安全线 → 告警                                   │
└─────────────────────────────────────────────────────────┘

┌─────────────────── 用户操作 (半自动) ───────────────────┐
│                                                         │
│  看到推荐机会 → 确认开仓                                  │
│    → executor.openHedgedPosition()                      │
│    → 并发：交易所A 开多 + 交易所B 开空                    │
│    → 写入 DB: positions + trade_logs                    │
│                                                         │
│  确认平仓                                                │
│    → executor.closeHedgedPosition()                     │
│    → 并发两边平仓                                        │
│    → 计算最终损益                                        │
│    → 更新 DB: positions (closed)                        │
└─────────────────────────────────────────────────────────┘
```

---

## 六、页面设计

### 6.1 页面结构

```
/                     → 重定向到 /dashboard
/dashboard            → 总览面板
/opportunities        → 套利机会列表
/positions            → 持仓管理
/backtest             → 回测
/settings             → 系统设置
```

### 6.2 页面内容

**Dashboard 总览**
- 账户总资产（各交易所余额汇总）
- 当前持仓数 + 总浮动盈亏
- 今日/本周/本月累计收益
- 收益曲线图
- 最近告警/事件

**Opportunities 套利机会**
- 实时费率表：每行一个交易对，各交易所费率，高亮最大费率差组合
- 机会卡片：做多/做空交易所、费率差、年化收益、建议仓位
- 操作：「开仓」→ 弹窗确认参数 → 执行

**Positions 持仓管理**
- 当前持仓列表：交易对、方向、两边交易所、持仓大小、累计费率收益、保证金率
- 可展开查看结算历史
- 操作：「平仓」
- 历史已平仓位（可筛选时间范围）

**Backtest 回测**
- 参数配置：时间范围、交易对、费率差阈值、杠杆、仓位大小
- 结果展示：累计收益曲线、胜率、最大回撤、夏普比率、逐笔明细

**Settings 系统设置**
- 交易所 API 配置（key/secret，连接测试）
- 策略参数（费率差阈值、杠杆、仓位限制）
- 通知设置（Telegram Bot Token、Chat ID）
- 风控参数

### 6.3 UI 布局

- 固定左侧 Sidebar (240px) + 右侧主内容区
- 暗色主题，遵循 DESIGN.md 规范
- 实时数据通过 WebSocket 推送，WebSocket 断开时降级轮询

---

## 七、风控规则

| 规则 | 说明 | 默认值 |
|------|------|--------|
| 最小费率差 | 低于此值不触发机会 | 0.01% (1 bps) |
| 最小年化收益 | 年化低于此值不推荐 | 15% |
| 最大杠杆 | 开仓杠杆上限 | 3x |
| 保证金安全缓冲 | 低于安全线告警 | 50% |
| 单品种最大仓位 | 占总资金比例上限 | 20% |
| 费率反转平仓阈值 | 费率差反转到此值自动建议平仓 | -0.005% |
| 最少持有周期 | 最少持有结算周期数（覆盖手续费） | 3 个周期 |
| 单腿最大敞口 | 超过此值拒绝执行（见 14.1） | 可配置 |
| 单交易所仓位上限 | 风险分散 | 可配置 |
| 极端行情暂停 | 1h 波动 >5% 或 24h >15% 暂停新开仓推荐（见 14.5） | 5% / 15% |

所有参数均通过 Settings 页面可配置。

---

## 八、Docker & 部署

### 8.1 Docker Compose（开发）

```yaml
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile.dev
    volumes:
      - .:/app
      - /app/node_modules
    ports:
      - "3000:3000"
    depends_on:
      - postgres
      - redis
    env_file: .env.local

  postgres:
    image: postgres:15-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: arbitrage
      POSTGRES_USER: arbitrage
      POSTGRES_PASSWORD: ${DB_PASSWORD}

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  pgdata:
```

### 8.2 热加载

| 部分 | 方式 |
|------|------|
| 前端 (React) | Next.js HMR |
| API Routes | Next.js 自动重载 |
| 后台任务 | `tsx --watch` |
| 数据库变更 | `prisma db push`（开发），`prisma migrate`（生产） |

### 8.3 生产部署

- 镜像推送到 ghcr.io
- 腾讯云节点上 `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`
- 生产环境不挂载源码，使用预构建镜像

---

## 九、CI/CD

### 9.1 GitHub Actions 流水线

```
Push to PR     → Stage 1 (Check) + Stage 2 (Test)
Merge to main  → Stage 1 + 2 + Stage 3 (Build & Push) + Stage 4 (Deploy)
```

**Stage 1: Check（并行）**
- eslint
- tsc --noEmit
- prettier --check

**Stage 2: Test**
- vitest (单元 + 集成测试，Testcontainers 起 PG + Redis)

**Stage 3: Build & Push**
- docker build → push to ghcr.io

**Stage 4: Deploy（仅 main）**
- SSH 到腾讯云
- docker compose pull + up -d
- health check 验证

---

## 十、测试策略

| 类型 | 工具 | 覆盖范围 |
|------|------|---------|
| 单元测试 | Vitest | 核心计算逻辑、风控规则 |
| 集成测试 | Vitest + Testcontainers | DB 操作、BullMQ 任务流、tRPC API |
| E2E 测试 | Playwright（后期） | 关键 UI 流程 |

### 单元测试重点

- 费率差计算 & 年化收益估算
- 机会检测过滤逻辑
- 仓位盈亏计算（含手续费）
- 风控规则判定
- 回测引擎计算正确性

---

## 十一、关键配置参数

| 参数 | 初始建议值 | 说明 |
|------|-----------|------|
| min_rate_spread | 0.01% | 最小费率差阈值 |
| min_annualized_yield | 15% | 最小年化收益 |
| max_leverage | 3x | 最大杠杆 |
| safety_margin_ratio | 50% | 保证金安全缓冲 |
| max_single_position | 20% | 单品种最大仓位占比 |
| rate_reversal_exit | -0.005% | 费率反转平仓阈值 |
| min_holding_periods | 3 | 最少持有结算周期数 |
| rate_collect_interval | 3min | 费率采集间隔 |
| health_check_interval | 5min | 仓位健康检查间隔 |
| settlement_pre_check | 15min | 结算前检查提前量 |
| max_single_leg_exposure | 可配置 | 单腿最大敞口，超过则拒绝执行（见 14.1） |
| volatility_threshold_1h | 5% | 1h 价格波动暂停阈值（见 14.5） |
| volatility_threshold_24h | 15% | 24h 价格波动暂停阈值（见 14.5） |
| backtest_slippage | 0.05% | 回测滑点假设（见 14.4） |

所有参数通过 UI 可调，存储在 settings 表中。

---

## 十二、交易所覆盖

| 交易所 | 永续合约 | 费率查询 | 开平仓 | ccxt 支持 |
|--------|---------|---------|--------|----------|
| Binance | ✓ | ✓ | ✓ | ✓ |
| OKX | ✓ | ✓ | ✓ | ✓ |
| Bybit | ✓ | ✓ | ✓ | ✓ |
| Gate.io | ✓ | ✓ | ✓ | ✓ |

---

## 十三、通知

### 初期：Telegram Bot

- 新机会推荐
- 开仓/平仓执行结果
- 保证金率告警
- 费率反转告警
- 结算异常

### 后续：OpenClaw

替代或补充 Telegram 作为消息下行通道。通知模块设计为统一入口 + 多 provider，切换成本低。

---

## 十四、补充细节

### 14.1 交易执行：幂等、部分成交、双边不一致补救

#### 幂等性（两层 ID 模型）

trade_logs 有两个 ID 字段，职责不同：

| 字段 | 粒度 | 生成时机 | 用途 |
|------|------|---------|------|
| `execution_id` | 流程级 | 用户点击「开仓」/「平仓」时生成一次 | 同一流程（含主单 + 补单 + rescue）共享，用于流程级幂等和关联查询 |
| `client_order_id` | 订单级 | 每笔 createOrder 调用前生成 | 每笔下单独立唯一，作为 ccxt `clientOrderId` 传给交易所，交易所侧保证订单级幂等 |

**流程级幂等**：执行前查询 `execution_id` 是否已存在 trade_logs：
- 已有 filled 记录 → 跳过，返回已有结果
- 已有 pending 记录 → 用 `client_order_id` 查询交易所订单状态，同步结果
- 不存在 → 正常执行

**订单级幂等**：网络超时等场景下，用相同 `client_order_id` 重试 createOrder，交易所不会重复下单。

**示例：一次开仓流程产生的 trade_logs**：
```
execution_id = "exec-001"（整个流程共享）

#1  client_order_id="ord-001"  side=long   action=open   ← 主单：交易所A 开多
#2  client_order_id="ord-002"  side=short  action=open   ← 主单：交易所B 开空
#3  client_order_id="ord-003"  side=short  action=open   ← 补单：空侧部分成交，追加补齐
#4  client_order_id="ord-004"  side=long   action=rescue ← rescue：多侧多余部分反向平仓
```

#### 部分成交

使用 Limit IOC（Immediate-Or-Cancel）下单，未成交部分自动取消。处理逻辑：

```
两边下单后：
  long_filled  = 交易所A 实际成交量
  short_filled = 交易所B 实际成交量

  if long_filled == short_filled → 正常，记录持仓
  if long_filled != short_filled:
    matched_qty = min(long_filled, short_filled)
    excess_side = 成交量较大的一边
    excess_qty  = abs(long_filled - short_filled)

    方案1（默认）: 对 excess 侧立即市价反向平仓 excess_qty
    方案2: 对不足侧追加市价单补齐到 excess 侧的量

    选择逻辑: 如果 excess_qty / matched_qty < 10% → 方案1（平掉多余）
              否则 → 方案2（补齐不足）
```

#### 双边不一致补救（单腿风险）

最危险的场景：一边成交、另一边完全失败（API 超时、限频等）。

```
状态机：
  INIT → BOTH_SENT → CHECK_RESULTS
    → BOTH_FILLED     → 正常持仓
    → ONE_FILLED       → 进入补救流程
    → BOTH_FAILED      → 标记失败，无需处理
    → BOTH_PARTIAL     → 按部分成交逻辑处理

单腿补救流程：
  1. 立即在成交侧反向平仓（市价单），消除敞口
  2. 记录本次操作为 trade_log (action: "rescue")
  3. 计算平仓损益（通常微小亏损）
  4. 发送 Telegram 告警，包含详细执行信息
  5. 标记该 opportunity 为短期冷却，避免重复触发
```

单腿最大敞口由风控参数 `max_single_leg_exposure` 控制，超过此值则拒绝执行。

### 14.2 API 密钥加密存储方案

使用 AES-256-GCM 对称加密：

```
加密流程：
  1. 主密钥 ENCRYPTION_KEY 存在环境变量（.env），32 字节，不入库
  2. 每个 api_key/api_secret 加密时生成随机 IV（12 字节）
  3. AES-256-GCM 加密 → 密文 + auth tag
  4. 存储格式：base64(iv + auth_tag + ciphertext)
  5. 解密时从存储值中拆出 iv、tag、ciphertext，用 ENCRYPTION_KEY 解密

实现：Node.js 原生 crypto 模块
  - crypto.createCipheriv('aes-256-gcm', key, iv)
  - crypto.createDecipheriv('aes-256-gcm', key, iv)
```

安全措施：
- `ENCRYPTION_KEY` 仅在环境变量中，不提交到代码仓库
- Docker 生产环境通过 `docker compose` 的 `env_file` 或 secrets 注入
- API 密钥在 tRPC 返回给前端时脱敏显示（仅显示末 4 位）
- 日志中不打印密钥明文

### 14.3 费率快照表分区与归档策略

`funding_rate_snapshots` 是增长最快的表。4 个交易所 × 假设 20 个交易对 × 每 3 分钟 1 条 = 每天约 38,400 条。

#### 分区方案

按月范围分区（PostgreSQL 原生声明式分区）：

```sql
CREATE TABLE funding_rate_snapshots (
  id uuid,
  exchange_id uuid,
  symbol varchar,
  current_rate decimal,
  ...
  collected_at timestamptz
) PARTITION BY RANGE (collected_at);

-- 每月自动创建分区（通过定时任务或 pg_partman 扩展）
CREATE TABLE funding_rate_snapshots_2026_04
  PARTITION OF funding_rate_snapshots
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
```

#### 归档策略

**原则：原始快照永久保留用于回测，聚合表用于报表。**

原始 `funding_rate_snapshots` 不做降采样，始终保留完整粒度。另建 `funding_rate_hourly` 聚合表用于 Dashboard 统计报表和长周期趋势图。

| 阶段 | 数据范围 | funding_rate_snapshots（原始） | funding_rate_hourly（聚合） |
|------|---------|-------------------------------|---------------------------|
| 热数据 | 最近 3 个月 | PostgreSQL 主表分区 | 由归档任务按小时聚合写入 |
| 温数据 | 3-12 个月 | PostgreSQL 主表分区（保留原始） | PostgreSQL |
| 冷数据 | 12 个月以上 | 导出为 Parquet 存到本地/对象存储，DROP 分区 | PostgreSQL（聚合体积很小，不归档） |

#### funding_rate_hourly — 小时级聚合表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | |
| exchange_id | uuid FK → exchanges | |
| symbol | varchar | |
| hour | timestamptz | 整点时间戳 |
| avg_rate | decimal | 该小时内费率均值 |
| max_rate | decimal | 最高费率 |
| min_rate | decimal | 最低费率 |
| sample_count | int | 采样点数 |

由 `archive-snapshots` 任务每小时聚合写入。

归档通过 BullMQ 定时任务执行：
- **每小时**：从 funding_rate_snapshots 聚合写入 funding_rate_hourly
- **每月 1 日**：将 >12 个月的 funding_rate_snapshots 分区导出为 Parquet，然后 DROP 分区

初期数据量不大（约 38,400 条/天），12 个月内全部在线查询无压力。

### 14.4 回测数据来源与精度边界

#### 数据来源

| 优先级 | 来源 | 粒度 | 用途 |
|--------|------|------|------|
| 1 | funding_rate_snapshots（原始） | 采集频率（~3min） | **回测主数据源**，≤12 个月在线查询 |
| 2 | 已归档 Parquet 文件 | 同上 | **回测 >12 个月数据**，需先导入临时表 |
| 3 | ccxt fetchFundingRateHistory() | 每结算周期 1 条（8h/4h/1h） | 历史回填，粒度较粗 |
| 4 | 第三方数据源（Coinglass API 等） | 每结算周期 1 条 | 补充和交叉验证 |

**回测绝不使用 funding_rate_hourly 聚合表**。聚合表仅用于 Dashboard 趋势图和统计报表。

#### 初始化历史数据

首次部署时，通过 `scripts/backfill-history.ts` 从各交易所拉取历史费率：
- Binance: 支持查询最近 3 个月
- OKX: 支持查询最近 3 个月
- Bybit: 支持查询最近 2 年
- Gate.io: 支持查询最近 3 个月

注意：交易所 API 返回的历史数据粒度为**每结算周期 1 条**（非分钟级），回测使用这些数据时精度边界与实时采集不同。回填数据在 funding_rate_snapshots 中通过 `interval_hours` 字段可区分来源粒度。

具体可用范围以实测为准，各所 API 限制可能调整。

#### 精度边界（回测结果的局限性）

回测需明确告知用户以下偏差：

| 偏差来源 | 影响 | 处理方式 |
|---------|------|---------|
| 数据粒度差异 | 本地采集 ~3min/条，历史回填 8h/条，精度不同 | 回测结果标注数据来源和实际粒度 |
| 无滑点模拟 | 回测按费率精确值计算，实际开平仓有价差 | 引入可配置的滑点假设（默认 0.05%） |
| 无部分成交模拟 | 回测假设全量成交 | 结果页面标注此假设 |
| 手续费估算 | 使用配置的固定费率，实际可能有 VIP 折扣等 | 手续费率可在回测参数中调整 |
| 保证金变化 | 回测不模拟逐笔保证金占用变化 | 用最大同时持仓数 × 单笔仓位估算峰值保证金 |
| 归档数据 | >12 个月数据需从 Parquet 导入，不自动在线可用 | 回测时间范围超出在线数据时提示用户先导入 |

回测结果页面底部固定展示「回测假设说明」区块，列出上述局限。

### 14.5 极端行情暂停：可执行判定标准

#### 价格数据来源

**不自建价格快照表**。直接调用 ccxt 的 K 线接口获取基准价格：

```typescript
// ExchangeAdapter 新增方法
getKline(symbol: string, timeframe: '1h' | '1d', limit: number): Promise<OHLCV[]>
```

每次健康检查时：
1. 调用任一交易所（优先 Binance）的 `fetchOHLCV(symbol, '1h', limit=2)` 获取最近 2 根 1h K 线
2. 调用 `fetchOHLCV(symbol, '1d', limit=2)` 获取最近 2 根日 K 线
3. 用 K 线的 close 价格计算变动幅度

这样不需要维护价格历史，K 线接口返回的数据由交易所保证完整性。

**Redis `price:{exchange}:{symbol}` 的用途调整为**：缓存最新 ticker 价格，仅用于 UI 实时展示和仓位浮盈计算，不用于波动率判定。

#### 判定指标

```
每次健康检查（每 5min）时：
  对每个持仓品种 + 所有已启用的监控品种：
    kline_1h  = fetchOHLCV(symbol, '1h', limit=2)
    kline_1d  = fetchOHLCV(symbol, '1d', limit=2)

    price_change_1h  = (kline_1h[-1].close - kline_1h[-2].close) / kline_1h[-2].close
    price_change_24h = (kline_1d[-1].close - kline_1d[-2].close) / kline_1d[-2].close

  触发条件（满足任一即暂停该品种的新开仓推荐）：
    1. |price_change_1h|  > volatility_threshold_1h   (默认 5%)
    2. |price_change_24h| > volatility_threshold_24h  (默认 15%)
```

#### 暂停范围

- 仅暂停**新开仓推荐**，不影响已有持仓的监控和平仓操作
- 按品种粒度暂停：BTC 暴跌不影响 ETH 的机会推荐（除非 ETH 也触发阈值）

#### 恢复条件与状态存储

**Redis `pause:{symbol}` 结构**：
```json
{
  "paused": true,
  "reason": "1h_volatility",
  "triggered_at": "2026-04-12T08:30:00Z",
  "recovery_count": 1
}
```

- `recovery_count`：连续通过恢复阈值的检查次数，每次健康检查更新
- 不满足恢复条件时重置为 0
- 达到 3 时自动恢复（删除该 key）

```
暂停后每次健康检查重新评估：
  kline_1h = fetchOHLCV(symbol, '1h', limit=2)  // 同判定逻辑
  price_change_1h = 计算变动幅度

  if |price_change_1h| < volatility_threshold_1h × 0.6   (默认 3%):
    recovery_count += 1
  else:
    recovery_count = 0

  if recovery_count >= 3:  // 连续 3 次（15 分钟）
    删除 pause:{symbol} key → 自动恢复推荐
```

恢复时使用更低的阈值（× 0.6）并要求连续 3 次通过，避免在波动边缘反复切换。

#### UI 与通知

- 暂停时：Opportunities 页面对应品种显示「极端行情暂停中」badge
- 触发时：Telegram 告警，说明暂停的品种和触发原因
- 恢复时：Telegram 通知，说明已恢复
- Settings 页面可调整 `volatility_threshold_1h` 和 `volatility_threshold_24h`
