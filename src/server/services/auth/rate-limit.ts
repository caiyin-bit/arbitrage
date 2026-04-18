import { redis } from "@/server/db/redis";

export async function hitLoginBucket(
  key: string,
  max: number,
  windowSeconds: number,
): Promise<{ locked: boolean; count: number }> {
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, windowSeconds);
  return { locked: n > max, count: n };
}
