export const EXCHANGE_NAMES = [
  "binance",
  "okx",
  "bybit",
  "gateio",
] as const;

export type ExchangeName = (typeof EXCHANGE_NAMES)[number];

export const SETTLEMENTS_PER_DAY: Record<number, number> = {
  1: 24,
  4: 6,
  8: 3,
};
