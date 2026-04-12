import { z } from "zod";
import { router, publicProcedure } from "../trpc";

export const opportunityRouter = router({
  list: publicProcedure
    .input(
      z
        .object({
          status: z
            .enum(["DETECTED", "NOTIFIED", "ACCEPTED", "REJECTED", "EXPIRED"])
            .optional(),
          limit: z.number().min(1).max(100).default(50),
        })
        .default(() => ({ limit: 50 })),
    )
    .query(async ({ ctx, input }) => {
      return ctx.prisma.opportunity.findMany({
        where: input.status ? { status: input.status } : undefined,
        include: {
          longExchange: { select: { id: true, name: true } },
          shortExchange: { select: { id: true, name: true } },
        },
        orderBy: { detectedAt: "desc" },
        take: input.limit,
      });
    }),

  // Returns the most recent funding rate per (exchange, symbol) pair for
  // the rate matrix view. Shape: { symbol, exchange, rate }[].
  latestRates: publicProcedure.query(async ({ ctx }) => {
    const exchanges = await ctx.prisma.exchange.findMany({
      where: { isEnabled: true },
      select: { id: true, name: true },
    });
    const idToName = new Map<string, string>(
      exchanges.map((e) => [e.id, e.name]),
    );

    // One DISTINCT-ON row per (exchangeId, symbol), most recent first.
    const rows = await ctx.prisma.$queryRaw<
      Array<{ exchange_id: string; symbol: string; current_rate: string }>
    >`
      SELECT DISTINCT ON (exchange_id, symbol)
        exchange_id, symbol, current_rate
      FROM funding_rate_snapshots
      WHERE collected_at > NOW() - INTERVAL '30 minutes'
      ORDER BY exchange_id, symbol, collected_at DESC
    `;

    return rows
      .map((r) => ({
        symbol: r.symbol,
        exchange: idToName.get(r.exchange_id) ?? "unknown",
        rate: Number(r.current_rate),
      }))
      .filter((r) => r.exchange !== "unknown");
  }),
});
