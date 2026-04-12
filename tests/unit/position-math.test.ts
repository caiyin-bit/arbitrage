import { describe, it, expect } from "vitest";
import {
  weightedAveragePrice,
  unrealizedPnl,
  marginRatio,
  safetyBuffer,
} from "@/lib/position-math";

describe("weightedAveragePrice", () => {
  it("weights by signed_qty", () => {
    const fills = [
      { price: 70000, signedQty: 1 },
      { price: 70100, signedQty: 2 },
    ];
    expect(weightedAveragePrice(fills)).toBeCloseTo(70066.67, 2);
  });

  it("returns 0 for empty fills", () => {
    expect(weightedAveragePrice([])).toBe(0);
  });

  it("ignores zero-signed fills", () => {
    const fills = [
      { price: 70000, signedQty: 0 },
      { price: 71000, signedQty: 1 },
    ];
    expect(weightedAveragePrice(fills)).toBe(71000);
  });
});

describe("unrealizedPnl", () => {
  it("long side profit when mark > entry", () => {
    expect(unrealizedPnl({ side: "long", size: 1, entryPrice: 70000, markPrice: 71000 }))
      .toBe(1000);
  });

  it("short side profit when mark < entry", () => {
    expect(unrealizedPnl({ side: "short", size: 1, entryPrice: 70000, markPrice: 69000 }))
      .toBe(1000);
  });

  it("scales with size", () => {
    expect(unrealizedPnl({ side: "long", size: 2.5, entryPrice: 100, markPrice: 110 }))
      .toBe(25);
  });
});

describe("marginRatio", () => {
  it("returns equity / maintenance as ratio", () => {
    expect(marginRatio({ equity: 1000, maintenanceMargin: 400 })).toBe(2.5);
  });

  it("returns Infinity when maintenance is 0", () => {
    expect(marginRatio({ equity: 1000, maintenanceMargin: 0 })).toBe(Infinity);
  });
});

describe("safetyBuffer", () => {
  it("computes buffer as 1 - used/total", () => {
    expect(safetyBuffer({ usedMargin: 400, totalMargin: 1000 })).toBe(0.6);
  });
});
