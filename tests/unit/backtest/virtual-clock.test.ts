import { describe, it, expect } from "vitest";
import { VirtualClock } from "@/server/services/backtest/runner/virtual-clock";

describe("VirtualClock", () => {
  it("now() returns current time, setTime advances it", () => {
    const c = new VirtualClock(new Date("2025-01-01T00:00:00Z"));
    expect(c.now().toISOString()).toBe("2025-01-01T00:00:00.000Z");
    c.setTime(new Date("2025-01-01T01:30:00Z"));
    expect(c.now().toISOString()).toBe("2025-01-01T01:30:00.000Z");
  });

  it("setTime rejects backwards moves", () => {
    const c = new VirtualClock(new Date("2025-01-01T00:00:00Z"));
    c.setTime(new Date("2025-01-01T02:00:00Z"));
    expect(() => c.setTime(new Date("2025-01-01T01:00:00Z"))).toThrow();
  });
});
