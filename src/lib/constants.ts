export const EXCHANGE_NAMES = [
  "binance",
  "okx",
  "bybit",
  "gateio",
  "huobi",
  "mock-binance",
] as const;

export type ExchangeName = (typeof EXCHANGE_NAMES)[number];

// Dev-only synthetic exchanges. Used locally to generate fake counter-rates
// against a real exchange so the opportunity detector + position flow can
// be tested end-to-end without a working second live venue. Never enable in
// production.
export const MOCK_EXCHANGE_NAMES: readonly ExchangeName[] = ["mock-binance"];

export function isMockExchange(name: string): boolean {
  return (MOCK_EXCHANGE_NAMES as readonly string[]).includes(name);
}

export const SETTLEMENTS_PER_DAY: Record<number, number> = {
  1: 24,
  4: 6,
  8: 3,
};
