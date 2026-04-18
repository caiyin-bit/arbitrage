import { router, publicProcedure, protectedProcedure } from "../trpc";
import { destroySession, createSession, SESSION_TTL_SECONDS } from "@/server/services/auth/session";
import { serializeSessionCookie } from "@/server/services/auth/cookie";
import { hashPassword, verifyPassword } from "@/server/services/auth/password";
import { hitLoginBucket } from "@/server/services/auth/rate-limit";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";

const IS_PROD = process.env.NODE_ENV === "production";

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const registerInput = z.object({
  username: z.string().regex(USERNAME_RE),
  password: z.string().min(8).max(200),
  displayName: z.string().max(64).optional(),
  inviteCode: z.string().min(1).max(100).optional(),
});

function writeCookie(ctx: { resHeaders: Headers }, token: string) {
  ctx.resHeaders.append("set-cookie", serializeSessionCookie(token, SESSION_TTL_SECONDS, IS_PROD));
}

function clearCookie(ctx: { resHeaders: Headers }) {
  ctx.resHeaders.append("set-cookie", serializeSessionCookie("", 0, IS_PROD));
}

export const authRouter = router({
  register: publicProcedure.input(registerInput).mutation(async ({ ctx, input }) => {
    const passwordHash = hashPassword(input.password);
    const uaHeader = ctx.req.headers.get("user-agent");
    const ipHeader =
      ctx.req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

    let userId: string;
    try {
      userId = await ctx.prisma.$transaction(
        async (tx) => {
          // Advisory lock serializes bootstrap detection across concurrent requests.
          // Lock key 1 is an arbitrary fixed value for the register path.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

          const userCount = await tx.user.count();
          const isBootstrap = userCount === 0;

          // Create user first so P2002 (duplicate username) fires before invite validation.
          const u = await tx.user.create({
            data: {
              username: input.username,
              passwordHash,
              displayName: input.displayName ?? null,
            },
          });

          if (!isBootstrap && !input.inviteCode) {
            throw new TRPCError({ code: "UNAUTHORIZED", message: "need invite code" });
          }

          if (!isBootstrap) {
            const consumed = await tx.invite.updateMany({
              where: {
                code: input.inviteCode!,
                usedBy: null,
                expiresAt: { gt: new Date() },
              },
              data: { usedBy: u.id, usedAt: new Date() },
            });
            if (consumed.count !== 1) {
              throw new TRPCError({ code: "UNAUTHORIZED", message: "invalid or used invite" });
            }
          }

          return u.id;
        },
        { isolationLevel: "Serializable" },
      );
    } catch (e) {
      if (e instanceof TRPCError) throw e;
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new TRPCError({ code: "CONFLICT", message: "username taken" });
      }
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        (e.code === "P2034" || (e.meta as { code?: string } | undefined)?.code === "40001")
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "please retry" });
      }
      throw e;
    }

    const { token } = await createSession(userId, uaHeader, ipHeader);
    writeCookie(ctx, token);
    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, username: true, displayName: true },
    });
    return { user };
  }),

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

  login: publicProcedure
    .input(z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const ip =
        ctx.req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

      const ipBucket = await hitLoginBucket(`login:ip:${ip}`, 30, 600);
      if (ipBucket.locked) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "请稍后再试" });
      }
      const pairBucket = await hitLoginBucket(
        `login:pair:${ip}:${input.username}`,
        10,
        600,
      );
      if (pairBucket.locked) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "请稍后再试" });
      }

      const ua = ctx.req.headers.get("user-agent");
      const delay = new Promise((r) => setTimeout(r, 400));

      const user = await ctx.prisma.user.findUnique({ where: { username: input.username } });
      const ok = user ? verifyPassword(input.password, user.passwordHash) : false;
      await delay;
      if (!user || !ok) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "用户名或密码错误" });
      }

      const { token } = await createSession(user.id, ua, ip === "unknown" ? null : ip);
      writeCookie(ctx, token);
      return {
        user: { id: user.id, username: user.username, displayName: user.displayName },
      };
    }),
});
