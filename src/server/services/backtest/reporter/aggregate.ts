import type { ClosedTrade, EquityCurvePoint } from "@/server/services/backtest/types";

export interface OverallStats {
  totalTrades: number; winRate: number;
  grossPnl: number; netPnl: number; totalFees: number; feeRatio: number;
  maxDrawdown: number; maxDrawdownDate: Date | null;
  initialCapital: number; finalEquity: number;
  roi: number; annualizedRoi: number;
  sharpeRatio: number; avgHoldHours: number;
}
export interface GroupStat { key: string; count: number; netPnl: number; grossPnl: number; fees: number; }
export interface Aggregated {
  overall: OverallStats;
  bySymbol: GroupStat[];
  byExchangePair: GroupStat[];
  byHourOfDay: GroupStat[];
  byDayOfWeek: GroupStat[];
  dailyPnlHistogram: { bin: number; count: number }[];
  holdDurationBuckets: { bucket: string; count: number }[];
  feeBreakdown: { totalFees: number; netPnl: number };
}

export function aggregate(
  trades: ClosedTrade[],
  equityCurve: EquityCurvePoint[],
  initialCapital: number,
): Aggregated {
  const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : initialCapital;
  const grossPnl = trades.reduce((s, t) => s + t.grossPnl, 0);
  const netPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const totalFees = trades.reduce((s, t) => s + t.fees, 0);
  const wins = trades.filter((t) => t.netPnl > 0).length;

  let peak = initialCapital, maxDrawdown = 0;
  let maxDrawdownDate: Date | null = null;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak - p.equity;
    if (dd > maxDrawdown) { maxDrawdown = dd; maxDrawdownDate = p.date; }
  }

  const days = equityCurve.length;
  const roi = (finalEquity - initialCapital) / initialCapital;
  const annualizedRoi = days > 0 ? Math.pow(1 + roi, 365 / days) - 1 : 0;

  const dailyReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev > 0) dailyReturns.push((equityCurve[i].equity - prev) / prev);
  }
  const mean = dailyReturns.length ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const variance = dailyReturns.length ? dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyReturns.length : 0;
  const stdev = Math.sqrt(variance);
  const sharpe = stdev > 0 ? (mean / stdev) * Math.sqrt(365) : 0;

  const avgHoldHours = trades.length ? trades.reduce((s, t) => s + t.holdHours, 0) / trades.length : 0;

  const overall: OverallStats = {
    totalTrades: trades.length,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    grossPnl, netPnl, totalFees,
    feeRatio: grossPnl !== 0 ? totalFees / Math.abs(grossPnl) : 0,
    maxDrawdown, maxDrawdownDate,
    initialCapital, finalEquity,
    roi, annualizedRoi,
    sharpeRatio: sharpe,
    avgHoldHours,
  };

  return {
    overall,
    bySymbol: groupBy(trades, (t) => t.symbol),
    byExchangePair: groupBy(trades, (t) => `${t.longExchange}→${t.shortExchange}`),
    byHourOfDay: groupBy(trades, (t) => String(t.openedAt.getUTCHours())),
    byDayOfWeek: groupBy(trades, (t) => String(t.openedAt.getUTCDay())),
    dailyPnlHistogram: histogram(trades.map((t) => t.netPnl), 20),
    holdDurationBuckets: [
      { bucket: "<1h", count: trades.filter((t) => t.holdHours < 1).length },
      { bucket: "1-8h", count: trades.filter((t) => t.holdHours >= 1 && t.holdHours < 8).length },
      { bucket: "8-24h", count: trades.filter((t) => t.holdHours >= 8 && t.holdHours < 24).length },
      { bucket: "24-72h", count: trades.filter((t) => t.holdHours >= 24 && t.holdHours < 72).length },
      { bucket: ">=72h", count: trades.filter((t) => t.holdHours >= 72).length },
    ],
    feeBreakdown: { totalFees, netPnl },
  };
}

function groupBy(trades: ClosedTrade[], key: (t: ClosedTrade) => string): GroupStat[] {
  const m = new Map<string, GroupStat>();
  for (const t of trades) {
    const k = key(t);
    const g = m.get(k) ?? { key: k, count: 0, netPnl: 0, grossPnl: 0, fees: 0 };
    g.count += 1; g.netPnl += t.netPnl; g.grossPnl += t.grossPnl; g.fees += t.fees;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.netPnl - a.netPnl);
}

function histogram(values: number[], bins: number) {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const step = (max - min) / bins;
  const out = Array.from({ length: bins }, (_, i) => ({ bin: min + i * step, count: 0 }));
  for (const v of values) {
    const i = Math.min(bins - 1, Math.floor((v - min) / (step || 1)));
    out[i].count += 1;
  }
  return out;
}
