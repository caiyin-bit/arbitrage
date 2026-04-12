import type { ExchangeName } from "@/lib/constants";

export interface OpenHedgedRequest {
  /** Caller-supplied UUID generated once per user confirmation (see idempotency protocol) */
  idempotencyKey: string;
  opportunityId: string;
  symbol: string;
  longExchange: ExchangeName;
  shortExchange: ExchangeName;
  size: number;
  leverage: number;
}

export interface CloseHedgedRequest {
  idempotencyKey: string;
  positionId: string;
  reason: "manual" | "rate_reversal" | "take_profit" | "risk_control";
}

export type RescueReason =
  | "orphan_long"        // short side failed completely
  | "orphan_short"       // long side failed completely
  | "excess_long"        // long filled more than short
  | "excess_short";

export interface ExecutionResult {
  status: "filled" | "partial" | "rescued" | "failed";
  positionId: string;
  executionId: string;
  note?: string;
}
