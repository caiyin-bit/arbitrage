import { describe, it, expect } from "vitest";
import {
  annualizedYield,
  formatRate,
  formatUsd,
  rateSpread,
} from "@/lib/utils";

describe("annualizedYield", () => {
  it("calculates correctly for 8h interval", () => {
    const result = annualizedYield(0.0003, 8);
    expect(result).toBeCloseTo(0.3285, 4);
  });

  it("calculates correctly for 4h interval", () => {
    const result = annualizedYield(0.0001, 4);
    expect(result).toBeCloseTo(0.219, 3);
  });

  it("returns 0 for zero spread", () => {
    expect(annualizedYield(0, 8)).toBe(0);
  });
});

describe("rateSpread", () => {
  it("returns positive spread when short rate > long rate", () => {
    expect(rateSpread(0.0003, 0.0001)).toBeCloseTo(0.0002);
  });

  it("returns negative spread when reversed", () => {
    expect(rateSpread(0.0001, 0.0003)).toBeCloseTo(-0.0002);
  });
});

describe("formatRate", () => {
  it("formats as percentage with 4 decimal places", () => {
    expect(formatRate(0.000312)).toBe("0.0312%");
  });

  it("handles negative rates", () => {
    expect(formatRate(-0.0001)).toBe("-0.0100%");
  });
});

describe("formatUsd", () => {
  it("formats with 2 decimals and $ prefix", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });
});
