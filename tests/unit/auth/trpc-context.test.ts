import { describe, it, expect, beforeEach } from "vitest";
import { createTRPCContext } from "@/server/api/trpc";
import { prisma } from "@/server/db/client";
import { createSession } from "@/server/services/auth/session";
import { SESSION_COOKIE } from "@/server/services/auth/cookie";

function makeOpts({
  cookie,
  origin,
  method = "POST",
}: { cookie?: string; origin?: string; method?: string }) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (origin) headers.set("origin", origin);
  const req = new Request("http://localhost:3000/api/trpc/x", { method, headers });
  return { req, resHeaders: new Headers(), info: {} as never };
}

describe("createTRPCContext", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.user.deleteMany();
  });

  it("injects user=null when no cookie", async () => {
    const ctx = await createTRPCContext(makeOpts({}) as never);
    expect(ctx.user).toBeNull();
  });

  it("injects the user when a valid session cookie is present", async () => {
    const user = await prisma.user.create({
      data: { username: "alice", passwordHash: "x$y" },
    });
    const { token } = await createSession(user.id);
    const ctx = await createTRPCContext(
      makeOpts({ cookie: `${SESSION_COOKIE}=${token}` }) as never,
    );
    expect(ctx.user?.id).toBe(user.id);
    expect(ctx.user?.username).toBe("alice");
  });

  it("throws 403 when POST has a mismatched Origin", async () => {
    await expect(
      createTRPCContext(makeOpts({ origin: "https://evil.example" }) as never),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows POST with matching Origin", async () => {
    const ctx = await createTRPCContext(
      makeOpts({ origin: "http://localhost:3000" }) as never,
    );
    expect(ctx.user).toBeNull();
  });

  it("allows POST with missing Origin (legacy clients)", async () => {
    const ctx = await createTRPCContext(makeOpts({}) as never);
    expect(ctx.user).toBeNull();
  });

  it("does not check Origin for GET (queries work from any link preview)", async () => {
    const ctx = await createTRPCContext(
      makeOpts({ method: "GET", origin: "https://evil.example" }) as never,
    );
    expect(ctx.user).toBeNull();
  });
});
