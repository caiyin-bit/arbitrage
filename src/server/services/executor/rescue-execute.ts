import type { Position } from "@prisma/client";
import type { ExchangeAdapter } from "@/server/services/exchange/types";
import type { RescuePlan } from "./rescue";
import type { ExecutionResult } from "./types";

interface ExecuteRescueArgs {
  position: Position;
  plan: RescuePlan;
  executionId: string;
  longAdapter: ExchangeAdapter;
  shortAdapter: ExchangeAdapter;
  longExchangeId: string;
  shortExchangeId: string;
  symbol: string;
}

export async function executeRescue(args: ExecuteRescueArgs): Promise<ExecutionResult> {
  // Task 5 will replace this with the real implementation
  throw new Error("executeRescue not yet implemented — see Plan 2 Task 5");
}
