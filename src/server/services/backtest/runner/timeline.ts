import { prisma } from "@/server/db/client";

export type VirtualEvent =
  | { type: "funding_collection"; at: Date }
  | { type: "health_check"; at: Date }
  | { type: "settlement"; at: Date; symbol: string; exchangeName: string; fundingRate: number };

export interface TimelineOptions {
  from: Date;
  to: Date;
  healthIntervalSec: number;
}

const COLLECTION_STEP_MS = 5 * 60 * 1000;

export async function buildTimeline(opts: TimelineOptions): Promise<VirtualEvent[]> {
  const events: VirtualEvent[] = [];

  for (let t = opts.from.getTime(); t < opts.to.getTime(); t += COLLECTION_STEP_MS) {
    events.push({ type: "funding_collection", at: new Date(t) });
  }
  for (let t = opts.from.getTime(); t < opts.to.getTime(); t += opts.healthIntervalSec * 1000) {
    events.push({ type: "health_check", at: new Date(t) });
  }

  const rates = await prisma.fundingRateSnapshot.findMany({
    where: { collectedAt: { gte: opts.from, lte: opts.to } },
    include: { exchange: { select: { name: true } } },
    orderBy: { collectedAt: "asc" },
  });
  for (const r of rates) {
    events.push({
      type: "settlement",
      at: r.collectedAt,
      symbol: r.symbol,
      exchangeName: r.exchange.name,
      fundingRate: Number(r.currentRate),
    });
  }

  events.sort((a, b) => a.at.getTime() - b.at.getTime());
  return events;
}
