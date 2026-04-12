import type { PauseState } from "@/server/db/redis-keys";

interface Args {
  current: PauseState | null;
  priceChange1h: number;
  priceChange24h: number;
  threshold1h: number;
  threshold24h: number;
}

const RECOVERY_RATIO = 0.6;
const RECOVERY_REQUIRED = 3;

export function nextPauseState(args: Args): PauseState | null {
  const abs1h = Math.abs(args.priceChange1h);
  const abs24h = Math.abs(args.priceChange24h);
  const breached1h = abs1h > args.threshold1h;
  const breached24h = abs24h > args.threshold24h;

  if (!args.current) {
    if (breached1h) {
      return {
        paused: true,
        reason: "1h_volatility",
        triggeredAt: new Date().toISOString(),
        recoveryCount: 0,
      };
    }
    if (breached24h) {
      return {
        paused: true,
        reason: "24h_volatility",
        triggeredAt: new Date().toISOString(),
        recoveryCount: 0,
      };
    }
    return null;
  }

  // Already paused
  if (breached1h || breached24h) {
    return { ...args.current, recoveryCount: 0 };
  }

  const recoveryThreshold1h = args.threshold1h * RECOVERY_RATIO;
  const recoveryThreshold24h = args.threshold24h * RECOVERY_RATIO;

  if (abs1h < recoveryThreshold1h && abs24h < recoveryThreshold24h) {
    const newCount = args.current.recoveryCount + 1;
    if (newCount >= RECOVERY_REQUIRED) return null;
    return { ...args.current, recoveryCount: newCount };
  }

  return args.current;
}
