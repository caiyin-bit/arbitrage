import { describe, it, expect, beforeEach } from "vitest";
import { appRouter } from "@/server/api/root";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import { createSession, hashToken } from "@/server/services/auth/session";
import type { TRPCContext } from "@/server/api/trpc";

function ctx(overrides: Partial<TRPCContext> = {}): TRPCContext {
  return {
    prisma,
    redis,
    user: null,
    sessionToken: null,
    resHeaders: new Headers(),
    req: new Request("http://localhost:3000", { method: "POST" }),
    ...overrides,
  } as TRPCContext;
}

describe("auth router — isBootstrap / me / logout", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.invite.deleteMany();
    await prisma.user.deleteMany();
  });

  it("isBootstrap=true when the users table is empty", async () => {
    const caller = appRouter.createCaller(ctx());
    expect(await caller.auth.isBootstrap()).toEqual({ isBootstrap: true });
  });

  it("isBootstrap=false after a user exists", async () => {
    await prisma.user.create({ data: { username: "first", passwordHash: "x$y" } });
    const caller = appRouter.createCaller(ctx());
    expect(await caller.auth.isBootstrap()).toEqual({ isBootstrap: false });
  });

  it("me returns null when no session", async () => {
    const caller = appRouter.createCaller(ctx());
    expect(await caller.auth.me()).toBeNull();
  });

  it("me returns { id, username, displayName } (never passwordHash)", async () => {
    const user = await prisma.user.create({
      data: { username: "alice", passwordHash: "secret$hash", displayName: "Alice" },
    });
    const caller = appRouter.createCaller(ctx({ user }));
    const me = await caller.auth.me();
    expect(me).toEqual({ id: user.id, username: "alice", displayName: "Alice" });
    expect((me as Record<string, unknown>).passwordHash).toBeUndefined();
  });

  it("logout deletes the session row and sets a clearing cookie", async () => {
    const user = await prisma.user.create({ data: { username: "bob", passwordHash: "x$y" } });
    const { token } = await createSession(user.id);
    const c = ctx({ user, sessionToken: token });
    const caller = appRouter.createCaller(c);
    await caller.auth.logout();
    expect(
      await prisma.session.findUnique({ where: { tokenHash: hashToken(token) } }),
    ).toBeNull();
    const setCookie = c.resHeaders.get("set-cookie");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("logout without a session throws UNAUTHORIZED", async () => {
    const caller = appRouter.createCaller(ctx());
    await expect(caller.auth.logout()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
