import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import { createAdapter } from "@/server/services/exchange/factory";
import { decrypt } from "@/server/services/crypto/encryption";
import type { ExchangeName } from "@/lib/constants";
import type { ExecutorContext, RedisLike } from "./types";
import { PrismaPositionStore } from "./prisma-position-store";

// Adapter to conform ioredis to RedisLike interface (promise-only, no callbacks)
class RedisAdapter implements RedisLike {
  constructor(private redisClient: typeof redis) {}

  async set(key: string, value: string, ...args: (string | number)[]): Promise<"OK" | null> {
    // ioredis.set has callback overloads; we only use the promise-based variant
    // by passing string/number args without a callback.
    return (this.redisClient.set as any)(key, value, ...args);
  }

  async get(key: string): Promise<string | null> {
    return this.redisClient.get(key);
  }

  async del(...keys: string[]): Promise<number> {
    return this.redisClient.del(...keys);
  }
}

export function buildProdContext(): ExecutorContext {
  return {
    store: new PrismaPositionStore(prisma),
    redis: new RedisAdapter(redis),
    adapterFor: async (name: string) => {
      const row = await prisma.exchange.findFirstOrThrow({
        where: { name, isEnabled: true },
      });
      return createAdapter(
        row.name as ExchangeName,
        decrypt(row.apiKey),
        decrypt(row.apiSecret),
        row.passphrase ? decrypt(row.passphrase) : undefined,
      );
    },
    clock: { now: () => new Date() },
    random: Math.random,
    log: (msg, meta) => console.log(`[executor] ${msg}`, meta ?? ""),
  };
}
