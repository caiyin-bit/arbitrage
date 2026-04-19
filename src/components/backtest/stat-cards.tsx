"use client";
import type { OverallStats } from "@/lib/backtest-aggregate";
import { StatCard } from "@/components/ui/stat-card";
import { TrendingUp, DollarSign, Hash, Percent, TrendingDown } from "lucide-react";

interface Props {
  overall: OverallStats;
}

export function StatCards({ overall }: Props) {
  const roiPct = (overall.roi * 100).toFixed(2);
  const winPct = (overall.winRate * 100).toFixed(1);
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
      <StatCard
        label="ROI"
        value={`${roiPct}%`}
        icon={TrendingUp}
        deltaTone={overall.roi >= 0 ? "positive" : "negative"}
      />
      <StatCard
        label="净收益"
        value={`$${overall.netPnl.toFixed(0)}`}
        icon={DollarSign}
        deltaTone={overall.netPnl >= 0 ? "positive" : "negative"}
      />
      <StatCard label="交易数" value={String(overall.totalTrades)} icon={Hash} />
      <StatCard label="胜率" value={`${winPct}%`} icon={Percent} />
      <StatCard
        label="最大回撤"
        value={`$${overall.maxDrawdown.toFixed(0)}`}
        icon={TrendingDown}
        deltaTone="negative"
      />
    </div>
  );
}
