"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

export function RunList() {
  const search = useSearchParams();
  const currentId = search.get("run");
  const { data, isLoading } = trpc.backtest.list.useQuery();

  if (isLoading) {
    return (
      <aside className="w-60 border-r border-border p-3 text-xs text-muted-foreground">
        加载中...
      </aside>
    );
  }

  if (!data || data.length === 0) {
    return (
      <aside className="w-60 border-r border-border p-3 text-xs text-muted-foreground">
        （无历史记录）
      </aside>
    );
  }

  return (
    <aside className="w-60 border-r border-border overflow-y-auto">
      <ul>
        {data.map((run) => {
          const isSelected = run.id === currentId;
          const roiPct = (Number(run.roi) * 100).toFixed(2);
          const roiTone = Number(run.roi) >= 0 ? "text-positive" : "text-destructive";
          return (
            <li key={run.id}>
              <Link
                href={`/backtest?run=${run.id}`}
                className={cn(
                  "block border-l-2 px-3 py-3 hover:bg-accent transition-colors",
                  isSelected ? "border-primary bg-accent" : "border-transparent",
                )}
              >
                <div className="text-xs text-muted-foreground">
                  {new Date(run.startedAt).toISOString().slice(0, 16).replace("T", " ")}
                </div>
                <div className={cn("text-sm font-semibold", roiTone)}>
                  {Number(run.roi) >= 0 ? "+" : ""}
                  {roiPct}%
                </div>
                <div className="text-xs text-muted-foreground">
                  {run.totalTrades} trades
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
