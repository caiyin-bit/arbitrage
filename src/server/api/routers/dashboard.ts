import { router, publicProcedure } from "../trpc";

export const dashboardRouter = router({
  overview: publicProcedure.query(async ({ ctx }) => {
    const [openPositions, todayOpportunities] = await Promise.all([
      ctx.prisma.position.count({ where: { status: "OPEN" } }),
      ctx.prisma.opportunity.count({
        where: {
          detectedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      }),
    ]);

    return {
      openPositions,
      todayOpportunities,
    };
  }),
});
