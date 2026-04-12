# 直接价差套利 — 详细逻辑拆分

> 整理时间：2026-04-11

## 一、核心原理

同一交易对在不同交易所存在价差时，在低价所买入、高价所卖出，赚取价差扣除手续费后的利润。两边预存资金，不需要跨所转币。

```
利润 = (卖出价 - 买入价) × 数量 - 买入手续费 - 卖出手续费
```

## 二、系统模块拆分

### 模块 1：行情采集（Market Data）

**职责**：实时获取多交易所行情数据

- 数据源：WebSocket 订阅各交易所的 orderbook / ticker
- 需要的字段：
  - `best_bid`（最优买价）+ `bid_size`（买一量）
  - `best_ask`（最优卖价）+ `ask_size`（卖一量）
  - `timestamp`（交易所时间戳）
- 交易所覆盖：Binance、OKX、Bybit、Gate.io 等
- 关键指标：数据延迟需控制在 **50ms 以内**

**数据结构示意**：
```
Ticker {
  exchange: string
  symbol: string        // 统一交易对格式，如 "BTC/USDT"
  best_bid: decimal
  bid_size: decimal
  best_ask: decimal
  ask_size: decimal
  timestamp: int64      // 毫秒
  local_timestamp: int64 // 本地收到时间
}
```

### 模块 2：价差检测（Spread Detection）

**职责**：实时计算跨所价差，判断是否存在套利机会

**核心逻辑**：
```
对于交易对 S 的每一对交易所 (A, B)：

  方向1：A 买 B 卖
    spread_1 = B.best_bid - A.best_ask
    profit_1 = spread_1 - fee_A_taker × A.best_ask - fee_B_taker × B.best_bid

  方向2：B 买 A 卖
    spread_2 = A.best_bid - B.best_ask
    profit_2 = spread_2 - fee_B_taker × B.best_ask - fee_A_taker × A.best_bid

  if profit_1 > min_profit_threshold → 触发方向1信号
  if profit_2 > min_profit_threshold → 触发方向2信号
```

**可执行量计算**：
```
max_qty = min(
  卖方所的 bid_size,        // 对手盘深度
  买方所的 ask_size,
  买方所的可用余额 / ask_price,
  卖方所的可用币余额,
  单笔最大限额               // 风控参数
)
```

### 模块 3：执行引擎（Execution）

**职责**：接收套利信号后，同时向两个交易所下单

**执行流程**：
```
1. 收到套利信号 (exchange_buy, exchange_sell, symbol, qty, expected_profit)
2. 并发下单：
   - exchange_buy: market buy / limit buy (best_ask)
   - exchange_sell: market sell / limit sell (best_bid)
3. 等待两边返回成交结果
4. 记录实际成交价、成交量、手续费
5. 计算实际利润
```

**订单类型选择**：
- **Market Order**：成交确定性高，但可能滑点
- **Limit Order (IOC)**：挂在对手价，未成交部分立即取消，控制滑点
- 推荐起步用 **Limit IOC**

**异常处理**：
| 场景 | 处理 |
|------|------|
| 一边成交、一边未成交 | 未成交侧立即市价补单或撤单后平仓 |
| 两边都部分成交 | 按较小成交量对齐，剩余部分撤单 |
| 下单超时 | 查询订单状态，未成交则撤单 |
| API 限频 | 退避等待，放弃本次机会 |

### 模块 4：仓位与资金管理（Position & Balance）

**职责**：跟踪各交易所的资金分布，触发再平衡

**资金模型**：
```
每个交易所维护：
  quote_balance: USDT 余额（用于买入）
  base_balance:  币余额（用于卖出）
```

**再平衡触发条件**：
```
if 某交易所 quote_balance < min_quote_threshold:
    需要从其他所转入 USDT
if 某交易所 base_balance < min_base_threshold:
    需要从其他所转入币
```

**再平衡方式**：
- 手动转账（初期推荐，安全可控）
- 自动化提币（需 API 提币权限，风险高）

### 模块 5：风控（Risk Control）

**核心规则**：

| 规则 | 说明 |
|------|------|
| 最小利润阈值 | 单笔预期利润 < 阈值则不执行 |
| 单笔最大金额 | 限制单次套利的最大资金量 |
| 数据新鲜度 | 行情时间戳超过 N ms 则丢弃 |
| 单腿敞口限制 | 一边成交另一边失败时的最大敞口 |
| 每分钟最大交易次数 | 防止异常行情下过度交易 |
| 日亏损上限 | 累计亏损达到阈值后暂停 |
| 交易所异常检测 | API 连续失败 N 次后暂停该交易所 |

### 模块 6：监控与日志（Monitoring）

**需要记录的关键数据**：
- 每一次套利机会：时间、交易对、两所价格、预期利润
- 每一次执行：实际成交价、成交量、手续费、实际利润
- 价差分布统计：用于优化阈值参数
- 资金余额变化：用于审计和排错
- 系统延迟：数据延迟、下单延迟、成交延迟

## 三、执行时序

```
[交易所A WS] ──ticker──→ [行情采集] ──→ [价差检测] ──→ 无机会 → 继续监听
[交易所B WS] ──ticker──→ [行情采集] ──→ [价差检测] ──→ 有机会 → [执行引擎]
                                                                    ├─→ 交易所A 下单
                                                                    └─→ 交易所B 下单
                                                                          ↓
                                                              [成交结果] → [仓位更新] → [日志记录]
```

## 四、关键参数（需实测调优）

| 参数 | 初始建议值 | 说明 |
|------|-----------|------|
| min_profit_bps | 3-5 bps | 最小利润阈值（基点） |
| max_order_size | $500 | 单笔最大下单金额 |
| data_stale_ms | 200 | 行情数据过期时间 |
| max_single_leg_exposure | $1000 | 单腿最大敞口 |
| rebalance_threshold | 30% | 资金偏移触发再平衡的比例 |

## 五、盈利分析

假设条件：
- 总资金 $10,000（分布在两个交易所各 $5,000）
- 平均价差 5 bps，手续费 taker 各 0.1%（共 2 bps 成本）
- 净利润 3 bps/笔
- 每天执行 50 次，单笔 $2,000

```
日利润 = 50 × $2,000 × 0.03% = $30
月利润 ≈ $900
月化收益率 ≈ 9%
```

注意：以上为理想估算，实际受市场波动、竞争、滑点影响，**实际收益可能低 50%-80%**。
