import { runHealthCheck } from "@/server/services/monitor/health";

export async function handleCheckHealth() {
  console.log("[job] Running health check...");
  try {
    await runHealthCheck();
  } catch (err) {
    console.error("[job] Health check failed:", err);
    throw err;
  }
}
