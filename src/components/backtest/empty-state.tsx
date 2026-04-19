"use client";
import { History } from "lucide-react";

export function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full p-8 gap-4 text-center">
      <div className="h-12 w-12 rounded-xl bg-muted flex items-center justify-center">
        <History className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="max-w-md space-y-2">
        <h2 className="text-lg font-semibold text-foreground">还没有回测记录</h2>
        <p className="text-sm text-muted-foreground">
          用 CLI 跑第一次回测，页面会自动显示。
        </p>
      </div>
      <pre className="text-xs bg-muted/30 rounded px-3 py-2 text-foreground">
        pnpm tsx src/server/services/backtest/cli.ts --phase 0
      </pre>
      <pre className="text-xs bg-muted/30 rounded px-3 py-2 text-foreground">
        pnpm tsx src/server/services/backtest/cli.ts
      </pre>
    </div>
  );
}
