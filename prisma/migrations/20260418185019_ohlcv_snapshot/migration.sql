-- CreateTable
CREATE TABLE "ohlcv_snapshots" (
    "id" TEXT NOT NULL,
    "exchange_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "open_time" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(20,8) NOT NULL,
    "high" DECIMAL(20,8) NOT NULL,
    "low" DECIMAL(20,8) NOT NULL,
    "close" DECIMAL(20,8) NOT NULL,
    "volume" DECIMAL(30,8) NOT NULL,

    CONSTRAINT "ohlcv_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ohlcv_snapshots_exchange_id_symbol_timeframe_open_time_key" ON "ohlcv_snapshots"("exchange_id", "symbol", "timeframe", "open_time");

-- CreateIndex
CREATE INDEX "ohlcv_snapshots_symbol_open_time_idx" ON "ohlcv_snapshots"("symbol", "open_time");

-- AddForeignKey
ALTER TABLE "ohlcv_snapshots" ADD CONSTRAINT "ohlcv_snapshots_exchange_id_fkey" FOREIGN KEY ("exchange_id") REFERENCES "exchanges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
