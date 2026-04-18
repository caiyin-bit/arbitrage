-- CreateIndex
CREATE UNIQUE INDEX "funding_rate_snapshots_exchange_id_symbol_collected_at_key" ON "funding_rate_snapshots"("exchange_id", "symbol", "collected_at");
