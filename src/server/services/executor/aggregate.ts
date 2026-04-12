export interface RawFill {
  side: "long" | "short";
  action: "open" | "close" | "rescue";
  signedQty: number;
  price: number;
  status: "filled" | "pending" | "failed";
}

export interface Aggregates {
  longSize: number;
  longAvgEntry: number;
  shortSize: number;
  shortAvgEntry: number;
}

export function computeAggregates(fills: RawFill[]): Aggregates {
  const filled = fills.filter((f) => f.status === "filled");

  const longAll = filled.filter((f) => f.side === "long");
  const shortAll = filled.filter((f) => f.side === "short");

  const sum = (rows: RawFill[]) => rows.reduce((a, b) => a + b.signedQty, 0);

  const wavg = (rows: RawFill[]) => {
    const opens = rows.filter((r) => r.action === "open");
    const denom = opens.reduce((a, b) => a + b.signedQty, 0);
    if (denom === 0) return 0;
    const numer = opens.reduce((a, b) => a + b.price * b.signedQty, 0);
    return numer / denom;
  };

  return {
    longSize: sum(longAll),
    longAvgEntry: wavg(longAll),
    shortSize: sum(shortAll),
    shortAvgEntry: wavg(shortAll),
  };
}
