export type RescuePlan =
  | { kind: "both_filled" }
  | { kind: "both_failed" }
  | { kind: "rescue_orphan"; side: "long" | "short"; qty: number }
  | { kind: "rescue_excess"; side: "long" | "short"; qty: number }
  | { kind: "topup"; side: "long" | "short"; qty: number };

const EXCESS_THRESHOLD = 0.1;

export function decideRescueStrategy(args: {
  longFilled: number;
  shortFilled: number;
}): RescuePlan {
  const { longFilled, shortFilled } = args;

  if (longFilled === 0 && shortFilled === 0) return { kind: "both_failed" };
  if (longFilled === shortFilled) return { kind: "both_filled" };

  if (longFilled === 0) {
    return { kind: "rescue_orphan", side: "short", qty: shortFilled };
  }
  if (shortFilled === 0) {
    return { kind: "rescue_orphan", side: "long", qty: longFilled };
  }

  const matched = Math.min(longFilled, shortFilled);
  const excessSide = longFilled > shortFilled ? "long" : "short";
  const excessQty = parseFloat(Math.abs(longFilled - shortFilled).toPrecision(8));
  const ratio = excessQty / matched;

  if (ratio < EXCESS_THRESHOLD) {
    return { kind: "rescue_excess", side: excessSide, qty: excessQty };
  }
  return {
    kind: "topup",
    side: excessSide === "long" ? "short" : "long",
    qty: excessQty,
  };
}
