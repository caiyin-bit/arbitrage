#!/usr/bin/env node
import { loadAllHistory } from "./loader";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (k: string, d?: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : d;
  };
  const to = new Date(get("to", new Date().toISOString())!);
  const from = new Date(get("from", new Date(to.getTime() - 180 * 24 * 3600_000).toISOString())!);
  const exchanges = (get("exchanges", "binance,okx,bybit")!).split(",");
  const symbols = (get("symbols", "BTC/USDT:USDT,ETH/USDT:USDT,SOL/USDT:USDT,BNB/USDT:USDT,XRP/USDT:USDT")!).split(",");
  const timeframe = get("timeframe", "1h")!;
  return { from, to, exchanges, symbols, timeframe };
}

async function main() {
  const opts = parseArgs();
  console.log("[loader] from", opts.from.toISOString(), "to", opts.to.toISOString());
  console.log("[loader] exchanges:", opts.exchanges.join(", "));
  console.log("[loader] symbols:", opts.symbols.join(", "));
  const totals = await loadAllHistory(opts);
  console.log("[loader] totals:", totals);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
