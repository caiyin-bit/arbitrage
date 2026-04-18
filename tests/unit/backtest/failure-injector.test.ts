import { describe, it, expect } from "vitest";
import { createFailureInjector } from "@/server/services/backtest/runner/failure-injector";

describe("FailureInjector", () => {
  it("is deterministic given the same seed", () => {
    const a = createFailureInjector("seed-1", 0.1);
    const b = createFailureInjector("seed-1", 0.1);
    const pattern: boolean[] = [];
    for (let i = 0; i < 100; i++) pattern.push(a.shouldFail("open") === b.shouldFail("open"));
    expect(pattern.every((x) => x)).toBe(true);
  });

  it("fails roughly at the configured rate over many samples", () => {
    const inj = createFailureInjector("seed-n", 0.2);
    let fails = 0;
    for (let i = 0; i < 10_000; i++) if (inj.shouldFail("open")) fails++;
    expect(fails).toBeGreaterThan(1700);
    expect(fails).toBeLessThan(2300);
  });

  it("rate=0 never fails", () => {
    const inj = createFailureInjector("x", 0);
    for (let i = 0; i < 100; i++) expect(inj.shouldFail("open")).toBe(false);
  });
});
