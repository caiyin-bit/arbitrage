import { Worker } from "bullmq";
import { redis } from "@/server/db/redis";
import { handleCollectRates } from "./collect-rates";

export function startWorker() {
  const worker = new Worker(
    "rate-collection",
    async (job) => {
      switch (job.name) {
        case "collect":
          await handleCollectRates();
          break;
        default:
          console.warn("[worker] Unknown job:", job.name);
      }
    },
    {
      connection: redis,
      concurrency: 1,
    },
  );

  worker.on("completed", (job) => {
    console.log("[worker] Job %s completed", job.id);
  });

  worker.on("failed", (job, err) => {
    console.error("[worker] Job %s failed:", job?.id, err.message);
  });

  const healthWorker = new Worker(
    "health-check",
    async (job) => {
      if (job.name === "check") {
        const { handleCheckHealth } = await import("./check-health");
        await handleCheckHealth();
      }
    },
    { connection: redis, concurrency: 1 },
  );

  healthWorker.on("completed", (job) => console.log("[health-worker] completed", job.id));
  healthWorker.on("failed", (job, err) => console.error("[health-worker] failed", job?.id, err.message));

  const settlementWorker = new Worker(
    "settlement-monitor",
    async (job) => {
      if (job.name === "scan") {
        const { handleMonitorSettlement } = await import("./monitor-settlement");
        await handleMonitorSettlement();
      }
    },
    { connection: redis, concurrency: 1 },
  );

  settlementWorker.on("completed", (job) => console.log("[settlement-worker] completed", job.id));
  settlementWorker.on("failed", (job, err) => console.error("[settlement-worker] failed", job?.id, err.message));

  console.log("BullMQ worker started");
  return { worker, healthWorker, settlementWorker };
}
