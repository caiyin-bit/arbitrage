import { prisma } from "./client";

const DEFAULT_SETTINGS: Array<{
  key: string;
  value: unknown;
  description: string;
}> = [
  { key: "min_rate_spread", value: 0.0001, description: "Minimum funding rate spread (0.01%)" },
  { key: "min_annualized_yield", value: 0.15, description: "Minimum annualized yield (15%)" },
  { key: "max_leverage", value: 3, description: "Maximum leverage" },
  { key: "safety_margin_ratio", value: 0.5, description: "Margin safety buffer (50%)" },
  { key: "max_single_position", value: 0.2, description: "Max single position as % of total (20%)" },
  { key: "rate_reversal_exit", value: -0.00005, description: "Rate reversal exit threshold (-0.005%)" },
  { key: "min_holding_periods", value: 3, description: "Minimum settlement periods to hold" },
  { key: "rate_collect_interval_ms", value: 180000, description: "Rate collection interval in ms (3 min)" },
  { key: "health_check_interval_ms", value: 300000, description: "Health check interval in ms (5 min)" },
  { key: "settlement_pre_check_ms", value: 900000, description: "Pre-settlement check lead time in ms (15 min)" },
  { key: "max_single_leg_exposure", value: 1000, description: "Max single leg exposure in USDT" },
  { key: "volatility_threshold_1h", value: 0.05, description: "1h price volatility pause threshold (5%)" },
  { key: "volatility_threshold_24h", value: 0.15, description: "24h price volatility pause threshold (15%)" },
  { key: "backtest_slippage", value: 0.0005, description: "Backtest slippage assumption (0.05%)" },
  {
    key: "monitored_symbols",
    value: ["BTC/USDT:USDT", "ETH/USDT:USDT", "SOL/USDT:USDT", "BNB/USDT:USDT", "XRP/USDT:USDT"],
    description: "Baseline list of symbols monitored for volatility pause",
  },
];

async function main() {
  for (const setting of DEFAULT_SETTINGS) {
    await prisma.setting.upsert({
      where: { key: setting.key },
      update: {},
      create: {
        key: setting.key,
        value: setting.value as any,
        description: setting.description,
      },
    });
  }
  console.log("Seed complete: %d settings", DEFAULT_SETTINGS.length);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
