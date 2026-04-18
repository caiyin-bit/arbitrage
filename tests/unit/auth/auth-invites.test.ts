import { describe, it, expect, beforeEach } from "vitest";
import { appRouter } from "@/server/api/root";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import type { TRPCContext } from "@/server/api/trpc";

async function makeAuthedCtx(username = "admin"): Promise<TRPCContext> {
  const user = await prisma.user.create({
    data: { username, passwordHash: "x$y" },
  });
  return {
    prisma,
    redis,
    user: { id: user.id, username: user.username, displayName: user.displayName },
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

describe("invites", () => {
  beforeEach(reset);

  it("createInvite returns a code, persists a row with createdBy=me and future expiresAt", async () => {
    const c = await makeAuthedCtx();
    const caller = appRouter.createCaller(c);
    const out = await caller.auth.createInvite();
    expect(out.code).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    const row = await prisma.invite.findUnique({ where: { code: out.code } });
    expect(row?.createdBy).toBe(c.user!.id);
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("createInvite rejects without a session", async () => {
    const caller = appRouter.createCaller({
      prisma,
      redis,
      user: null,
      sessionToken: null,
      resHeaders: new Headers(),
      req: new Request("http://localhost:3000", { method: "POST" }),
    } as TRPCContext);
    await expect(caller.auth.createInvite()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("listInvites returns unused-active and recent-used arrays", async () => {
    const c = await makeAuthedCtx();
    const caller = appRouter.createCaller(c);
    await caller.auth.createInvite();
    await caller.auth.createInvite();
    await prisma.invite.create({
      data: {
        code: "USED",
        createdBy: c.user!.id,
        expiresAt: new Date(Date.now() + 3600_000),
        usedBy: c.user!.id,
        usedAt: new Date(),
      },
    });
    const out = await caller.auth.listInvites();
    expect(out.active).toHaveLength(2);
    expect(out.used).toHaveLength(1);
  });

  it("revokeInvite: unused invite becomes unusable (expiresAt moves to past)", async () => {
    const c = await makeAuthedCtx();
    const caller = appRouter.createCaller(c);
    const { code } = await caller.auth.createInvite();
    await caller.auth.revokeInvite({ code });
    const row = await prisma.invite.findUnique({ where: { code } });
    expect(row!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("revokeInvite: already-used invite rejects", async () => {
    const c = await makeAuthedCtx();
    const caller = appRouter.createCaller(c);
    await prisma.invite.create({
      data: {
        code: "U",
        createdBy: c.user!.id,
        expiresAt: new Date(Date.now() + 3600_000),
        usedBy: c.user!.id,
        usedAt: new Date(),
      },
    });
    await expect(caller.auth.revokeInvite({ code: "U" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("revokeInvite: unknown code rejects", async () => {
    const c = await makeAuthedCtx();
    const caller = appRouter.createCaller(c);
    await expect(caller.auth.revokeInvite({ code: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
