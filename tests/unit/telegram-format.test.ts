import { describe, it, expect } from "vitest";
import { formatEvent } from "@/server/services/notifier/format";

describe("formatEvent", () => {
  it("formats opportunity_detected with yield", () => {
    const msg = formatEvent({
      kind: "opportunity_detected",
      symbol: "BTC/USDT",
      annualizedYield: 0.235,
      longExchange: "okx",
      shortExchange: "binance",
    });
    expect(msg).toContain("BTC/USDT");
    expect(msg).toContain("23.50%");
    expect(msg).toContain("okx");
    expect(msg).toContain("binance");
  });

  it("formats rescue_triggered with warning emoji", () => {
    const msg = formatEvent({
      kind: "rescue_triggered",
      symbol: "ETH/USDT",
      side: "long",
      qty: 0.5,
      note: "orphan",
    });
    expect(msg).toContain("⚠️");
    expect(msg).toContain("ETH/USDT");
    expect(msg).toContain("0.5");
  });

  it("formats position_closed with pnl sign", () => {
    const profit = formatEvent({ kind: "position_closed", symbol: "SOL", pnl: 12.3, reason: "manual" });
    expect(profit).toContain("+$12.30");
    const loss = formatEvent({ kind: "position_closed", symbol: "SOL", pnl: -5, reason: "manual" });
    expect(loss).toContain("-$5.00");
  });
});
