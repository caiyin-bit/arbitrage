import { describe, it, expect, beforeEach } from "vitest";
import { appRouter } from "@/server/api/root";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import type { TRPCContext } from "@/server/api/trpc";
import { SESSION_COOKIE } from "@/server/services/auth/cookie";

function freshCtx(cookie?: string): TRPCContext {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  headers.set("x-forwarded-for", "1.1.1.1");
  return {
    prisma,
    redis,
    user: null,
    sessionToken: null,
    resHeaders: new Headers(),
    req: new Request("http://localhost:3000", { method: "POST", headers }),
  } as TRPCContext;
}

function extractSessionToken(ctx: TRPCContext): string {
  const sc = ctx.resHeaders.get("set-cookie")!;
  const token = /arb_session=([^;]+)/.exec(sc)?.[1];
  return token!;
}

async function reset() {
  await prisma.session.deleteMany();
  await prisma.invite.deleteMany();
  await prisma.user.deleteMany();
  await redis.flushdb();
}

describe("auth full flow", () => {
  beforeEach(reset);

  it("bootstrap → logout → login → invite → second user → replay blocked → revoke cycle", async () => {
    // 1. bootstrap register
    const c = freshCtx();
    await appRouter.createCaller(c).auth.register({ username: "admin", password: "hunter22" });
    const adminToken = extractSessionToken(c);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.session.count()).toBe(1);

    // 2. logout
    const { getSessionUser } = await import("@/server/services/auth/session");
    const adminUser = await getSessionUser(adminToken);
    expect(adminUser).not.toBeNull();
    const c2 = freshCtx(`${SESSION_COOKIE}=${adminToken}`);
    c2.user = adminUser;
    c2.sessionToken = adminToken;
    await appRouter.createCaller(c2).auth.logout();
    expect(await prisma.session.count()).toBe(0);

    // 3. login again
    const c3 = freshCtx();
    const loggedIn = await appRouter
      .createCaller(c3)
      .auth.login({ username: "admin", password: "hunter22" });
    expect(loggedIn.user.username).toBe("admin");
    const adminToken2 = extractSessionToken(c3);

    // 4. createInvite as admin
    const adminUser2 = await getSessionUser(adminToken2);
    const c4 = freshCtx();
    c4.user = adminUser2;
    c4.sessionToken = adminToken2;
    const { code } = await appRouter.createCaller(c4).auth.createInvite();
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);

    // 5. second user registers with invite
    const c5 = freshCtx();
    await appRouter
      .createCaller(c5)
      .auth.register({ username: "user2", password: "hunter22", inviteCode: code });
    expect(await prisma.user.count()).toBe(2);
    const invAfter = await prisma.invite.findUnique({ where: { code } });
    expect(invAfter?.usedBy).not.toBeNull();

    // 6. replay same invite
    const c6 = freshCtx();
    await expect(
      appRouter
        .createCaller(c6)
        .auth.register({ username: "user3", password: "hunter22", inviteCode: code }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    // 7. admin revokes a fresh invite
    const c7 = freshCtx();
    c7.user = adminUser2;
    c7.sessionToken = adminToken2;
    const { code: code2 } = await appRouter.createCaller(c7).auth.createInvite();
    await appRouter.createCaller(c7).auth.revokeInvite({ code: code2 });
    const c8 = freshCtx();
    await expect(
      appRouter
        .createCaller(c8)
        .auth.register({ username: "user4", password: "hunter22", inviteCode: code2 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  }, 30_000);

  it("protected business routers reject unauthenticated calls", async () => {
    const c = freshCtx();
    await expect(
      appRouter.createCaller(c).dashboard.overview(),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
