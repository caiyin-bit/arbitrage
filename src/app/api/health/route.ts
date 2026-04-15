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
  const [database, redisStatus] = await Promise.all([
    checkDatabase(),
    checkRedis(),
  ]);

  const allOk = database === "ok" && redisStatus === "ok";
  const body = {
    status: allOk ? "ok" : "error",
    checks: { database, redis: redisStatus },
  };

  return NextResponse.json(body, { status: allOk ? 200 : 503 });
}
