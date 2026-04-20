import { describe, it, expect } from "vitest";
import { wAvgFilledPrice } from "@/server/services/backtest/runner/runner";
import type { TradeLog } from "@prisma/client";

function log(overrides: Partial<TradeLog>): TradeLog {
  return {
    id: "t1",
    positionId: "p1",
    exchangeId: "e1",
    executionId: "ex1",
    clientOrderId: "c1",
    exchangeOrderId: null,
    side: "LONG",
    action: "CLOSE",
    orderType: "MARKET",
    price: 0 as unknown as TradeLog["price"],
    signedQty: 0 as unknown as TradeLog["signedQty"],
    fee: 0 as unknown as TradeLog["fee"],
    status: "PENDING",
    executedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as TradeLog;
}

describe("wAvgFilledPrice", () => {
  it("ignores PENDING logs so a failed close leg does not zero the good leg's price", () => {
    const logs = [
      log({ id: "a", status: "FILLED", price: 100 as any, signedQty: -5 as any }),
      log({ id: "b", status: "FILLED", price: 110 as any, signedQty: -5 as any }),
      log({ id: "c", status: "PENDING", price: 0 as any, signedQty: -10 as any }),
    ];
    // Unfiltered average would be ((100*5 + 110*5 + 0*10)/20) = 52.5
    // Filtered average = ((100*5 + 110*5)/10) = 105
    expect(wAvgFilledPrice(logs)).toBe(105);
  });

  it("returns 0 when every log is PENDING or FAILED (real leg failure)", () => {
    const logs = [
      log({ id: "a", status: "PENDING", price: 0 as any, signedQty: -5 as any }),
      log({ id: "b", status: "FAILED", price: 0 as any, signedQty: -5 as any }),
    ];
    expect(wAvgFilledPrice(logs)).toBe(0);
  });

  it("treats PARTIAL as filled and averages by absolute signed quantity", () => {
    const logs = [
      log({ id: "a", status: "FILLED", price: 200 as any, signedQty: 3 as any }),
      log({ id: "b", status: "PARTIAL", price: 100 as any, signedQty: 1 as any }),
    ];
    // (200*3 + 100*1) / 4 = 175
    expect(wAvgFilledPrice(logs)).toBe(175);
  });
});
