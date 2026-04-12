import { z } from "zod";
import { router, publicProcedure } from "../trpc";
import { encrypt, decrypt, maskKey } from "@/server/services/crypto/encryption";
import { createAdapter } from "@/server/services/exchange/factory";
import { EXCHANGE_NAMES } from "@/lib/constants";

export const exchangeRouter = router({
  list: publicProcedure.query(async ({ ctx }) => {
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

  create: publicProcedure
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

  testConnection: publicProcedure
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
      return { success: await adapter.testConnection() };
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.exchange.delete({ where: { id: input.id } });
    }),

  toggleEnabled: publicProcedure
    .input(z.object({ id: z.string().uuid(), isEnabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.exchange.update({
        where: { id: input.id },
        data: { isEnabled: input.isEnabled },
      });
    }),
});
