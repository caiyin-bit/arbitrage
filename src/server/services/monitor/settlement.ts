import { prisma } from "@/server/db/client";
import { createAdapter } from "@/server/services/exchange/factory";
import { decrypt } from "@/server/services/crypto/encryption";
import type { ExchangeName } from "@/lib/constants";

const LOOKBACK_MS = 30 * 60 * 1000; // 30 min

/**
 * For every open position, pull funding payments from both exchanges since
 * the last lookback window and insert new rows. Dedup is enforced at the DB
 * level by the (positionId, exchangeId, side, settledAt) unique index.
 */
export async function scanSettlements() {
  const openPositions = await prisma.position.findMany({
    where: { status: { in: ["OPEN", "RESCUE"] } },
    include: { longExchange: true, shortExchange: true },
  });

  for (const pos of openPositions) {
    for (const side of ["long", "short"] as const) {
      const exchange = side === "long" ? pos.longExchange : pos.shortExchange;

      try {
        const adapter = createAdapter(
          exchange.name as ExchangeName,
          decrypt(exchange.apiKey),
          decrypt(exchange.apiSecret),
          exchange.passphrase ? decrypt(exchange.passphrase) : undefined,
        );

        const since = new Date(Date.now() - LOOKBACK_MS);
        const payments = await adapter.getFundingHistory(pos.symbol, since);

        for (const p of payments) {
          try {
            await prisma.settlement.create({
              data: {
                positionId: pos.id,
                exchangeId: exchange.id,
                side: side.toUpperCase() as "LONG" | "SHORT",
                fundingRate: p.fundingRate,
                fundingAmount: p.amount,
                settledAt: p.settledAt,
              },
            });
          } catch (err: any) {
            // P2002 = unique constraint violation → already recorded, skip
            if (err?.code !== "P2002") throw err;
          }
        }
      } catch (err: any) {
        if (err?.message === "not implemented") {
          console.log(
            `[settlement] ${exchange.name} getFundingHistory not implemented — skipped`,
          );
          continue;
        }
        console.error(`[settlement] ${pos.symbol} ${side} on ${exchange.name}:`, err);
      }
    }
  }
}
