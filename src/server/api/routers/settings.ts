import { z } from "zod";
import { router, publicProcedure } from "../trpc";

export const settingsRouter = router({
  getAll: publicProcedure.query(async ({ ctx }) => {
    const settings = await ctx.prisma.setting.findMany();
    return Object.fromEntries(settings.map((s) => [s.key, s.value]));
  }),

  get: publicProcedure
    .input(z.object({ key: z.string() }))
    .query(async ({ ctx, input }) => {
      const setting = await ctx.prisma.setting.findUnique({
        where: { key: input.key },
      });
      return setting?.value ?? null;
    }),

  set: publicProcedure
    .input(z.object({ key: z.string(), value: z.any() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.setting.upsert({
        where: { key: input.key },
        update: { value: input.value },
        create: {
          key: input.key,
          value: input.value,
          description: "",
        },
      });
    }),
});
