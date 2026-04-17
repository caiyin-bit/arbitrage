import { router, publicProcedure, protectedProcedure } from "../trpc";
import { destroySession } from "@/server/services/auth/session";
import { serializeSessionCookie } from "@/server/services/auth/cookie";

const IS_PROD = process.env.NODE_ENV === "production";

function clearCookie(ctx: { resHeaders: Headers }) {
  ctx.resHeaders.append("set-cookie", serializeSessionCookie("", 0, IS_PROD));
}

export const authRouter = router({
  isBootstrap: publicProcedure.query(async ({ ctx }) => {
    const count = await ctx.prisma.user.count();
    return { isBootstrap: count === 0 };
  }),

  me: publicProcedure.query(({ ctx }) => {
    if (!ctx.user) return null;
    return {
      id: ctx.user.id,
      username: ctx.user.username,
      displayName: ctx.user.displayName,
    };
  }),

  logout: protectedProcedure.mutation(async ({ ctx }) => {
    if (ctx.sessionToken) {
      await destroySession(ctx.sessionToken);
    }
    clearCookie(ctx);
    return { ok: true as const };
  }),
});
