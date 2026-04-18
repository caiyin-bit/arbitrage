import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { openHedgedPosition } from "@/server/services/executor/execute-open";
import { closeHedgedPosition } from "@/server/services/executor/execute-close";
import { EXCHANGE_NAMES } from "@/lib/constants";

export const positionRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({
          status: z
            .enum(["OPENING", "OPEN", "CLOSING", "CLOSED", "RESCUE"])
            .optional(),
          limit: z.number().min(1).max(100).default(50),
        })
        .default(() => ({ limit: 50 })),
    )
    .query(async ({ ctx, input }) => {
      return ctx.prisma.position.findMany({
        where: input.status ? { status: input.status } : undefined,
        include: {
          longExchange: { select: { id: true, name: true } },
          shortExchange: { select: { id: true, name: true } },
          settlements: {
            orderBy: { settledAt: "desc" },
            take: 5,
          },
          _count: { select: { tradeLogs: true, settlements: true } },
        },
        orderBy: { openedAt: "desc" },
        take: input.limit,
      });
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.position.findUniqueOrThrow({
        where: { id: input.id },
        include: {
          longExchange: true,
          shortExchange: true,
          settlements: { orderBy: { settledAt: "desc" } },
          tradeLogs: { orderBy: { createdAt: "asc" } },
        },
      });
    }),

  open: protectedProcedure
    .input(
      z.object({
        idempotencyKey: z.string().uuid(),
        opportunityId: z.string().uuid(),
        symbol: z.string(),
        longExchange: z.enum(EXCHANGE_NAMES),
        shortExchange: z.enum(EXCHANGE_NAMES),
        size: z.number().positive(),
        leverage: z.number().min(1).max(10),
      }),
    )
    .mutation(async ({ input }) => {
      return openHedgedPosition(input);
    }),

  close: protectedProcedure
    .input(
      z.object({
        idempotencyKey: z.string().uuid(),
        positionId: z.string().uuid(),
        reason: z
          .enum(["manual", "rate_reversal", "take_profit", "risk_control"])
          .default("manual"),
      }),
    )
    .mutation(async ({ input }) => {
      return closeHedgedPosition(input);
    }),
});
