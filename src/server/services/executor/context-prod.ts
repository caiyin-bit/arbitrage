import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import { createAdapter } from "@/server/services/exchange/factory";
import { decrypt } from "@/server/services/crypto/encryption";
import type { ExchangeName } from "@/lib/constants";
import type { ExecutorContext } from "./types";
import { PrismaPositionStore } from "./prisma-position-store";

export function buildProdContext(): ExecutorContext {
  return {
    store: new PrismaPositionStore(prisma),
    redis: redis as any,
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
