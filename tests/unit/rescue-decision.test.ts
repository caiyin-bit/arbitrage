import { describe, it, expect } from "vitest";
import { decideRescueStrategy } from "@/server/services/executor/rescue";

describe("decideRescueStrategy", () => {
  it("returns both_filled when sizes match", () => {
    expect(decideRescueStrategy({ longFilled: 1, shortFilled: 1 })).toEqual({
      kind: "both_filled",
    });
  });

  it("returns both_failed when nothing filled", () => {
    expect(decideRescueStrategy({ longFilled: 0, shortFilled: 0 })).toEqual({
      kind: "both_failed",
    });
  });

  it("returns orphan rescue when one side is zero", () => {
    expect(decideRescueStrategy({ longFilled: 1, shortFilled: 0 })).toEqual({
      kind: "rescue_orphan",
      side: "long",
      qty: 1,
    });
    expect(decideRescueStrategy({ longFilled: 0, shortFilled: 2 })).toEqual({
      kind: "rescue_orphan",
      side: "short",
      qty: 2,
    });
  });

  it("uses reduce branch when excess < 10% of matched", () => {
    // long=1.05, short=1.0, matched=1.0, excess=0.05 → 5% < 10% → reduce long by 0.05
    expect(decideRescueStrategy({ longFilled: 1.05, shortFilled: 1 })).toEqual({
      kind: "rescue_excess",
      side: "long",
      qty: 0.05,
    });
  });

  it("uses top-up branch when excess >= 10% of matched", () => {
    // long=1.2, short=1.0 → excess 20% → top up short by 0.2
    expect(decideRescueStrategy({ longFilled: 1.2, shortFilled: 1 })).toEqual({
      kind: "topup",
      side: "short",
      qty: 0.2,
    });
  });
});
