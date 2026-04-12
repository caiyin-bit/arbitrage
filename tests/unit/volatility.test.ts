import { describe, it, expect } from "vitest";
import { nextPauseState } from "@/server/services/monitor/volatility";

describe("nextPauseState", () => {
  it("triggers pause when 1h change exceeds threshold", () => {
    const next = nextPauseState({
      current: null,
      priceChange1h: 0.06,
      priceChange24h: 0.05,
      threshold1h: 0.05,
      threshold24h: 0.15,
    });
    expect(next).toEqual(expect.objectContaining({ paused: true, reason: "1h_volatility", recoveryCount: 0 }));
  });

  it("triggers pause when 24h change exceeds threshold", () => {
    const next = nextPauseState({
      current: null,
      priceChange1h: 0.02,
      priceChange24h: 0.2,
      threshold1h: 0.05,
      threshold24h: 0.15,
    });
    expect(next?.reason).toBe("24h_volatility");
  });

  it("stays unpaused when both below threshold", () => {
    const next = nextPauseState({
      current: null,
      priceChange1h: 0.02,
      priceChange24h: 0.05,
      threshold1h: 0.05,
      threshold24h: 0.15,
    });
    expect(next).toBeNull();
  });

  it("increments recoveryCount when paused and under recovery threshold", () => {
    const current = { paused: true as const, reason: "1h_volatility" as const, triggeredAt: new Date().toISOString(), recoveryCount: 1 };
    const next = nextPauseState({
      current,
      priceChange1h: 0.02,
      priceChange24h: 0.05,
      threshold1h: 0.05,
      threshold24h: 0.15,
    });
    expect(next?.recoveryCount).toBe(2);
  });

  it("clears pause after 3 consecutive under-threshold checks", () => {
    const current = { paused: true as const, reason: "1h_volatility" as const, triggeredAt: new Date().toISOString(), recoveryCount: 2 };
    const next = nextPauseState({
      current,
      priceChange1h: 0.01,
      priceChange24h: 0.05,
      threshold1h: 0.05,
      threshold24h: 0.15,
    });
    expect(next).toBeNull();
  });

  it("resets recoveryCount when paused and breach recurs", () => {
    const current = { paused: true as const, reason: "1h_volatility" as const, triggeredAt: new Date().toISOString(), recoveryCount: 2 };
    const next = nextPauseState({
      current,
      priceChange1h: 0.07,
      priceChange24h: 0.05,
      threshold1h: 0.05,
      threshold24h: 0.15,
    });
    expect(next?.recoveryCount).toBe(0);
  });
});
