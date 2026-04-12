import { randomUUID } from "crypto";

export function generateExecutionId(): string {
  return `exec-${randomUUID()}`;
}

export function generateClientOrderId(): string {
  // ccxt clientOrderId limits: Binance 36 chars alphanumeric, OKX 32, Bybit 36, Gate 30
  // Use a 26-char base: "ord-" + 22 hex chars from uuid
  return `ord-${randomUUID().replace(/-/g, "").slice(0, 22)}`;
}
