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

  latestRates: publicProcedure.query(async ({ ctx }) => {
    const cached = await ctx.redis.get("opportunity:latest");
    return cached ? JSON.parse(cached) : [];
  }),
});
