export const keys = {
  rate: (exchange: string, symbol: string) => `rate:${exchange}:${symbol}`,
  price: (exchange: string, symbol: string) => `price:${exchange}:${symbol}`,
  balance: (exchange: string) => `balance:${exchange}`,
  opportunityLatest: () => `opportunity:latest`,
  pause: (symbol: string) => `pause:${symbol}`,
  /** Caller-supplied idempotency key lock (prevents duplicate executions) */
  idempotencyLock: (key: string) => `idem:lock:${key}`,
  /** Cached result for an idempotency key — duplicate calls replay this */
  idempotencyResult: (key: string) => `idem:result:${key}`,
} as const;

export interface PauseState {
  paused: true;
  reason: "1h_volatility" | "24h_volatility" | "manual";
  triggeredAt: string; // ISO
  recoveryCount: number;
}
