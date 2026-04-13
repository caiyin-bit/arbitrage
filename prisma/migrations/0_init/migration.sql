-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('DETECTED', 'NOTIFIED', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPENING', 'OPEN', 'CLOSING', 'CLOSED', 'RESCUE');

-- CreateEnum
CREATE TYPE "CloseReason" AS ENUM ('MANUAL', 'RATE_REVERSAL', 'TAKE_PROFIT', 'RISK_CONTROL');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('LONG', 'SHORT');

-- CreateEnum
CREATE TYPE "TradeAction" AS ENUM ('OPEN', 'CLOSE', 'RESCUE');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT_IOC');

-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('PENDING', 'FILLED', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "exchanges" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
    "api_secret" TEXT NOT NULL,
    "passphrase" TEXT,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "fee_rate" DECIMAL(10,6) NOT NULL DEFAULT 0.001,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exchanges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_rate_snapshots" (
    "id" TEXT NOT NULL,
    "exchange_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "current_rate" DECIMAL(18,10) NOT NULL,
    "predicted_rate" DECIMAL(18,10),
    "next_settlement" TIMESTAMP(3) NOT NULL,
    "interval_hours" INTEGER NOT NULL,
    "collected_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funding_rate_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_rate_hourly" (
    "id" TEXT NOT NULL,
    "exchange_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "avg_rate" DECIMAL(18,10) NOT NULL,
    "max_rate" DECIMAL(18,10) NOT NULL,
    "min_rate" DECIMAL(18,10) NOT NULL,
    "sample_count" INTEGER NOT NULL,

    CONSTRAINT "funding_rate_hourly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunities" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "long_exchange_id" TEXT NOT NULL,
    "short_exchange_id" TEXT NOT NULL,
    "long_rate" DECIMAL(18,10) NOT NULL,
    "short_rate" DECIMAL(18,10) NOT NULL,
    "rate_spread" DECIMAL(18,10) NOT NULL,
    "annualized_yield" DECIMAL(10,4) NOT NULL,
    "suggested_size" DECIMAL(20,8) NOT NULL,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'DETECTED',
    "cooldown_until" TIMESTAMP(3),
    "detected_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "opportunity_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "long_exchange_id" TEXT NOT NULL,
    "long_size" DECIMAL(20,8) NOT NULL,
    "long_avg_entry_price" DECIMAL(20,8) NOT NULL,
    "short_exchange_id" TEXT NOT NULL,
    "short_size" DECIMAL(20,8) NOT NULL,
    "short_avg_entry_price" DECIMAL(20,8) NOT NULL,
    "status" "PositionStatus" NOT NULL DEFAULT 'OPENING',
    "close_reason" "CloseReason",
    "opened_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_logs" (
    "id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "exchange_id" TEXT NOT NULL,
    "execution_id" TEXT NOT NULL,
    "client_order_id" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "action" "TradeAction" NOT NULL,
    "order_type" "OrderType" NOT NULL,
    "price" DECIMAL(20,8) NOT NULL,
    "signed_qty" DECIMAL(20,8) NOT NULL,
    "fee" DECIMAL(20,8) NOT NULL,
    "exchange_order_id" TEXT,
    "status" "TradeStatus" NOT NULL DEFAULT 'PENDING',
    "executed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "exchange_id" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "funding_rate" DECIMAL(18,10) NOT NULL,
    "funding_amount" DECIMAL(20,8) NOT NULL,
    "settled_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "exchanges_name_key" ON "exchanges"("name");

-- CreateIndex
CREATE INDEX "funding_rate_snapshots_symbol_collected_at_idx" ON "funding_rate_snapshots"("symbol", "collected_at");

-- CreateIndex
CREATE INDEX "funding_rate_snapshots_exchange_id_symbol_idx" ON "funding_rate_snapshots"("exchange_id", "symbol");

-- CreateIndex
CREATE INDEX "funding_rate_hourly_symbol_hour_idx" ON "funding_rate_hourly"("symbol", "hour");

-- CreateIndex
CREATE UNIQUE INDEX "funding_rate_hourly_exchange_id_symbol_hour_key" ON "funding_rate_hourly"("exchange_id", "symbol", "hour");

-- CreateIndex
CREATE INDEX "opportunities_symbol_status_idx" ON "opportunities"("symbol", "status");

-- CreateIndex
CREATE INDEX "opportunities_detected_at_idx" ON "opportunities"("detected_at");

-- CreateIndex
CREATE INDEX "positions_status_idx" ON "positions"("status");

-- CreateIndex
CREATE INDEX "positions_symbol_idx" ON "positions"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "trade_logs_client_order_id_key" ON "trade_logs"("client_order_id");

-- CreateIndex
CREATE INDEX "trade_logs_position_id_side_idx" ON "trade_logs"("position_id", "side");

-- CreateIndex
CREATE INDEX "trade_logs_execution_id_idx" ON "trade_logs"("execution_id");

-- CreateIndex
CREATE INDEX "trade_logs_client_order_id_idx" ON "trade_logs"("client_order_id");

-- CreateIndex
CREATE INDEX "settlements_position_id_idx" ON "settlements"("position_id");

-- CreateIndex
CREATE UNIQUE INDEX "settlements_position_id_exchange_id_side_settled_at_key" ON "settlements"("position_id", "exchange_id", "side", "settled_at");

-- AddForeignKey
ALTER TABLE "funding_rate_snapshots" ADD CONSTRAINT "funding_rate_snapshots_exchange_id_fkey" FOREIGN KEY ("exchange_id") REFERENCES "exchanges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_long_exchange_id_fkey" FOREIGN KEY ("long_exchange_id") REFERENCES "exchanges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_short_exchange_id_fkey" FOREIGN KEY ("short_exchange_id") REFERENCES "exchanges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_long_exchange_id_fkey" FOREIGN KEY ("long_exchange_id") REFERENCES "exchanges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_short_exchange_id_fkey" FOREIGN KEY ("short_exchange_id") REFERENCES "exchanges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_logs" ADD CONSTRAINT "trade_logs_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_logs" ADD CONSTRAINT "trade_logs_exchange_id_fkey" FOREIGN KEY ("exchange_id") REFERENCES "exchanges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_exchange_id_fkey" FOREIGN KEY ("exchange_id") REFERENCES "exchanges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

