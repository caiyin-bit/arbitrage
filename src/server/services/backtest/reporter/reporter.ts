import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BacktestResult } from "@/server/services/backtest/types";
import { aggregate } from "./aggregate";
import { renderHtml } from "./html-template";
import { renderMarkdown } from "./markdown-template";
import { toCsv } from "./csv-writer";

export async function writeReport(result: BacktestResult, outRoot: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(outRoot, stamp);
  await mkdir(dir, { recursive: true });

  const agg = aggregate(result.closedTrades, result.equityCurve, result.config.initialCapital);

  await writeFile(path.join(dir, "report.html"), renderHtml(result.config, agg, result.equityCurve), "utf8");
  await writeFile(path.join(dir, "report.md"), renderMarkdown(result.config, agg), "utf8");

  const tradesCsv = toCsv(
    ["positionId","symbol","longExchange","shortExchange","openedAt","closedAt",
     "longEntry","shortEntry","longExit","shortExit",
     "grossPnl","fees","fundingPnl","netPnl","holdHours"],
    result.closedTrades.map((t) => [
      t.positionId, t.symbol, t.longExchange, t.shortExchange, t.openedAt, t.closedAt,
      t.longEntry, t.shortEntry, t.longExit, t.shortExit,
      t.grossPnl, t.fees, t.fundingPnl, t.netPnl, t.holdHours,
    ]),
  );
  await writeFile(path.join(dir, "trades.csv"), tradesCsv, "utf8");

  const dailyCsv = toCsv(
    ["date","equity","grossPnl","netPnl","totalFees"],
    result.equityCurve.map((p) => [p.date, p.equity, p.grossPnl, p.netPnl, p.totalFees]),
  );
  await writeFile(path.join(dir, "daily.csv"), dailyCsv, "utf8");

  return dir;
}
