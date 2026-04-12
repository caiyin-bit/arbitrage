import { Queue } from "bullmq";
import { redis } from "@/server/db/redis";

export const rateCollectionQueue = new Queue("rate-collection", {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 200,
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  },
});

export async function setupSchedulers() {
  const existing = await rateCollectionQueue.getRepeatableJobs();
  for (const job of existing) {
    await rateCollectionQueue.removeRepeatableByKey(job.key);
  }

  await rateCollectionQueue.add(
    "collect",
    {},
    { repeat: { every: 180_000 } },
  );

  console.log("Job schedulers configured");
}
