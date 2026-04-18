import { describe, it, expect, beforeEach } from "vitest";
import { appRouter } from "@/server/api/root";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import { hashPassword } from "@/server/services/auth/password";
import type { TRPCContext } from "@/server/api/trpc";

function ctxWithIp(ip: string): TRPCContext {
  const headers = new Headers({ "x-forwarded-for": ip });
  return {
    prisma,
    redis,
    user: null,
    sessionToken: null,
    resHeaders: new Headers(),
    req: new Request("http://localhost:3000", { method: "POST", headers }),
  } as TRPCContext;
}

async function reset() {
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  await redis.flushdb();
}

describe("auth.login", () => {
  beforeEach(reset);

  it("wrong password rejects with UNAUTHORIZED and the canonical message", async () => {
    await prisma.user.create({
      data: { username: "alice", passwordHash: hashPassword("hunter22") },
    });
    const caller = appRouter.createCaller(ctxWithIp("1.1.1.1"));
    await expect(
      caller.auth.login({ username: "alice", password: "wrong" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "用户名或密码错误" });
  });

  it("nonexistent username returns the same error shape as wrong password", async () => {
    const caller = appRouter.createCaller(ctxWithIp("1.1.1.1"));
    await expect(
      caller.auth.login({ username: "ghost", password: "any" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "用户名或密码错误" });
  });

  it("login takes at least 400ms on failure (constant-time guard)", async () => {
    await prisma.user.create({
      data: { username: "alice", passwordHash: hashPassword("hunter22") },
    });
    const caller = appRouter.createCaller(ctxWithIp("1.1.1.1"));
    const start = Date.now();
    await caller.auth.login({ username: "alice", password: "wrong" }).catch(() => {});
    expect(Date.now() - start).toBeGreaterThanOrEqual(400);
  });

  it("success: creates session and sets cookie", async () => {
    await prisma.user.create({
      data: { username: "alice", passwordHash: hashPassword("hunter22") },
    });
    const c = ctxWithIp("1.1.1.1");
    const caller = appRouter.createCaller(c);
    const out = await caller.auth.login({ username: "alice", password: "hunter22" });
    expect(out.user.username).toBe("alice");
    expect(c.resHeaders.get("set-cookie")).toMatch(/arb_session=[^;]+/);
    expect(await prisma.session.count()).toBe(1);
  });

  it("(IP, username) rate limit: 10 fails from same IP to same user locks that pair, but same user from different IP still works", async () => {
    await prisma.user.create({
      data: { username: "alice", passwordHash: hashPassword("hunter22") },
    });
    const bad = appRouter.createCaller(ctxWithIp("2.2.2.2"));
    for (let i = 0; i < 11; i++) {
      await bad.auth.login({ username: "alice", password: "wrong" }).catch(() => {});
    }
    const eleventh = bad.auth.login({ username: "alice", password: "hunter22" });
    await expect(eleventh).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    const good = appRouter.createCaller(ctxWithIp("3.3.3.3"));
    const out = await good.auth.login({ username: "alice", password: "hunter22" });
    expect(out.user.username).toBe("alice");
  });

  it("IP rate limit: 30+ fails from same IP across different usernames locks the IP", async () => {
    const bad = appRouter.createCaller(ctxWithIp("9.9.9.9"));
    for (let i = 0; i < 31; i++) {
      await bad.auth
        .login({ username: `u${i}`, password: "wrong" })
        .catch(() => {});
    }
    await expect(
      bad.auth.login({ username: "anyone", password: "x" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  }, 20000);
});
