import { History } from "lucide-react";

export default function BacktestPage() {
  return (
    <div className="flex flex-col items-center justify-center h-full p-8 gap-6 text-center">
      <div className="h-14 w-14 rounded-2xl bg-muted flex items-center justify-center">
        <History className="h-6 w-6 text-muted-foreground" />
      </div>
      <div className="flex flex-col gap-2 max-w-md">
        <h1 className="text-2xl font-semibold text-foreground">Backtest</h1>
        <p className="text-sm text-muted-foreground">
          Replay historical funding rate spreads against strategy parameters to
          evaluate expected yield, drawdown, and Sharpe ratio. Coming in Plan 3.
        </p>
        <p className="text-xs text-muted-foreground/60 mt-2">
          Preview the design at{" "}
          <code className="text-primary">docs/design/mockups/04-backtest.png</code>
        </p>
      </div>
    </div>
  );
}
