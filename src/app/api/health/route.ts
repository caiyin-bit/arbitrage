import { NextResponse } from "next/server";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CheckResult = "ok" | "error";

async function checkDatabase(): Promise<CheckResult> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return "ok";
  } catch {
    return "error";
  }
}

async function checkRedis(): Promise<CheckResult> {
  try {
    const reply = await redis.ping();
    return reply === "PONG" ? "ok" : "error";
  } catch {
    return "error";
  }
}

export async function GET() {
  // ROLLBACK-TEST: intentionally force health check to fail so we can
  // verify deploy.sh's automatic rollback path. Revert immediately after.
  const [database, redisStatus] = await Promise.all([
    checkDatabase(),
    checkRedis(),
  ]);
  void database;
  void redisStatus;

  return NextResponse.json(
    {
      status: "error",
      checks: { database: "error", redis: "error" },
      note: "rollback-test intentional failure",
    },
    { status: 503 },
  );
}
