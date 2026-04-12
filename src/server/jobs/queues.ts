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

export const reconcileRetryQueue = new Queue("reconcile-retry", {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 200,
    attempts: 5,
    backoff: { type: "exponential", delay: 5000 },
  },
});

export const healthCheckQueue = new Queue("health-check", {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 100,
    attempts: 2,
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

  const healthExisting = await healthCheckQueue.getRepeatableJobs();
  for (const job of healthExisting) {
    await healthCheckQueue.removeRepeatableByKey(job.key);
  }
  await healthCheckQueue.add("check", {}, { repeat: { every: 300_000 } });

  console.log("Job schedulers configured");
}
