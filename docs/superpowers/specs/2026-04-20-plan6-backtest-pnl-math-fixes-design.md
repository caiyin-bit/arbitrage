# Plan 6 — 回测 P&L 数学修复

**日期：** 2026-04-20
**分支：** feature/plan6-pnl-math（待建）
**前置：** PR #4 已合并到 main（`4ce100d` OHLCV 过滤 + `7ee0199` 诊断日志）
**范围：** 修复 Vultr 6 个月回测暴露出的 3 个 P&L 数学 bug，全部限定在回测 runner 侧；生产 executor 契约不动。

---

## 背景

v0.2.0 上线后，在 Vultr Tokyo 节点对生产库的 3 交易所 × 5 symbol × 6 个月真实数据做回测，runner 产出 0 笔成交。诊断过程（见 [memory/project_backtest_gap.md](../../../memory/project_backtest_gap.md)）定位到两个根因：

1. **huobi 是唯一边缘源：** Phase 0 检测到的 39 个机会里 100% 都有 huobi 作为一腿。loader 没拉 huobi OHLCV 时，runner 在可交易交易所子集里看不到任何超过 `minSpread=0.0005` 的价差。
2. **HistoricalAdapter 对缺 OHLCV 交易所抛 "no historical data"。** 这条已在 PR #4 `4ce100d` 修掉：`handleFundingCollection` 现在用 `exchange: { ohlcvSnapshots: { some: {} } }` 过滤。

合并 PR #4 后，runner 能在有数据的交易所之间开仓平仓，进而暴露出 3 个 P&L 数学 bug：

| # | 现象 | 影响 |
|---|-----|-----|
| 1 | `cfg.positionSize=500` 直接作为基础币数量传给 executor。BTC @ $77k 下单笔名义 $3880 万 | 单笔 P&L = −$38,898,716，fees = $57,829，整个回测失真 |
| 2 | 3 笔强平交易中有 1 笔 `longExit=0` | P&L 公式把一条"好腿"算成了零退出价 |
| 3 | `win_rate=0` 且 `roi=+0.014%` 同时出现 | aggregate 的 ROI 与 netPnl 方向相反，报表不可信 |

3 个 bug 相互独立，量级都小，合并成一个 PR。

---

## 设计目标

- **正确性：** 回测 P&L 与真实交易语义一致；报表内部各指标相互一致（尤其 ROI 与 netPnl 同号）。
- **最小侵入：** 只动 runner 和 HistoricalAdapter 上层使用的合约解释，不动生产 executor 的 `size` 基础币数量契约。
- **可测试性：** 每个修复都有单元测试覆盖，不靠 6 个月真实数据才能验证。
- **可观测性：** 保留对"真实失败腿"的可见性（不把它伪装成成功）。

### 不在范围内

- 在 Vultr 加载 huobi OHLCV（运维任务，非代码 bug）
- Plan 5 Phase B（UI 触发 + BullMQ 异步队列）
- 生产 executor 任何改动
- aggregate.ts 内部公式重写（修完 equityCurve 末点后，现有公式就已经自洽）

---

## Bug 1 — 仓位规模语义（USD → 基础币数量）

### 现象

`DEFAULT_CONFIG.positionSize = 500`（原意是 $10k 资金下每腿 $500 名义 = 5% 风险暴露），runner 调用处：

```ts
// runner.ts:239-247
await openHedgedPosition(ctx, {
  ...,
  size: cfg.positionSize,  // ← 直接把 500 传下去
  leverage: 1,
});
```

executor 的 `OpenHedgedRequest.size` 合约是**基础币数量**——与合约交易所 ccxt `createOrder(amount)` 语义一致。Runner 实际在 BTC @ $77k 上开了 500 BTC 的仓：
- 名义：$3880 万/腿
- 手续费（0.05%）：$19,250/腿 × 2 腿 = $38,500/开仓
- 单笔价差 P&L 也按 500 BTC × 价差计算 → 动辄千万美元量级

### 根因

类型定义 [types.ts:7](../../src/server/services/backtest/types.ts) 的 `positionSize: number` 未写单位。作者原意 USD，使用时当基础币数量——这是一个纯粹的单位错误。

### 修复

**策略：** 只在 runner 侧转换。生产 executor 的 "size 是基础币数量" 契约与 ccxt 下单 API 一致，是正确的；不动。

**改动点 1：** [types.ts](../../src/server/services/backtest/types.ts)：在 `positionSize` 字段上加注释明确语义。

```ts
export interface BacktestConfig {
  ...
  /** 每腿名义金额（USD）。runner 会按开仓时价格换算为基础币数量再传给 executor。 */
  positionSize: number;
  ...
}
```

不改字段名——全量改 `positionSize` → `positionSizeUsd` 会动 `BacktestConfig` 所有使用点、向导 UI（若有）、数据库 JSON 字段、历史 BacktestRun 数据的反序列化——收益有限，改动面大。注释足以。

**改动点 2：** [runner.ts](../../src/server/services/backtest/runner/runner.ts) 的 `handleFundingCollection` 开仓循环：

```ts
for (const op of ops.slice(0, slots)) {
  try {
    const longAdapter = await ctx.adapterFor(op.longExchange);
    const ticker = await longAdapter.getPrice(op.symbol);
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
    ...
  }
  ...
}
```

**设计取舍：**

- 用 long 腿价格作基准——long/short 两腿价差通常 < 1bp，差异可忽略。若未来想更严谨，可以取 min/avg，但当前阶段不必要。
- 每次开仓多调一次 `getPrice`——HistoricalAdapter 的 `getPrice` 走 DB，一次 ~1ms，相对 runner 内已有的 `fundingRateSnapshot.findMany + findOpportunities`，边际成本可忽略。
- `baseQty` 为浮点——不做 `Math.floor` 或合约最小单位对齐。HistoricalAdapter 不强制精度（模拟层），生产执行时 ccxt 会处理精度；这里对齐会引入和 `positionSize` USD 不等价的误差，不划算。

### 测试

```ts
// runner.test.ts (新增)
it("converts positionSize from USD to base units at open", async () => {
  // 固定 BTC 价 $50,000，positionSize=500 USD
  // 期望 runner 传给 executor 的 size = 0.01 BTC
});
```

---

## Bug 2 — 强平交易里 `longExit = 0`

### 现象

3 笔强平交易中有 1 笔的 `longExit` 字段为 0。排查发现该仓位的 CLOSE_LONG trade_log 的 `price` 仍是初始值 0（从未被 reconcile 更新）。

### 根因

`execute-close.ts` 的流程：

1. 预写 PENDING trade_log，`price: 0, signedQty: -longSize, fee: 0`（[execute-close.ts:67-95](../../src/server/services/executor/execute-close.ts)）
2. `submitCloseAndReconcile` 调 `adapter.closePosition` — 若抛错，**catch 吞掉**（[execute-close.ts:166-168](../../src/server/services/executor/execute-close.ts)）
3. 然后调 `reconcileOrder` — adapter.getOrder 抛 "no order"（因为第 2 步从未 `this.orders.set`），`reconcileOrder` catch 并返回 "pending"
4. trade_log 维持 PENDING/price=0/signedQty=-longSize

`buildClosedTrades` 的 `wAvg` [runner.ts:327-331](../../src/server/services/backtest/runner/runner.ts)：

```ts
const wAvg = (ls: TradeLog[]) => {
  const totalQty = ls.reduce((s, l) => s + Math.abs(Number(l.signedQty)), 0);
  if (totalQty === 0) return 0;
  return ls.reduce((s, l) => s + Number(l.price) * Math.abs(Number(l.signedQty)), 0) / totalQty;
};
```

不区分 log 状态——把 PENDING 的 `price=0, qty=longSize` 当成"成交价为 0 的一笔"加权进去。如果另一笔成功平仓 log 也在同一桶内，两者加权得到一个被 0 拉低的均价；如果这腿只失败了这一笔，`longExit` 就是 0。

### 修复

**改动点：** [runner.ts:327-331](../../src/server/services/backtest/runner/runner.ts) 的 `wAvg`，只纳入已成交（FILLED/PARTIAL）log：

```ts
const wAvg = (ls: TradeLog[]) => {
  const filled = ls.filter((l) => l.status === "FILLED" || l.status === "PARTIAL");
  const totalQty = filled.reduce((s, l) => s + Math.abs(Number(l.signedQty)), 0);
  if (totalQty === 0) return 0;
  return filled.reduce(
    (s, l) => s + Number(l.price) * Math.abs(Number(l.signedQty)),
    0,
  ) / totalQty;
};
```

**边界情形：** 一条腿**全部**平仓 log 都是 PENDING/FAILED 时，`totalQty=0 → 返回 0`。此时 `longExit=0` 仍出现，但此时是真实的"腿平仓失败"，不是"好腿被拉零"。加一条 ctx.log 警告便于发现：

```ts
// buildClosedTrades 内：
if (longExit === 0 && longSize > 0) {
  // 只记录，不改变返回
  console.warn(`[bt] position ${p.id} longExit=0: close leg may have failed; grossPnl will be skewed`);
}
// shortExit 同理
```

这个 warning 只在 runner 进程输出，不污染 equityCurve 或 BacktestRun JSON。

**为什么不改 execute-close.ts？**

让 close 失败不"静默"是生产层考虑，超出本 Plan 的范围。本 Plan 目标是让回测数学正确——当前修复已足够：已成交腿算真实均价，未成交腿显式报 0 并带 warning。生产层容错改动（如重试、抛错打断 force-close 循环）可作为后续独立 bug 处理。

### 测试

```ts
// runner-aggregate.test.ts (新增)
it("wAvg ignores PENDING trade logs", () => {
  const logs = [
    { status: "FILLED", price: 100, signedQty: -10 },
    { status: "PENDING", price: 0, signedQty: -10 },
  ];
  expect(wAvg(logs)).toBe(100);  // 旧版会算成 50
});

it("wAvg returns 0 when all logs are PENDING", () => {
  const logs = [{ status: "PENDING", price: 0, signedQty: -10 }];
  expect(wAvg(logs)).toBe(0);
});
```

---

## Bug 3 — 汇总 ROI 与 win_rate 方向不一致

### 现象

观测到一个回测报表：
- `totalTrades: 3`
- `winRate: 0`（所有交易都亏）
- `netPnl: -X`（三笔负 netPnl 之和，负数）
- `roi: +0.014%`（正数）

aggregate 的 ROI 公式用 `(finalEquity - initialCapital) / initialCapital`，netPnl 用 `sum(trades.netPnl)`。若所有仓位闭合，两者应同号。

### 根因

runner.ts 的 equityCurve 更新流程：

- **时间线循环内** [runner.ts:56-95](../../src/server/services/backtest/runner/runner.ts)：每跨天加一个点
- **时间线结束后** [runner.ts:98-110](../../src/server/services/backtest/runner/runner.ts)：强平所有未平仓 position
- **最终返回** [runner.ts:112-113](../../src/server/services/backtest/runner/runner.ts)：`closedTrades` 包含所有已关闭（包括强平的）仓位

强平循环**没有追加 equityCurve 点**。所以：
- `finalEquity = equityCurve[last].equity` — 强平前的陈旧值
- `trades` — 已包含强平仓位的 grossPnl/fees/fundingPnl

强平仓位若是大亏损，`sum(trades.netPnl)` 为负；`finalEquity` 仍是强平前那个正数（相对 initialCapital）。两者符号相反。

### 修复

**改动点：** [runner.ts:98-113](../../src/server/services/backtest/runner/runner.ts) 的强平循环之后、return 之前，追加一个 final equity 点：

```ts
// Force-close remaining open positions at config.to
clock.setTime(config.to);
const openAtEnd = await store.listOpenPositions();
for (const p of openAtEnd) {
  try {
    await closeHedgedPosition(ctx, { ... });
  } catch (err) { ctx.log("force-close error", { ... }); }
}

// Append final equity point so roi and netPnl are consistent by construction
const finalTrades = buildClosedTrades(store, exchangeNamesById);
const finalRealized = finalTrades.reduce((s, t) => s + (t.grossPnl - t.fees), 0);
const finalFunding = store.allSettlements().reduce((s, x) => s + Number(x.fundingAmount), 0);
equityCurve.push({
  date: config.to,
  equity: config.initialCapital + finalRealized + finalFunding,
  grossPnl: finalTrades.reduce((s, t) => s + t.grossPnl, 0),
  netPnl: finalTrades.reduce((s, t) => s + t.netPnl, 0),
  totalFees: finalTrades.reduce((s, t) => s + t.fees, 0),
});

return { config, startedAt, finishedAt: new Date(), closedTrades: finalTrades, equityCurve };
```

**不变量证明：** 当所有仓位都已关闭：

```
finalEquity       = initialCapital + sum(grossPnl − fees) + sum(fundingAmount)
sum(trades.netPnl) = sum(grossPnl) + sum(fundingPnl)      − sum(fees)
                   = sum(grossPnl) + sum(fundingAmount)   − sum(fees)    // 因为所有仓位均已平，所有 settlement 都属于某笔 trade
                   = finalEquity − initialCapital
```

于是 `roi = (finalEquity - initialCapital) / initialCapital = sum(netPnl) / initialCapital`，与 netPnl 同号。

**边界情形：**

- `config.to` 落在 equityCurve 最后一个日度点的同一天：新增的 final 点与最后日度点的 date 可能相同但 equity 不同。aggregate 的 maxDrawdown 迭代 equityCurve 数组顺序无所谓——用等号比较 date 的代码没有。sharpe 的 dailyReturns 计算基于相邻两点比值，第一天到第二天的收益率可能偏大，但对 6 个月样本量几乎无影响。
- `openAtEnd.length === 0`：强平循环空跑，final 点与最后日度点的 equity 相等——无害冗余，保留。
- 整个回测零交易零结算：final 点 equity = initialCapital，roi=0，win_rate=0——一致。

### 测试

```ts
// runner.test.ts (新增)
it("finalEquity minus initialCapital equals sum of trades.netPnl", async () => {
  const result = await runBacktest(testConfig);
  const netPnl = result.closedTrades.reduce((s, t) => s + t.netPnl, 0);
  const finalEquity = result.equityCurve[result.equityCurve.length - 1].equity;
  expect(Math.abs((finalEquity - testConfig.initialCapital) - netPnl)).toBeLessThan(0.01);
});

it("aggregate roi and netPnl have the same sign", async () => {
  const result = await runBacktest(testConfig);
  const agg = aggregate(result.closedTrades, result.equityCurve, testConfig.initialCapital);
  if (agg.overall.netPnl > 0) expect(agg.overall.roi).toBeGreaterThan(0);
  if (agg.overall.netPnl < 0) expect(agg.overall.roi).toBeLessThan(0);
});
```

---

## 实施顺序

单个分支、单个 PR、三个 commit：

1. **commit 1** — Bug 2（wAvg 过滤）：最独立，最小
2. **commit 2** — Bug 3（final equity point）：依赖 wAvg 返回正确均价，所以排在 Bug 2 之后
3. **commit 3** — Bug 1（size USD 转换）：改动面最大（runner 调用点），单独一个 commit 方便 review 和 revert

每个 commit 配对应的单元测试。

---

## 验证

### 本地

```bash
pnpm test src/server/services/backtest/runner
```

应当看到新增 4-5 个测试通过，且原有测试不回归。

### 生产（deferred）

Vultr 上：
1. 先在回测容器内加载 huobi 6 个月 OHLCV（运维任务，Plan 6 不做）
2. 重跑 6 个月回测
3. 检查报表：
   - [ ] 所有开仓名义金额 ≈ $500（`longEntry × longSize ≈ 500`）
   - [ ] 没有 `longExit=0 或 shortExit=0` 的行，除非对应的 runner 日志有 close 失败记录
   - [ ] `overall.roi` 与 `overall.netPnl` 符号一致
   - [ ] `|finalEquity - initialCapital - sum(netPnl)| < $0.01`

### 不做的事

- 不改 `scripts/backtest-smoke.ts`（synthetic 数据太简单，这些 bug 只在真实 6 个月数据上可见）
- 不做 production executor 的 close-failure 传播改造（独立 bug，未来 Plan）
- 不改 aggregate.ts（修完 equityCurve 末点后，现有公式已自洽）

---

## 风险与回滚

- **风险：** Bug 1 的 `getPrice` 额外 DB 查询在极长时间线上（> 1 年）可能放大回测延迟。当前 6 个月实测已接受，更长回测再评估。
- **风险：** Bug 3 的 final 点会改变 BacktestRun JSON 的 equityCurve 数组长度 +1。历史 BacktestRun 反序列化无关（字段 shape 未变）。UI 图表消费者（Recharts）用 date 排序绘制，多一个点无影响。
- **回滚：** 三个 commit 各自独立，逐个 revert 即可。数据库层面无 schema 变化。

---

## 交付物

- 分支：`feature/plan6-pnl-math`
- 单 PR：`fix(backtest): three P&L math fixes`
- 测试：`src/server/services/backtest/runner/*.test.ts` 扩充
- 合并后：memory 中的 "3 new bugs" 段落标记为 resolved
