import { describe, it, expect, beforeEach } from "vitest";
import { appRouter } from "@/server/api/root";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import type { TRPCContext } from "@/server/api/trpc";

function ctxAuthed(): TRPCContext {
  return {
    prisma,
    redis,
    user: { id: "u1", username: "test", displayName: null },
    sessionToken: null,
    resHeaders: new Headers(),
    req: new Request("http://localhost:3000", { method: "POST" }),
  } as TRPCContext;
}

function ctxAnon(): TRPCContext {
  return { ...ctxAuthed(), user: null } as TRPCContext;
}

async function reset() {
  await prisma.backtestRun.deleteMany();
}

async function seedRun(startedAt: Date, roi: number, totalTrades: number) {
  return prisma.backtestRun.create({
    data: {
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 60_000),
      fromDate: new Date("2025-01-01"),
      toDate: new Date("2025-04-01"),
      config: { initialCapital: 10_000 },
      totalTrades,
      winRate: 0.5,
      roi,
      netPnl: 100,
      maxDrawdown: 10,
      sharpeRatio: 1.2,
      closedTrades: [],
      equityCurve: [],
    },
  });
}

describe("backtestRouter.list", () => {
  beforeEach(reset);

  it("returns empty array when no runs", async () => {
    const caller = appRouter.createCaller(ctxAuthed());
    const out = await caller.backtest.list();
    expect(out).toEqual([]);
  });

  it("returns runs sorted by startedAt desc", async () => {
    const older = await seedRun(new Date("2025-02-01"), 0.05, 5);
    const newer = await seedRun(new Date("2025-03-01"), 0.1, 10);
    const caller = appRouter.createCaller(ctxAuthed());
    const out = await caller.backtest.list();
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe(newer.id);
    expect(out[1].id).toBe(older.id);
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await seedRun(new Date(2025, 0, 1 + i), 0, 0);
    }
    const caller = appRouter.createCaller(ctxAuthed());
    const out = await caller.backtest.list({ limit: 3 });
    expect(out).toHaveLength(3);
  });

  it("rejects unauthenticated", async () => {
    const caller = appRouter.createCaller(ctxAnon());
    await expect(caller.backtest.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("backtestRouter.get", () => {
  beforeEach(reset);

  it("returns full row including trades and equityCurve", async () => {
    const run = await seedRun(new Date("2025-03-01"), 0.1, 10);
    const caller = appRouter.createCaller(ctxAuthed());
    const out = await caller.backtest.get({ id: run.id });
    expect(out.id).toBe(run.id);
    expect(out.config).toBeTypeOf("object");
    expect(Array.isArray(out.closedTrades)).toBe(true);
    expect(Array.isArray(out.equityCurve)).toBe(true);
  });

  it("throws NOT_FOUND on unknown id", async () => {
    const caller = appRouter.createCaller(ctxAuthed());
    await expect(caller.backtest.get({ id: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rejects unauthenticated", async () => {
    const caller = appRouter.createCaller(ctxAnon());
    await expect(caller.backtest.get({ id: "any" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
