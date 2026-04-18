import { describe, it, expect, beforeEach } from "vitest";
import { appRouter } from "@/server/api/root";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import type { TRPCContext } from "@/server/api/trpc";

function freshCtx(): TRPCContext {
  return {
    prisma,
    redis,
    user: null,
    sessionToken: null,
    resHeaders: new Headers(),
    req: new Request("http://localhost:3000", { method: "POST" }),
  } as TRPCContext;
}

async function reset() {
  await prisma.session.deleteMany();
  await prisma.invite.deleteMany();
  await prisma.user.deleteMany();
}

describe("auth.register", () => {
  beforeEach(reset);

  it("bootstrap: users table empty — no inviteCode required", async () => {
    const c = freshCtx();
    const caller = appRouter.createCaller(c);
    const out = await caller.auth.register({ username: "admin", password: "hunter22" });
    expect(out.user.username).toBe("admin");
    expect(await prisma.user.count()).toBe(1);
    expect(c.resHeaders.get("set-cookie")).toMatch(/arb_session=[^;]+/);
  });

  it("non-bootstrap: missing inviteCode rejects", async () => {
    await prisma.user.create({ data: { username: "first", passwordHash: "x$y" } });
    const caller = appRouter.createCaller(freshCtx());
    await expect(
      caller.auth.register({ username: "u2x", password: "hunter22" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("non-bootstrap: valid invite consumes atomically — invite row shows usedBy/usedAt after", async () => {
    const admin = await prisma.user.create({ data: { username: "admin", passwordHash: "x$y" } });
    const inv = await prisma.invite.create({
      data: {
        code: "INV-1",
        createdBy: admin.id,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const caller = appRouter.createCaller(freshCtx());
    const out = await caller.auth.register({
      username: "bob",
      password: "hunter22",
      inviteCode: "INV-1",
    });
    const used = await prisma.invite.findUnique({ where: { code: inv.code } });
    expect(used?.usedBy).toBe(out.user.id);
    expect(used?.usedAt).not.toBeNull();
  });

  it("non-bootstrap: already-used invite rejects", async () => {
    const admin = await prisma.user.create({ data: { username: "admin", passwordHash: "x$y" } });
    const bob = await prisma.user.create({ data: { username: "bob", passwordHash: "x$y" } });
    await prisma.invite.create({
      data: {
        code: "INV-USED",
        createdBy: admin.id,
        expiresAt: new Date(Date.now() + 3600_000),
        usedBy: bob.id,
        usedAt: new Date(),
      },
    });
    const caller = appRouter.createCaller(freshCtx());
    await expect(
      caller.auth.register({ username: "u3x", password: "hunter22", inviteCode: "INV-USED" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("non-bootstrap: expired invite rejects", async () => {
    const admin = await prisma.user.create({ data: { username: "admin", passwordHash: "x$y" } });
    await prisma.invite.create({
      data: {
        code: "INV-OLD",
        createdBy: admin.id,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const caller = appRouter.createCaller(freshCtx());
    await expect(
      caller.auth.register({ username: "u4x", password: "hunter22", inviteCode: "INV-OLD" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("duplicate username rejects (even in bootstrap)", async () => {
    const caller1 = appRouter.createCaller(freshCtx());
    await caller1.auth.register({ username: "dup", password: "hunter22" });
    const caller2 = appRouter.createCaller(freshCtx());
    await expect(
      caller2.auth.register({ username: "dup", password: "hunter22" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("concurrent bootstrap: only one of two simultaneous registers succeeds", async () => {
    const c1 = appRouter.createCaller(freshCtx());
    const c2 = appRouter.createCaller(freshCtx());
    const results = await Promise.allSettled([
      c1.auth.register({ username: "abc", password: "hunter22" }),
      c2.auth.register({ username: "def", password: "hunter22" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    expect(fulfilled).toBe(1);
    expect(await prisma.user.count()).toBe(1);
  });

  it("concurrent same-invite: only one of two register calls consumes the invite", async () => {
    const admin = await prisma.user.create({ data: { username: "admin", passwordHash: "x$y" } });
    await prisma.invite.create({
      data: {
        code: "RACE",
        createdBy: admin.id,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const c1 = appRouter.createCaller(freshCtx());
    const c2 = appRouter.createCaller(freshCtx());
    const results = await Promise.allSettled([
      c1.auth.register({ username: "racer1", password: "hunter22", inviteCode: "RACE" }),
      c2.auth.register({ username: "racer2", password: "hunter22", inviteCode: "RACE" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
  });

  it("password shorter than 8 chars rejects with BAD_REQUEST", async () => {
    const caller = appRouter.createCaller(freshCtx());
    await expect(
      caller.auth.register({ username: "abc", password: "short" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
