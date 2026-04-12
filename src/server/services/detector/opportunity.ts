import type { FundingRate, OpportunitySignal } from "@/lib/types";
import { annualizedYield, rateSpread } from "@/lib/utils";

interface DetectorConfig {
  minRateSpread: number;
  minAnnualizedYield: number;
}

export function findOpportunities(
  rates: FundingRate[],
  config: DetectorConfig,
): OpportunitySignal[] {
  // Group by symbol
  const bySymbol = new Map<string, FundingRate[]>();
  for (const rate of rates) {
    const list = bySymbol.get(rate.symbol) ?? [];
    list.push(rate);
    bySymbol.set(rate.symbol, list);
  }

  const opportunities: OpportunitySignal[] = [];

  for (const [symbol, symbolRates] of bySymbol) {
    if (symbolRates.length < 2) continue;

    let maxRate = symbolRates[0];
    let minRate = symbolRates[0];

    for (const r of symbolRates) {
      if (r.currentRate > maxRate.currentRate) maxRate = r;
      if (r.currentRate < minRate.currentRate) minRate = r;
    }

    if (maxRate.exchange === minRate.exchange) continue;

    const spread = rateSpread(maxRate.currentRate, minRate.currentRate);
    if (spread < config.minRateSpread) continue;

    const intervalHours = maxRate.intervalHours;
    const yieldValue = annualizedYield(spread, intervalHours);
    if (yieldValue < config.minAnnualizedYield) continue;

    opportunities.push({
      symbol,
      longExchange: minRate.exchange,
      shortExchange: maxRate.exchange,
      longRate: minRate.currentRate,
      shortRate: maxRate.currentRate,
      rateSpread: spread,
      annualizedYield: yieldValue,
      suggestedSize: 0,
    });
  }

  return opportunities.sort((a, b) => b.annualizedYield - a.annualizedYield);
}
