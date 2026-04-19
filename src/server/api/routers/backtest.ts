import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { router, protectedProcedure } from "../trpc";

export const backtestRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(500).default(50) })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 50;
      return ctx.prisma.backtestRun.findMany({
        orderBy: { startedAt: "desc" },
        take: limit,
        select: {
          id: true,
          startedAt: true,
          fromDate: true,
          toDate: true,
          totalTrades: true,
          winRate: true,
          roi: true,
          netPnl: true,
        },
      });
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        return await ctx.prisma.backtestRun.findUniqueOrThrow({
          where: { id: input.id },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
          throw new TRPCError({ code: "NOT_FOUND", message: "run not found" });
        }
        throw e;
      }
    }),
});
