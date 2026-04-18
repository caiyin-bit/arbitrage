# 回测引擎使用手册

## 前置步骤

1. `./dev.sh` 跑起 dev 环境（Postgres + Redis）。
2. Exchange 表里有 `binance` / `okx` / `bybit` 三行（用 seed 或 SQL 插入）。

## 拉历史数据

```
pnpm tsx src/server/services/backtest/data-loader/cli.ts \
  [--from YYYY-MM-DD] [--to YYYY-MM-DD] \
  [--exchanges binance,okx,bybit] \
  [--symbols BTC/USDT:USDT,ETH/USDT:USDT,...]
```

默认：最近 180 天、三交易所、5 币种、1h 粒度。耗时 2–5 分钟。

**已知**：某些区域 IP 会被 Binance（451）或 Bybit（403）geo-block；loader 已做 per-(exchange, symbol) 错误隔离，失败者被记在 `totals.failed` 里，其它继续。

## 跑 Phase 0 gate

```
pnpm tsx src/server/services/backtest/cli.ts --phase 0
```

输出：`opps=<N> pnl=$<X> verdict=positive|weak|negative`。

- **positive (ROI > 10%)**: 继续完整回测
- **negative (ROI ≤ 0)**: 停下来重新评估策略

## 跑完整回测

```
pnpm tsx src/server/services/backtest/cli.ts [选项]
```

CLI 选项：

| 选项 | 默认 | 说明 |
|---|---|---|
| `--from` / `--to` | 最近 180 天 | 回测范围 |
| `--capital` | 10000 | 初始资金 |
| `--size` | 500 | 单次仓位 |
| `--max-concurrent` | 3 | 并发仓位上限 |
| `--min-spread` | 0.0005 | 最小费率差 |
| `--min-apy` | 0.1 | 最小年化 |
| `--slippage-bps` | 3 | 滑点（bps） |
| `--failure-rate` | 0.02 | 订单失败率 |
| `--no-failures` | — | 禁用失败率（= 0） |
| `--seed` | plan4-default | PRNG 种子 |
| `--no-vol-pause` | — | 关闭 volatility pause |
| `--output` | docs/backtest-reports | 输出目录 |

## 读报告

`docs/backtest-reports/<timestamp>/`：
- `report.html` — 浏览器双击看（5 卡片 + 7 ECharts 图表）
- `report.md` — 文字摘要，可 git diff 对比多次回测
- `trades.csv` — 每笔 ClosedTrade
- `daily.csv` — 每日 EquityCurvePoint

`docs/backtest-reports/example/` 是 git 追踪的 baseline；其它目录不入 git。
