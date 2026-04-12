import { describe, it, expect } from "vitest";
import { findOpportunities } from "@/server/services/detector/opportunity";
import type { FundingRate } from "@/lib/types";

const makeRate = (
  exchange: "binance" | "okx" | "bybit" | "gateio",
  symbol: string,
  rate: number,
): FundingRate => ({
  exchange,
  symbol,
  currentRate: rate,
  predictedRate: null,
  nextSettlement: new Date("2026-04-12T08:00:00Z"),
  intervalHours: 8,
  timestamp: new Date(),
});

describe("findOpportunities", () => {
  it("detects opportunity when rate spread exceeds threshold", () => {
    const rates = [
      makeRate("binance", "BTC/USDT:USDT", 0.0003),
      makeRate("okx", "BTC/USDT:USDT", 0.0001),
    ];

    const result = findOpportunities(rates, {
      minRateSpread: 0.0001,
      minAnnualizedYield: 0,
    });

    expect(result).toHaveLength(1);
    expect(result[0].shortExchange).toBe("binance");
    expect(result[0].longExchange).toBe("okx");
    expect(result[0].rateSpread).toBeCloseTo(0.0002);
  });

  it("returns empty when spread below threshold", () => {
    const rates = [
      makeRate("binance", "BTC/USDT:USDT", 0.00011),
      makeRate("okx", "BTC/USDT:USDT", 0.0001),
    ];

    const result = findOpportunities(rates, {
      minRateSpread: 0.0001,
      minAnnualizedYield: 0,
    });

    expect(result).toHaveLength(0);
  });

  it("finds the best pair among multiple exchanges", () => {
    const rates = [
      makeRate("binance", "ETH/USDT:USDT", 0.0005),
      makeRate("okx", "ETH/USDT:USDT", 0.0002),
      makeRate("bybit", "ETH/USDT:USDT", 0.0001),
    ];

    const result = findOpportunities(rates, {
      minRateSpread: 0.0001,
      minAnnualizedYield: 0,
    });

    const best = result[0];
    expect(best.shortExchange).toBe("binance");
    expect(best.longExchange).toBe("bybit");
    expect(best.rateSpread).toBeCloseTo(0.0004);
  });

  it("filters by minimum annualized yield", () => {
    const rates = [
      makeRate("binance", "BTC/USDT:USDT", 0.00015),
      makeRate("okx", "BTC/USDT:USDT", 0.0001),
    ];

    const result = findOpportunities(rates, {
      minRateSpread: 0,
      minAnnualizedYield: 0.20,
    });

    expect(result).toHaveLength(0);
  });
});
