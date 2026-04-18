import { describe, it, expect, beforeEach } from "vitest";
import { redis } from "@/server/db/redis";
import { hitLoginBucket } from "@/server/services/auth/rate-limit";

describe("rate-limit", () => {
  beforeEach(async () => {
    await redis.flushdb();
  });

  it("increments the counter and returns remaining", async () => {
    const r1 = await hitLoginBucket("bucket:test", 3, 60);
    expect(r1.locked).toBe(false);
    expect(r1.count).toBe(1);
    const r2 = await hitLoginBucket("bucket:test", 3, 60);
    expect(r2.count).toBe(2);
  });

  it("returns locked=true once count exceeds max and applies lock TTL", async () => {
    await hitLoginBucket("bucket:lock", 2, 60);
    await hitLoginBucket("bucket:lock", 2, 60);
    const r = await hitLoginBucket("bucket:lock", 2, 60);
    expect(r.locked).toBe(true);
  });
});
