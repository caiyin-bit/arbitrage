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

  console.log("BullMQ worker started");
  return worker;
}
