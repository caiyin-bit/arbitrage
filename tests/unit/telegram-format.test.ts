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

describe("formatEvent — deploy events", () => {
  it("formats deploy_succeeded", () => {
    const msg = formatEvent({
      kind: "deploy_succeeded",
      tag: "v0.1.0",
      previousTag: "v0.0.9",
      durationSec: 87,
    });
    expect(msg).toContain("v0.1.0");
    expect(msg).toContain("v0.0.9");
    expect(msg).toContain("87");
    expect(msg).toMatch(/deploy/i);
  });

  it("formats deploy_succeeded without previous tag (first deploy)", () => {
    const msg = formatEvent({
      kind: "deploy_succeeded",
      tag: "v0.1.0",
      previousTag: null,
      durationSec: 92,
    });
    expect(msg).toContain("v0.1.0");
    expect(msg).not.toContain("null");
    expect(msg).toMatch(/first deploy|初次/i);
  });

  it("formats deploy_failed with rollback", () => {
    const msg = formatEvent({
      kind: "deploy_failed",
      tag: "v0.1.0",
      previousTag: "v0.0.9",
      rolledBack: true,
      reason: "health check failed after 5 attempts",
    });
    expect(msg).toContain("v0.1.0");
    expect(msg).toContain("v0.0.9");
    expect(msg).toMatch(/rolled back|回滚/i);
    expect(msg).toContain("health check failed");
  });

  it("formats deploy_failed without rollback (first deploy)", () => {
    const msg = formatEvent({
      kind: "deploy_failed",
      tag: "v0.1.0",
      previousTag: null,
      rolledBack: false,
      reason: "migration crashed",
    });
    expect(msg).toContain("v0.1.0");
    expect(msg).toMatch(/service down|manual/i);
  });
});
