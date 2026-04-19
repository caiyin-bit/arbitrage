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
