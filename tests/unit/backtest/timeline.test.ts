import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/server/db/client";
import { buildTimeline } from "@/server/services/backtest/runner/timeline";

async function reset() {
  await prisma.fundingRateSnapshot.deleteMany();
  await prisma.exchange.deleteMany();
}

describe("buildTimeline", () => {
  beforeEach(reset);

  it("emits funding_collection every 5 min, health_check per interval, settlement at historical rate times, all sorted", async () => {
    const ex = await prisma.exchange.create({ data: { name: "binance", apiKey: "", apiSecret: "" } });
    const t0 = new Date("2025-01-01T00:00:00Z");
    const t8 = new Date("2025-01-01T08:00:00Z");
    await prisma.fundingRateSnapshot.create({
      data: { exchangeId: ex.id, symbol: "BTC/USDT:USDT", currentRate: 0.0001, collectedAt: t8, intervalHours: 8, nextSettlement: new Date(t8.getTime() + 8 * 3600_000) },
    });

    const timeline = await buildTimeline(
      { from: t0, to: new Date("2025-01-01T09:00:00Z"), healthIntervalSec: 300 },
    );

    const collections = timeline.filter((e) => e.type === "funding_collection");
    expect(collections.length).toBeGreaterThanOrEqual(12);

    const settlements = timeline.filter((e) => e.type === "settlement");
    expect(settlements.length).toBe(1);
    expect(settlements[0]).toMatchObject({ type: "settlement", symbol: "BTC/USDT:USDT" });

    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i].at.getTime()).toBeGreaterThanOrEqual(timeline[i - 1].at.getTime());
    }
  });
});
