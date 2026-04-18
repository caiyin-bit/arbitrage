export function applySlippage(
  basePrice: number,
  side: "long" | "short",
  bps: number,
): number {
  const factor = bps / 10_000;
  return side === "long" ? basePrice * (1 + factor) : basePrice * (1 - factor);
}
