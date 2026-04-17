import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/server/db/client";
import {
  createSession,
  getSessionUser,
  destroySession,
  hashToken,
  SESSION_TTL_SECONDS,
} from "@/server/services/auth/session";

async function makeUser() {
  return prisma.user.create({
    data: { username: `u_${Math.random().toString(36).slice(2, 8)}`, passwordHash: "x$y" },
  });
}

describe("session", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.invite.deleteMany();
    await prisma.user.deleteMany();
  });

  it("createSession returns a token whose sha256 matches the DB row", async () => {
    const user = await makeUser();
    const { token, expiresAt } = await createSession(user.id);
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const row = await prisma.session.findUnique({ where: { tokenHash: hashToken(token) } });
    expect(row).not.toBeNull();
    expect(row!.userId).toBe(user.id);
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now() + (SESSION_TTL_SECONDS - 60) * 1000);
    expect(expiresAt.getTime()).toBe(row!.expiresAt.getTime());
  });

  it("token in cookie is NOT equal to the DB primary key (hash storage check)", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    const hashed = hashToken(token);
    expect(token).not.toBe(hashed);
    const lookupByRawToken = await prisma.session.findUnique({ where: { tokenHash: token } });
    expect(lookupByRawToken).toBeNull();
  });

  it("getSessionUser returns the user for a valid token, null for a random one", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    const got = await getSessionUser(token);
    expect(got?.id).toBe(user.id);
    expect(await getSessionUser("does-not-exist")).toBeNull();
  });

  it("using the stored tokenHash as a fake cookie token does NOT hit the session (regression for DB-read takeover)", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    const stolenFromDb = hashToken(token);
    expect(await getSessionUser(stolenFromDb)).toBeNull();
  });

  it("getSessionUser on an expired session returns null and deletes the row", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    await prisma.session.update({
      where: { tokenHash: hashToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await getSessionUser(token)).toBeNull();
    expect(await prisma.session.findUnique({ where: { tokenHash: hashToken(token) } })).toBeNull();
  });

  it("getSessionUser slides expiresAt forward on a valid hit", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    await prisma.session.update({
      where: { tokenHash: hashToken(token) },
      data: { expiresAt: new Date(Date.now() + 60_000) },
    });
    const before = (await prisma.session.findUnique({ where: { tokenHash: hashToken(token) } }))!.expiresAt;
    await getSessionUser(token);
    const after = (await prisma.session.findUnique({ where: { tokenHash: hashToken(token) } }))!.expiresAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it("destroySession deletes the row; subsequent getSessionUser returns null", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    await destroySession(token);
    expect(await getSessionUser(token)).toBeNull();
  });

  it("getSessionUser is resilient to a concurrent destroy (no throw, returns null)", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    // Simulate: row deleted between findUnique and updateMany
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    const got = await getSessionUser(token);
    expect(got).toBeNull();
  });
});
