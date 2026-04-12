import { describe, it, expect } from "vitest";
import { computeAggregates } from "@/server/services/executor/aggregate";

const f = (overrides: Partial<{
  side: "long" | "short";
  action: "open" | "close" | "rescue";
  signedQty: number;
  price: number;
  status: "filled" | "pending" | "failed";
}> = {}) => ({
  side: "long" as const,
  action: "open" as const,
  signedQty: 1,
  price: 100,
  status: "filled" as const,
  ...overrides,
});

describe("computeAggregates", () => {
  it("sums signed_qty for filled fills per side", () => {
    const result = computeAggregates([
      f({ side: "long", action: "open", signedQty: 1, price: 100 }),
      f({ side: "long", action: "open", signedQty: 1, price: 110 }),
      f({ side: "short", action: "open", signedQty: 1, price: 105 }),
    ]);
    expect(result.longSize).toBe(2);
    expect(result.longAvgEntry).toBe(105);
    expect(result.shortSize).toBe(1);
    expect(result.shortAvgEntry).toBe(105);
  });

  it("rescue reduces net size", () => {
    const result = computeAggregates([
      f({ side: "long", action: "open", signedQty: 1, price: 100 }),
      f({ side: "long", action: "rescue", signedQty: -0.3, price: 101 }),
    ]);
    expect(result.longSize).toBeCloseTo(0.7);
    expect(result.longAvgEntry).toBe(100);
  });

  it("close reduces net size and does not affect entry avg", () => {
    const result = computeAggregates([
      f({ side: "long", action: "open", signedQty: 2, price: 100 }),
      f({ side: "long", action: "close", signedQty: -2, price: 120 }),
    ]);
    expect(result.longSize).toBe(0);
    expect(result.longAvgEntry).toBe(100);
  });

  it("ignores non-filled fills", () => {
    const result = computeAggregates([
      f({ side: "long", action: "open", signedQty: 1, status: "failed" }),
      f({ side: "long", action: "open", signedQty: 1, status: "pending" }),
      f({ side: "long", action: "open", signedQty: 1, status: "filled", price: 100 }),
    ]);
    expect(result.longSize).toBe(1);
    expect(result.longAvgEntry).toBe(100);
  });

  it("returns zeros for empty array", () => {
    const result = computeAggregates([]);
    expect(result).toEqual({
      longSize: 0,
      longAvgEntry: 0,
      shortSize: 0,
      shortAvgEntry: 0,
    });
  });
});
