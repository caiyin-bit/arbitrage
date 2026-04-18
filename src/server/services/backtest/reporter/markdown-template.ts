import type { Aggregated } from "./aggregate";
import type { BacktestConfig } from "@/server/services/backtest/types";

export function renderMarkdown(config: BacktestConfig, agg: Aggregated): string {
  const o = agg.overall;
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const $ = (x: number) => `$${x.toFixed(2)}`;
  return [
    `# 回测报告 — ${config.from.toISOString().slice(0, 10)} 到 ${config.to.toISOString().slice(0, 10)}`,
    ``,
    `## 核心指标`,
    ``,
    `| 指标 | 值 |`,
    `|---|---|`,
    `| 初始资金 | ${$(o.initialCapital)} |`,
    `| 最终净值 | ${$(o.finalEquity)} |`,
    `| **ROI** | **${pct(o.roi)}** |`,
    `| 年化 ROI | ${pct(o.annualizedRoi)} |`,
    `| 交易数 | ${o.totalTrades} |`,
    `| 胜率 | ${pct(o.winRate)} |`,
    `| 总毛收益 | ${$(o.grossPnl)} |`,
    `| 总手续费 | ${$(o.totalFees)} |`,
    `| 总净收益 | ${$(o.netPnl)} |`,
    `| 最大回撤 | ${$(o.maxDrawdown)}${o.maxDrawdownDate ? ` (${o.maxDrawdownDate.toISOString().slice(0, 10)})` : ""} |`,
    `| Sharpe | ${o.sharpeRatio.toFixed(2)} |`,
    `| 平均持仓 | ${o.avgHoldHours.toFixed(1)}h |`,
    ``,
    `## 按交易所对 P&L`,
    ``,
    tableOf(agg.byExchangePair),
    ``,
    `## 按币种 P&L`,
    ``,
    tableOf(agg.bySymbol),
    ``,
    `## 参数`,
    ``,
    "```json",
    JSON.stringify(config, null, 2),
    "```",
    ``,
  ].join("\n");
}

function tableOf(rows: { key: string; count: number; netPnl: number; grossPnl: number; fees: number }[]): string {
  if (rows.length === 0) return "_(no data)_";
  return [
    `| 分组 | 交易数 | 毛 P&L | 手续费 | 净 P&L |`,
    `|---|---|---|---|---|`,
    ...rows.map((r) => `| ${r.key} | ${r.count} | $${r.grossPnl.toFixed(2)} | $${r.fees.toFixed(2)} | $${r.netPnl.toFixed(2)} |`),
  ].join("\n");
}
