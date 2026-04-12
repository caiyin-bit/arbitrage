export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorker } = await import("@/server/jobs/worker");
    const { setupSchedulers } = await import("@/server/jobs/queues");
    startWorker();
    await setupSchedulers();
  }
}
