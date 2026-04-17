import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { encrypt, decrypt, maskKey } from "@/server/services/crypto/encryption";
import { createAdapter } from "@/server/services/exchange/factory";
import { EXCHANGE_NAMES } from "@/lib/constants";

export const exchangeRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const exchanges = await ctx.prisma.exchange.findMany({
      orderBy: { name: "asc" },
    });
    return exchanges.map((ex) => ({
      ...ex,
      apiKey: maskKey(decrypt(ex.apiKey)),
      apiSecret: "********",
      passphrase: ex.passphrase ? "********" : null,
    }));
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.enum(EXCHANGE_NAMES),
        apiKey: z.string().min(1),
        apiSecret: z.string().min(1),
        passphrase: z.string().optional(),
        feeRate: z.number().min(0).max(0.01).default(0.001),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.exchange.create({
        data: {
          name: input.name,
          apiKey: encrypt(input.apiKey),
          apiSecret: encrypt(input.apiSecret),
          passphrase: input.passphrase ? encrypt(input.passphrase) : null,
          feeRate: input.feeRate,
        },
      });
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        apiKey: z.string().min(1).optional(),
        apiSecret: z.string().min(1).optional(),
        passphrase: z.string().optional(),
        feeRate: z.number().min(0).max(0.01).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const data: Record<string, unknown> = {};
      if (input.apiKey !== undefined) data.apiKey = encrypt(input.apiKey);
      if (input.apiSecret !== undefined) data.apiSecret = encrypt(input.apiSecret);
      if (input.passphrase !== undefined) {
        data.passphrase = input.passphrase ? encrypt(input.passphrase) : null;
      }
      if (input.feeRate !== undefined) data.feeRate = input.feeRate;
      return ctx.prisma.exchange.update({
        where: { id: input.id },
        data,
      });
    }),

  testConnection: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const ex = await ctx.prisma.exchange.findUniqueOrThrow({
        where: { id: input.id },
      });
      const adapter = createAdapter(
        ex.name as any,
        decrypt(ex.apiKey),
        decrypt(ex.apiSecret),
        ex.passphrase ? decrypt(ex.passphrase) : undefined,
      );
      try {
        const ok = await adapter.testConnection();
        return { success: ok, error: ok ? null : "Unknown failure (no error thrown)" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[exchange.testConnection] ${ex.name} failed:`, err);
        return { success: false, error: message };
      }
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.$transaction(async (tx) => {
        // Block delete if there's real trading history (positions, trades,
        // settlements) — those must be handled explicitly to avoid losing
        // auditable records.
        const positionCount = await tx.position.count({
          where: {
            OR: [
              { longExchangeId: input.id },
              { shortExchangeId: input.id },
            ],
          },
        });
        if (positionCount > 0) {
          throw new Error(
            `Cannot delete exchange: ${positionCount} position(s) reference it. Close and archive positions first.`,
          );
        }
        // Cascade-clean read-only history written by collectors.
        await tx.opportunity.deleteMany({
          where: {
            OR: [
              { longExchangeId: input.id },
              { shortExchangeId: input.id },
            ],
          },
        });
        await tx.fundingRateSnapshot.deleteMany({
          where: { exchangeId: input.id },
        });
        await tx.fundingRateHourly.deleteMany({
          where: { exchangeId: input.id },
        });
        await tx.exchange.delete({ where: { id: input.id } });
      });
    }),

  toggleEnabled: protectedProcedure
    .input(z.object({ id: z.string().uuid(), isEnabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.exchange.update({
        where: { id: input.id },
        data: { isEnabled: input.isEnabled },
      });
    }),
});
