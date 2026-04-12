export interface Fill {
  price: number;
  signedQty: number;
}

export function weightedAveragePrice(fills: Fill[]): number {
  let numer = 0;
  let denom = 0;
  for (const f of fills) {
    if (f.signedQty === 0) continue;
    numer += f.price * f.signedQty;
    denom += f.signedQty;
  }
  return denom === 0 ? 0 : numer / denom;
}

export function unrealizedPnl(args: {
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice: number;
}): number {
  const dir = args.side === "long" ? 1 : -1;
  return dir * (args.markPrice - args.entryPrice) * args.size;
}

export function marginRatio(args: {
  equity: number;
  maintenanceMargin: number;
}): number {
  if (args.maintenanceMargin === 0) return Infinity;
  return args.equity / args.maintenanceMargin;
}

export function safetyBuffer(args: {
  usedMargin: number;
  totalMargin: number;
}): number {
  if (args.totalMargin === 0) return 0;
  return 1 - args.usedMargin / args.totalMargin;
}
