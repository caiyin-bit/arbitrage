"use client";
import { useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { RunList } from "./run-list";
import { RunDetail } from "./run-detail";
import { EmptyState } from "./empty-state";

export function BacktestPage() {
  const search = useSearchParams();
  const urlRunId = search.get("run");
  const { data: runs, isLoading } = trpc.backtest.list.useQuery();

  if (isLoading) {
    return <div className="flex-1 p-8 text-sm text-muted-foreground">加载中...</div>;
  }
  if (!runs || runs.length === 0) {
    return (
      <div className="flex-1 flex">
        <EmptyState />
      </div>
    );
  }

  const selectedId = urlRunId ?? runs[0].id;

  return (
    <div className="flex-1 flex overflow-hidden">
      <RunList />
      <RunDetail runId={selectedId} />
    </div>
  );
}
