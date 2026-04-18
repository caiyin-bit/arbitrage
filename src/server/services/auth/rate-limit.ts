import { redis } from "@/server/db/redis";

const LUA = `
local n = redis.call("INCR", KEYS[1])
if n == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
return n
`;

export async function hitLoginBucket(
  key: string,
  max: number,
  windowSeconds: number,
): Promise<{ locked: boolean; count: number }> {
  const n = Number(await redis.eval(LUA, 1, key, windowSeconds));
  return { locked: n > max, count: n };
}
