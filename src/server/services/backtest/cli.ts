#!/usr/bin/env node
import { phase0SanityCheck } from "./phase0-sanity-check";
import { runBacktest } from "./runner/runner";
import { writeReport } from "./reporter/reporter";
import { DEFAULT_CONFIG, type BacktestConfig } from "./types";

interface CliConfig extends BacktestConfig { phase: "0" | "2"; output: string; }

function parseArgs(): CliConfig {
  const args = process.argv.slice(2);
  const get = (k: string, d?: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : d;
  };
  const toIso = get("to", new Date().toISOString())!;
  const fromIso = get("from", new Date(new Date(toIso).getTime() - 180 * 24 * 3600_000).toISOString())!;
  return {
    ...DEFAULT_CONFIG,
    from: new Date(fromIso),
    to: new Date(toIso),
    phase: (get("phase", "2") as "0" | "2"),
    output: get("output", "docs/backtest-reports")!,
    initialCapital: Number(get("capital", String(DEFAULT_CONFIG.initialCapital))),
    positionSize: Number(get("size", String(DEFAULT_CONFIG.positionSize))),
    maxConcurrent: Number(get("max-concurrent", String(DEFAULT_CONFIG.maxConcurrent))),
    minSpread: Number(get("min-spread", String(DEFAULT_CONFIG.minSpread))),
    minApy: Number(get("min-apy", String(DEFAULT_CONFIG.minApy))),
    slippageBps: Number(get("slippage-bps", String(DEFAULT_CONFIG.slippageBps))),
    failureRate: args.includes("--no-failures") ? 0 : Number(get("failure-rate", String(DEFAULT_CONFIG.failureRate))),
    seed: get("seed", DEFAULT_CONFIG.seed)!,
    volatilityPauseEnabled: !args.includes("--no-vol-pause"),
    healthIntervalSec: Number(get("health-interval-sec", String(DEFAULT_CONFIG.healthIntervalSec))),
  };
}

async function main() {
  const cfg = parseArgs();
  console.log(`[bt] phase ${cfg.phase}`, cfg.from.toISOString(), "→", cfg.to.toISOString());

  if (cfg.phase === "0") {
    const out = await phase0SanityCheck(cfg);
    console.log(`opps=${out.opportunities.length} pnl=$${out.theoreticalPnl.toFixed(2)} verdict=${out.verdict}`);
    return;
  }

  const result = await runBacktest(cfg);
  const dir = await writeReport(result, cfg.output);
  console.log(`[bt] wrote ${dir}`);
  console.log(`[bt] trades=${result.closedTrades.length} equityCurvePoints=${result.equityCurve.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
