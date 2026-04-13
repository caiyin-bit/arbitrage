import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/db/client", () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));
vi.mock("@/server/db/redis", () => ({
  redis: {
    ping: vi.fn(),
  },
}));

import { GET } from "@/app/api/health/route";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 when prisma and redis are both healthy", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
    vi.mocked(redis.ping).mockResolvedValue("PONG");

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: "ok",
      checks: { database: "ok", redis: "ok" },
    });
  });

  it("returns 503 when prisma query fails", async () => {
    vi.mocked(prisma.$queryRaw).mockRejectedValue(new Error("connection refused"));
    vi.mocked(redis.ping).mockResolvedValue("PONG");

    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.checks.database).toBe("error");
    expect(body.checks.redis).toBe("ok");
  });

  it("returns 503 when redis ping fails", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
    vi.mocked(redis.ping).mockRejectedValue(new Error("ETIMEDOUT"));

    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.checks.database).toBe("ok");
    expect(body.checks.redis).toBe("error");
  });

  it("returns 503 when both fail", async () => {
    vi.mocked(prisma.$queryRaw).mockRejectedValue(new Error("down"));
    vi.mocked(redis.ping).mockRejectedValue(new Error("down"));

    const res = await GET();
    expect(res.status).toBe(503);
  });
});
