-- CreateTable
CREATE TABLE "backtest_runs" (
    "id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3) NOT NULL,
    "from_date" TIMESTAMP(3) NOT NULL,
    "to_date" TIMESTAMP(3) NOT NULL,
    "config" JSONB NOT NULL,
    "total_trades" INTEGER NOT NULL,
    "win_rate" DECIMAL(6,4) NOT NULL,
    "roi" DECIMAL(10,6) NOT NULL,
    "net_pnl" DECIMAL(18,4) NOT NULL,
    "max_drawdown" DECIMAL(18,4) NOT NULL,
    "sharpe_ratio" DECIMAL(10,4) NOT NULL,
    "closed_trades" JSONB NOT NULL,
    "equity_curve" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backtest_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "backtest_runs_started_at_idx" ON "backtest_runs"("started_at");
