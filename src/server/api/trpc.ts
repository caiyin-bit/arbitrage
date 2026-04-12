import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";

export const createTRPCContext = async () => {
  return { prisma, redis };
};

const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
