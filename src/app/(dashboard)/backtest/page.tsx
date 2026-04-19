import { Suspense } from "react";
import { BacktestPage } from "@/components/backtest/page";

export default function Page() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-muted-foreground">加载中...</div>}>
      <BacktestPage />
    </Suspense>
  );
}
