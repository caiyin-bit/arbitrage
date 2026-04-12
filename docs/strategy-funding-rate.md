# 资金费率套利 — 详细逻辑拆分

> 整理时间：2026-04-11

## 一、核心原理

永续合约每 8 小时收取/支付一次资金费率（Funding Rate）。不同交易所对同一币种的费率不同，可以在高费率所和低费率所分别开反向仓位，赚取费率差。

```
单次收益 = 仓位价值 × (高费率 - 低费率) - 开仓手续费摊销
```

**为什么费率会不同**：各交易所用户结构不同，多空比例不同，导致费率不同。例如散户多的交易所做多情绪强，费率偏高。

## 二、系统模块拆分

### 模块 1：费率采集（Funding Rate Collection）

**职责**：定时获取各交易所的当前费率和预测费率

- 数据源：REST API 轮询（费率更新频率低，不需要 WebSocket）
- 需要的字段：
  - `current_rate`：当前费率
  - `predicted_rate`：预测下一期费率（部分交易所提供）
  - `next_settlement_time`：下次结算时间
  - `settlement_interval`：结算间隔（通常 8h，部分所 4h 或 1h）
- 采集频率：每 **1-5 分钟** 一次

**数据结构示意**：
```
FundingRate {
  exchange: string
  symbol: string          // 如 "BTC/USDT:USDT"（永续合约统一格式）
  current_rate: decimal    // 如 0.0003 表示 0.03%
  predicted_rate: decimal  // 可选
  next_settlement: int64   // 下次结算时间戳
  interval_hours: int      // 8 / 4 / 1
  timestamp: int64
}
```

### 模块 2：机会检测（Opportunity Detection）

**职责**：找出跨所费率差异足够大的套利机会

**核心逻辑**：
```
对于每个永续合约品种 S：
  收集所有交易所的费率 rates = [(exchange, rate), ...]

  max_rate = max(rates)  // 费率最高的交易所（做空收费率）
  min_rate = min(rates)  // 费率最低的交易所（做多付较少 / 收费率）

  rate_spread = max_rate.rate - min_rate.rate

  年化收益估算：
    if 8h 结算: annualized = rate_spread × 3 × 365
    if 4h 结算: annualized = rate_spread × 6 × 365
    if 1h 结算: annualized = rate_spread × 24 × 365

  if annualized > min_annualized_threshold → 触发信号
```

**信号输出**：
```
Signal {
  symbol: string
  long_exchange: string       // 做多的交易所（费率低/负）
  short_exchange: string      // 做空的交易所（费率高/正）
  rate_spread: decimal
  annualized_yield: decimal
  suggested_size: decimal
}
```

### 模块 3：仓位管理（Position Management）

**职责**：根据信号开仓、持仓、调仓、平仓

#### 3.1 开仓流程

```
1. 收到套利信号 (long_exchange, short_exchange, symbol, size)
2. 检查两边保证金余额是否充足
3. 并发开仓：
   - long_exchange: 开多仓 (market / limit)
   - short_exchange: 开空仓 (market / limit)
4. 确认两边仓位大小一致
5. 记录持仓信息
```

#### 3.2 持仓跟踪

```
Position {
  symbol: string
  long_exchange: string
  long_size: decimal
  long_entry_price: decimal
  short_exchange: string
  short_size: decimal
  short_entry_price: decimal
  open_time: int64
  total_funding_earned: decimal    // 累计已收取费率收益
  total_funding_paid: decimal      // 累计已支付费率
  net_funding_profit: decimal      // 净费率收益
}
```

#### 3.3 调仓/平仓条件

| 条件 | 动作 |
|------|------|
| 费率差收窄到不划算 | 平仓止盈 |
| 费率反转（原高费率所变低） | 立即平仓 |
| 更优机会出现 | 平旧仓 → 开新仓（换所） |
| 单边保证金率接近清算线 | 补充保证金或减仓 |
| 持仓时间过长且收益不达预期 | 平仓释放资金 |

#### 3.4 平仓流程

```
1. 并发平仓：
   - long_exchange: 平多仓
   - short_exchange: 平空仓
2. 计算最终损益：
   净损益 = 累计费率净收入 - 开仓手续费 - 平仓手续费 + 价差损益
   （价差损益：因两边开仓/平仓价格差异产生的盈亏，理论上接近 0）
```

### 模块 4：结算监控（Settlement Monitor）

**职责**：跟踪每次费率结算，记录实际到账金额

**执行逻辑**：
```
每个结算周期（每 8h / 4h / 1h）：
  1. 记录结算前后的账户余额变化
  2. 核对实际收到/支付的费率是否符合预期
  3. 更新持仓的累计收益
  4. 如果实际费率偏离预期超过阈值 → 告警
```

**关键时间点**（以 8h 为例，UTC）：
- 00:00、08:00、16:00

**注意**：需在结算前 **15 分钟** 重新评估费率，因为最终费率在结算前可能变化。

### 模块 5：风控（Risk Control）

| 规则 | 说明 |
|------|------|
| 最大单品种仓位 | 限制单个币种的最大持仓价值 |
| 最大总仓位 | 所有品种总仓位上限 |
| 保证金率监控 | 低于安全线时告警/自动减仓 |
| 费率反转保护 | 费率差翻转超过 N bps 时自动平仓 |
| 滑点保护 | 开仓/平仓价格偏离预期时中止 |
| 交易所风险分散 | 单个交易所仓位不超过总资金的 X% |
| 极端行情保护 | 价格剧烈波动时暂停新开仓 |

**清算风险管理**：
```
安全保证金率 = 当前保证金率 - 维持保证金率
if 安全保证金率 < safety_buffer:
    告警并考虑减仓
```

虽然两边对冲了价格风险，但剧烈波动时一边浮亏可能触发清算，需要：
- 使用较低杠杆（建议 ≤ 3x）
- 两边保留足够保证金余额
- 监控未实现盈亏

### 模块 6：监控与日志（Monitoring）

**需要记录的关键数据**：
- 各交易所各品种的费率历史（用于分析规律）
- 每次结算的实际收益
- 持仓的累计损益曲线
- 保证金使用率
- 费率差的历史分布（用于优化开仓阈值）

## 三、执行时序

```
[定时任务: 每1-5分钟] → [费率采集] → [机会检测]
                                          ↓
                                    无机会 → 继续等待
                                    有机会 → [检查是否已有持仓]
                                                ↓
                                          无持仓 → [开仓]
                                          有持仓 → [评估是否需要调仓]

[定时任务: 结算前15分钟] → [结算监控] → 记录结算收益 → 重新评估持仓

[持续运行] → [风控监控] → 保证金率/费率变化 → 触发告警或自动减仓
```

## 四、关键参数（需实测调优）

| 参数 | 初始建议值 | 说明 |
|------|-----------|------|
| min_rate_spread | 0.01% (1 bps) | 最小费率差阈值 |
| min_annualized_yield | 15% | 最小年化收益阈值 |
| max_leverage | 3x | 最大杠杆倍数 |
| safety_margin_ratio | 50% | 保证金安全缓冲 |
| max_single_position | 20% of total | 单品种最大仓位占比 |
| rate_reversal_exit | -0.005% | 费率差反转平仓阈值 |
| min_holding_periods | 3 | 最少持有结算周期数（覆盖手续费） |

## 五、盈利分析

假设条件：
- 总资金 $10,000（两个交易所各 $5,000 保证金）
- 杠杆 2x，有效仓位 $10,000
- 平均费率差 0.02%/8h
- 每天结算 3 次

```
日收益 = $10,000 × 0.02% × 3 = $6
月收益 ≈ $180
月化收益率 ≈ 1.8%
年化收益率 ≈ 21.6%
```

扣除开平仓手续费（约占收益 10-20%）后：
```
实际年化 ≈ 15%-19%
```

## 六、与直接价差套利的对比

| 维度 | 直接价差套利 | 资金费率套利 |
|------|------------|------------|
| 交易频率 | 高频（每天几十到上百次） | 低频（持仓数天到数周） |
| 单笔利润 | 极小（几个 bps） | 每 8h 结算一次 |
| 技术复杂度 | 高（延迟敏感） | 中（不需要极低延迟） |
| 资金效率 | 高（快进快出） | 中（资金被仓位占用） |
| 收益确定性 | 低（价差瞬息万变） | 较高（费率相对可预测） |
| 主要风险 | 执行风险（滑点、单腿） | 清算风险（极端行情） |
| 适合阶段 | 系统成熟后 | 可以先做起来 |
