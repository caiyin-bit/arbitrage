import { scanSettlements } from "@/server/services/monitor/settlement";

export async function handleMonitorSettlement() {
  console.log("[job] Scanning settlements...");
  await scanSettlements();
}
