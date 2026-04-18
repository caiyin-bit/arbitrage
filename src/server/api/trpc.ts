import { initTRPC, TRPCError } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import { parseCookie, SESSION_COOKIE } from "@/server/services/auth/cookie";
import { getSessionUser, type SessionUser } from "@/server/services/auth/session";

const APP_ORIGIN = process.env.APP_ORIGIN ?? "http://localhost:3000";

export async function createTRPCContext(opts: FetchCreateContextFnOptions) {
  const { req, resHeaders } = opts;

  // CSRF defense-in-depth: reject POST with a mismatched Origin. Missing Origin
  // is allowed (covers SameSite-Lax-only POSTs from older clients and server-side
  // tRPC callers). SameSite=Lax still blocks the cross-site submit scenario.
  if (req.method === "POST") {
    const origin = req.headers.get("origin");
    if (origin && origin !== APP_ORIGIN) {
      throw new TRPCError({ code: "FORBIDDEN", message: "bad origin" });
    }
  }

  const cookies = parseCookie(req.headers.get("cookie"));
  const token: string | null = cookies[SESSION_COOKIE] ?? null;
  const user: SessionUser | null = token ? await getSessionUser(token) : null;

  return {
    prisma,
    redis,
    user,
    sessionToken: token as string | null,
    resHeaders,
    req,
  };
}

export type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<TRPCContext>().create({ transformer: superjson });

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, user: ctx.user } });
});
