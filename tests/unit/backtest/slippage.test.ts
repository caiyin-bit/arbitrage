import { describe, it, expect } from "vitest";
import { applySlippage } from "@/server/services/backtest/runner/slippage";

describe("applySlippage", () => {
  it("long side pays higher price (bps > 0)", () => {
    expect(applySlippage(100, "long", 3)).toBeCloseTo(100.03, 4);
  });
  it("short side receives lower price", () => {
    expect(applySlippage(100, "short", 3)).toBeCloseTo(99.97, 4);
  });
  it("zero bps = no change", () => {
    expect(applySlippage(100, "long", 0)).toBe(100);
  });
});
