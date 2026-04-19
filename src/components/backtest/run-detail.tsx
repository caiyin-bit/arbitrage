"use client";
import { trpc } from "@/lib/trpc";
import type { ClosedTrade, EquityCurvePoint } from "@/server/services/backtest/types";
import { aggregate } from "@/lib/backtest-aggregate";
import { MetadataBar } from "./metadata-bar";
import { StatCards } from "./stat-cards";
import { ChartGrid } from "./chart-grid";

interface Props {
  runId: string;
}

export function RunDetail({ runId }: Props) {
  const { data: run, isLoading, error } = trpc.backtest.get.useQuery({ id: runId });

  if (isLoading) {
    return <div className="p-8 text-sm text-muted-foreground">加载中...</div>;
  }
  if (error || !run) {
    return <div className="p-8 text-sm text-destructive">加载失败：{error?.message ?? "unknown"}</div>;
  }

  const closedTrades = (run.closedTrades as unknown as ClosedTrade[]).map((t) => ({
    ...t,
    openedAt: new Date(t.openedAt),
    closedAt: new Date(t.closedAt),
  }));
  const equityCurve = (run.equityCurve as unknown as EquityCurvePoint[]).map((p) => ({
    ...p,
    date: new Date(p.date),
  }));
  const initialCapital =
    typeof (run.config as { initialCapital?: number })?.initialCapital === "number"
      ? (run.config as { initialCapital: number }).initialCapital
      : 10_000;

  const agg = aggregate(closedTrades, equityCurve, initialCapital);

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <MetadataBar from={run.fromDate} to={run.toDate} config={run.config} />
      <StatCards overall={agg.overall} />
      <ChartGrid agg={agg} equityCurve={equityCurve} />
    </div>
  );
}
