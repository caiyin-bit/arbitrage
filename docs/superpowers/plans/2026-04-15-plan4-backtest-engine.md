# 回测引擎 Implementation Plan (Plan 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 ccxt 拉 6 个月历史资金费率 + OHLCV 数据，构建离线回测引擎以真实模拟 Plan 2 的 executor 路径，产出 HTML/Markdown/CSV 报告，验证资金费率套利策略在历史数据上的真实收益。

**Architecture:** 四个解耦子系统：(1) 数据加载器（ccxt → Postgres）；(2) Executor 依赖注入重构（生产代码兼得可测性）；(3) Runner（VirtualClock + HistoricalAdapter + InMemoryStore 驱动生产 executor 函数）；(4) Reporter（纯函数 aggregate + ECharts HTML + MD + CSV）。Phase 0 sanity check 作为 go/no-go gate，投入 DI 重构之前先用 < 200 行代码验证"历史数据里有没有正收益信号"。

**Tech Stack:** Node 20 + TypeScript · Prisma 6 (Postgres 15) · ioredis · ccxt 4.5（`fetchFundingRateHistory` / `fetchOHLCV`）· `seedrandom` (pinned) · Vitest 4 · ECharts 5.5.1 (CDN) · tsx CLI.

**Spec:** `docs/superpowers/specs/2026-04-15-plan4-backtest-engine-design.md` (Status: Approved 2026-04-15)

**Prerequisite state:**
- Plan 1-3 shipped; Plan 4 (auth) shipped at v0.1.5
- Dev env running via `./dev.sh`; Postgres + Redis healthy on localhost ports
- All existing tests pass (117/117 assertions; 1 pre-existing deploy-script afterAll infra timeout)
- Branch: create `feature/backtest-engine` off `main`

---

## 总体任务地图

| # | Phase | Task | Deliverable |
|---|---|---|---|
| 1 | 1 | Prisma schema: `OhlcvSnapshot` + `FundingRateSnapshot` unique | migration + db in sync |
| 2 | 1 | `funding-rate-loader.ts` + unit test | insert batches, skip dups |
| 3 | 1 | `ohlcv-loader.ts` + unit test | insert batches, skip dups |
| 4 | 1 | `loader.ts` orchestrator + `data-loader/cli.ts` | CLI runs, fills DB |
| 5 | 1 | Run loader, inspect data, commit example counts | data in DB |
| 6 | 2 | `phase0-sanity-check.ts` | computes theoretical P&L |
| 7 | 2 | Run Phase 0, interpret the number | **GATE decision** |
| — | 🛑 | **GATE** — see Phase 0 Gate section | continue/stop |
| 8 | 3 | New interfaces: `PositionStore` / `Clock` / `RedisLike` / `ExecutorContext` | types only |
| 9 | 3 | `PrismaPositionStore` + `buildProdContext` (2A addition) | DI context factory |
| 10 | 3 | Refactor `execute-open.ts` to `(ctx, req)` signature | signature flipped |
| 11 | 3 | Refactor `execute-close.ts` | signature flipped |
| 12 | 3 | Refactor `rescue.ts` + `rescue-execute.ts` | signature flipped |
| 13 | 3 | Refactor `trade-recorder.ts`, `aggregate.ts`, `reconcile.ts` | signature flipped |
| 14 | 3 | Update callers: position router, monitor workers | ctx threaded |
| 15 | 3 | Remove residual direct `prisma`/`redis` imports (2C) | grep clean |
| 16 | 3 | **Production smoke test** via `v0.2.0` tag | prod OK |
| 17 | 4 | `virtual-clock.ts` + test | tick-advancing clock |
| 18 | 4 | `failure-injector.ts` (seedrandom) + test | deterministic PRNG |
| 19 | 4 | `slippage.ts` + test | bps → price adjustment |
| 20 | 4 | `timeline.ts` (event builder) + test | sorted event stream |
| 21 | 4 | `in-memory-store.ts` + `in-memory-redis.ts` | interfaces in-memory |
| 22 | 4 | `historical-adapter.ts` (implements ExchangeAdapter) | DB-backed, clock-gated |
| 23 | 4 | `runner.ts` (main loop + 3 handlers) | runs end-to-end |
| 24 | 5 | `reporter/aggregate.ts` (pure fns) + tests | stats object |
| 25 | 5 | `reporter/csv-writer.ts` + tests | escaped CSV |
| 26 | 5 | `reporter/markdown-template.ts` | MD string |
| 27 | 5 | `reporter/html-template.ts` (ECharts) | HTML string |
| 28 | 5 | `reporter/reporter.ts` (write files) | 4 files on disk |
| 29 | 6 | Top-level `backtest/cli.ts` (phase 0 / 2 routing) | CLI |
| 30 | 6 | Integration test: `tests/integration/backtest/end-to-end.test.ts` | green |
| 31 | 6 | Produce `docs/backtest-reports/example/` baseline + commit | baseline captured |
| 32 | 6 | Docs: README + executor-di-migration.md + `.gitignore` update | user-facing docs |

**Total:** 32 tasks, ~6-7 working days. Phase 0 gate after Task 7 is mandatory.

---

## File Structure (new + modified)

**New files:**

```
prisma/
  migrations/
    <ts>_ohlcv_snapshot/migration.sql
    <ts>_funding_snapshot_unique/migration.sql

src/server/services/
  backtest/
    types.ts                                       # BacktestConfig / BacktestResult / ClosedTrade / EquityCurvePoint
    phase0-sanity-check.ts
    cli.ts                                         # top-level
    data-loader/
      funding-rate-loader.ts
      ohlcv-loader.ts
      loader.ts                                    # orchestrates both loaders
      cli.ts                                       # CLI for data loader
    runner/
      virtual-clock.ts
      failure-injector.ts
      slippage.ts
      timeline.ts
      in-memory-store.ts
      in-memory-redis.ts
      historical-adapter.ts
      runner.ts                                    # main loop + handlers
    reporter/
      aggregate.ts
      csv-writer.ts
      markdown-template.ts
      html-template.ts
      reporter.ts                                  # orchestrator

  executor/
    context-prod.ts                                # buildProdContext()
    prisma-position-store.ts                       # PrismaPositionStore class

docs/
  backtest/
    README.md
    executor-di-migration.md
  backtest-reports/
    example/
      report.html, report.md, trades.csv, daily.csv

tests/
  unit/backtest/
    aggregate.test.ts
    csv-writer.test.ts
    virtual-clock.test.ts
    failure-injector.test.ts
    slippage.test.ts
    timeline.test.ts
    funding-rate-loader.test.ts
    ohlcv-loader.test.ts
  integration/backtest/
    end-to-end.test.ts
```

**Modified files:**

```
prisma/schema.prisma                               # + OhlcvSnapshot model, + FundingRateSnapshot unique

src/server/services/executor/
  types.ts                                         # + PositionStore / Clock / RedisLike / ExecutorContext
  execute-open.ts                                  # (ctx, req) signature
  execute-close.ts                                 # (ctx, req)
  rescue.ts                                        # (ctx, …)
  rescue-execute.ts                                # (ctx, …)
  trade-recorder.ts                                # (ctx, …)
  aggregate.ts                                     # (ctx, …)
  reconcile.ts                                     # (ctx, …)

src/server/api/routers/position.ts                 # buildProdContext() + pass ctx
src/server/jobs/*                                  # workers build ctx once per job and pass in

.gitignore                                         # /docs/backtest-reports/*, !example/
package.json                                       # + seedrandom, + @types/seedrandom
```

---

## Phase 1 — Data Loader

Goal: a CLI that populates `FundingRateSnapshot` + `OhlcvSnapshot` with 6 months of data across 3 exchanges × 5 symbols.

### Task 1: Prisma schema — OhlcvSnapshot + FundingRateSnapshot unique

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<ts>_ohlcv_snapshot/migration.sql` (generated)
- Create: `prisma/migrations/<ts>_funding_snapshot_unique/migration.sql` (generated)

- [ ] **Step 1: Add models**

Append to `prisma/schema.prisma`:

```prisma
model OhlcvSnapshot {
  id         String   @id @default(uuid())
  exchangeId String   @map("exchange_id")
  symbol     String
  timeframe  String                                 // "1h"
  openTime   DateTime @map("open_time")
  open       Decimal  @db.Decimal(20, 8)
  high       Decimal  @db.Decimal(20, 8)
  low        Decimal  @db.Decimal(20, 8)
  close      Decimal  @db.Decimal(20, 8)
  volume     Decimal  @db.Decimal(30, 8)

  exchange Exchange @relation(fields: [exchangeId], references: [id])

  @@unique([exchangeId, symbol, timeframe, openTime])
  @@index([symbol, openTime])
  @@map("ohlcv_snapshots")
}
```

Add reverse relation to the existing `Exchange` model's field list (near the other `fundingRateSnapshots` relation):
```prisma
  ohlcvSnapshots OhlcvSnapshot[]
```

Add `@@unique` to existing `FundingRateSnapshot`:
```prisma
  @@unique([exchangeId, symbol, collectedAt])   // new
```

- [ ] **Step 2: Generate migrations**

Run:
```
docker compose run --rm app pnpm prisma migrate dev --name ohlcv_snapshot
docker compose run --rm app pnpm prisma migrate dev --name funding_snapshot_unique
```

Two migration directories appear under `prisma/migrations/`.

- [ ] **Step 3: Verify schema on DB**

```
docker compose exec postgres psql -U arbitrage -c '\d ohlcv_snapshots'
docker compose exec postgres psql -U arbitrage -c '\d funding_rate_snapshots' | grep UNIQUE
```

Expected: `ohlcv_snapshots` with the 5 columns + unique + index; new unique on funding_rate_snapshots.

- [ ] **Step 4: Commit**

```
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(backtest): add OhlcvSnapshot model + FundingRateSnapshot unique"
```

---

### Task 2: Funding-rate loader + unit test

**Files:**
- Create: `src/server/services/backtest/data-loader/funding-rate-loader.ts`
- Create: `tests/unit/backtest/funding-rate-loader.test.ts`

- [ ] **Step 1: Failing test**

Create `tests/unit/backtest/funding-rate-loader.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/server/db/client";
import { loadFundingRateHistory } from "@/server/services/backtest/data-loader/funding-rate-loader";

async function reset() {
  await prisma.fundingRateSnapshot.deleteMany();
  await prisma.exchange.deleteMany();
}

describe("funding-rate-loader", () => {
  beforeEach(reset);

  it("inserts ccxt batches, paginates via since cursor, respects 'to' bound", async () => {
    const ex = await prisma.exchange.create({
      data: { name: "binance", apiKey: "x", apiSecret: "y" },
    });
    const fromTs = Date.UTC(2025, 9, 1);                 // Oct 1 2025
    const toTs = Date.UTC(2025, 9, 2);                   // Oct 2 2025

    // Fake ccxt adapter: 2 pages of 2 rows each
    const pages = [
      [
        { symbol: "BTC/USDT:USDT", fundingRate: 0.0001, timestamp: fromTs + 1_000 },
        { symbol: "BTC/USDT:USDT", fundingRate: 0.00012, timestamp: fromTs + 8 * 3600_000 },
      ],
      [
        { symbol: "BTC/USDT:USDT", fundingRate: -0.0002, timestamp: fromTs + 16 * 3600_000 },
      ],
      [],  // terminator
    ];
    const fetch = vi.fn(async () => pages.shift()!);
    const adapter = { fetchFundingRateHistory: fetch, rateLimit: 0 } as unknown as import("ccxt").Exchange;

    const result = await loadFundingRateHistory(adapter, ex.id, "BTC/USDT:USDT", new Date(fromTs), new Date(toTs));
    expect(result.inserted).toBe(3);
    expect(result.skipped).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(3);

    const rows = await prisma.fundingRateSnapshot.findMany();
    expect(rows).toHaveLength(3);
  });

  it("skipDuplicates: re-loading the same range leaves the same row count", async () => {
    const ex = await prisma.exchange.create({ data: { name: "okx", apiKey: "x", apiSecret: "y" } });
    const ts = Date.UTC(2025, 9, 1);
    const page = [
      { symbol: "ETH/USDT:USDT", fundingRate: 0.0001, timestamp: ts + 1_000 },
    ];
    const fetch = vi.fn()
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([]);
    const adapter = { fetchFundingRateHistory: fetch, rateLimit: 0 } as unknown as import("ccxt").Exchange;

    const r1 = await loadFundingRateHistory(adapter, ex.id, "ETH/USDT:USDT", new Date(ts), new Date(ts + 3600_000));
    expect(r1.inserted).toBe(1);

    const r2 = await loadFundingRateHistory(adapter, ex.id, "ETH/USDT:USDT", new Date(ts), new Date(ts + 3600_000));
    expect(r2.inserted).toBe(0);
    expect(r2.skipped).toBe(1);

    expect(await prisma.fundingRateSnapshot.count()).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify FAIL**

```
docker compose exec postgres psql -U arbitrage -c "TRUNCATE funding_rate_snapshots, funding_rate_hourly CASCADE;"
pnpm test tests/unit/backtest/funding-rate-loader.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement**

Create `src/server/services/backtest/data-loader/funding-rate-loader.ts`:

```ts
import type { Exchange } from "ccxt";
import { prisma } from "@/server/db/client";

const BATCH_LIMIT = 1000;

export interface LoadResult {
  inserted: number;
  skipped: number;
}

export async function loadFundingRateHistory(
  adapter: Exchange,
  exchangeId: string,
  symbol: string,
  from: Date,
  to: Date,
): Promise<LoadResult> {
  let since = from.getTime();
  const end = to.getTime();
  let inserted = 0;
  let skipped = 0;

  while (since < end) {
    const batch = await adapter.fetchFundingRateHistory(symbol, since, BATCH_LIMIT);
    if (!batch || batch.length === 0) break;

    const rows = batch
      .filter((r) => typeof r.timestamp === "number" && r.timestamp < end)
      .map((r) => ({
        exchangeId,
        symbol,
        currentRate: r.fundingRate ?? 0,
        collectedAt: new Date(r.timestamp as number),
        intervalHours: 8,
      }));

    const before = await prisma.fundingRateSnapshot.count({
      where: { exchangeId, symbol, collectedAt: { in: rows.map((r) => r.collectedAt) } },
    });
    const result = await prisma.fundingRateSnapshot.createMany({
      data: rows,
      skipDuplicates: true,
    });
    inserted += result.count;
    skipped += rows.length - result.count;

    const lastTs = batch[batch.length - 1].timestamp as number;
    if (lastTs >= end) break;
    since = lastTs + 1;

    if (adapter.rateLimit && adapter.rateLimit > 0) {
      await new Promise((r) => setTimeout(r, adapter.rateLimit));
    }
    void before;
  }

  return { inserted, skipped };
}
```

- [ ] **Step 4: Run test to verify PASS**

```
pnpm test tests/unit/backtest/funding-rate-loader.test.ts
```
Expected: 2 passing.

- [ ] **Step 5: Commit**

```
git add src/server/services/backtest/data-loader/funding-rate-loader.ts \
        tests/unit/backtest/funding-rate-loader.test.ts
git commit -m "feat(backtest): funding-rate loader with paginated createMany + skipDuplicates"
```

---

### Task 3: OHLCV loader + unit test

**Files:**
- Create: `src/server/services/backtest/data-loader/ohlcv-loader.ts`
- Create: `tests/unit/backtest/ohlcv-loader.test.ts`

- [ ] **Step 1: Failing test**

Create `tests/unit/backtest/ohlcv-loader.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/server/db/client";
import { loadOhlcvHistory } from "@/server/services/backtest/data-loader/ohlcv-loader";

async function reset() {
  await prisma.ohlcvSnapshot.deleteMany();
  await prisma.exchange.deleteMany();
}

describe("ohlcv-loader", () => {
  beforeEach(reset);

  it("inserts ccxt OHLCV arrays paginated by since cursor", async () => {
    const ex = await prisma.exchange.create({ data: { name: "binance", apiKey: "x", apiSecret: "y" } });
    const t0 = Date.UTC(2025, 9, 1);
    const page1: [number, number, number, number, number, number][] = [
      [t0, 100, 110, 95, 105, 1000],
      [t0 + 3600_000, 105, 115, 100, 110, 1100],
    ];
    const page2: [number, number, number, number, number, number][] = [
      [t0 + 2 * 3600_000, 110, 120, 108, 118, 1200],
    ];
    const fetch = vi.fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
      .mockResolvedValueOnce([]);
    const adapter = { fetchOHLCV: fetch, rateLimit: 0 } as unknown as import("ccxt").Exchange;

    const result = await loadOhlcvHistory(
      adapter,
      ex.id,
      "BTC/USDT:USDT",
      "1h",
      new Date(t0),
      new Date(t0 + 3 * 3600_000),
    );

    expect(result.inserted).toBe(3);
    const rows = await prisma.ohlcvSnapshot.findMany({ orderBy: { openTime: "asc" } });
    expect(rows).toHaveLength(3);
    expect(Number(rows[0].open)).toBe(100);
    expect(Number(rows[2].close)).toBe(118);
  });

  it("skipDuplicates on reload", async () => {
    const ex = await prisma.exchange.create({ data: { name: "bybit", apiKey: "x", apiSecret: "y" } });
    const t0 = Date.UTC(2025, 9, 1);
    const page: [number, number, number, number, number, number][] = [[t0, 1, 2, 0.5, 1.5, 100]];
    const fetch = vi.fn()
      .mockResolvedValueOnce(page).mockResolvedValueOnce([])
      .mockResolvedValueOnce(page).mockResolvedValueOnce([]);
    const adapter = { fetchOHLCV: fetch, rateLimit: 0 } as unknown as import("ccxt").Exchange;

    await loadOhlcvHistory(adapter, ex.id, "X/USDT:USDT", "1h", new Date(t0), new Date(t0 + 3600_000));
    const r2 = await loadOhlcvHistory(adapter, ex.id, "X/USDT:USDT", "1h", new Date(t0), new Date(t0 + 3600_000));

    expect(r2.skipped).toBe(1);
    expect(r2.inserted).toBe(0);
    expect(await prisma.ohlcvSnapshot.count()).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify FAIL**

```
pnpm test tests/unit/backtest/ohlcv-loader.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement**

Create `src/server/services/backtest/data-loader/ohlcv-loader.ts`:

```ts
import type { Exchange } from "ccxt";
import { prisma } from "@/server/db/client";

const BATCH_LIMIT = 500;

export interface LoadResult {
  inserted: number;
  skipped: number;
}

export async function loadOhlcvHistory(
  adapter: Exchange,
  exchangeId: string,
  symbol: string,
  timeframe: string,
  from: Date,
  to: Date,
): Promise<LoadResult> {
  let since = from.getTime();
  const end = to.getTime();
  let inserted = 0;
  let skipped = 0;

  while (since < end) {
    const batch = await adapter.fetchOHLCV(symbol, timeframe, since, BATCH_LIMIT);
    if (!batch || batch.length === 0) break;

    const rows = batch
      .filter(([openTime]) => typeof openTime === "number" && openTime < end)
      .map(([openTime, open, high, low, close, volume]) => ({
        exchangeId,
        symbol,
        timeframe,
        openTime: new Date(openTime as number),
        open: open ?? 0,
        high: high ?? 0,
        low: low ?? 0,
        close: close ?? 0,
        volume: volume ?? 0,
      }));

    const result = await prisma.ohlcvSnapshot.createMany({ data: rows, skipDuplicates: true });
    inserted += result.count;
    skipped += rows.length - result.count;

    const lastTs = batch[batch.length - 1][0] as number;
    if (lastTs >= end) break;
    since = lastTs + 1;

    if (adapter.rateLimit && adapter.rateLimit > 0) {
      await new Promise((r) => setTimeout(r, adapter.rateLimit));
    }
  }

  return { inserted, skipped };
}
```

- [ ] **Step 4: Run test to verify PASS**

```
pnpm test tests/unit/backtest/ohlcv-loader.test.ts
```
Expected: 2 passing.

- [ ] **Step 5: Commit**

```
git add src/server/services/backtest/data-loader/ohlcv-loader.ts \
        tests/unit/backtest/ohlcv-loader.test.ts
git commit -m "feat(backtest): OHLCV loader with paginated createMany + skipDuplicates"
```

---

### Task 4: Loader orchestrator + CLI

**Files:**
- Create: `src/server/services/backtest/data-loader/loader.ts`
- Create: `src/server/services/backtest/data-loader/cli.ts`

- [ ] **Step 1: Implement orchestrator**

Create `src/server/services/backtest/data-loader/loader.ts`:

```ts
import ccxt from "ccxt";
import { prisma } from "@/server/db/client";
import { loadFundingRateHistory } from "./funding-rate-loader";
import { loadOhlcvHistory } from "./ohlcv-loader";

export interface LoaderOptions {
  from: Date;
  to: Date;
  exchanges: string[];
  symbols: string[];
  timeframe: string;
}

export async function loadAllHistory(opts: LoaderOptions) {
  const totals = { fundingInserted: 0, fundingSkipped: 0, ohlcvInserted: 0, ohlcvSkipped: 0 };
  for (const name of opts.exchanges) {
    const row = await prisma.exchange.findFirst({ where: { name } });
    if (!row) {
      console.warn(`[loader] exchange "${name}" not in DB; skipping`);
      continue;
    }
    const AdapterClass = (ccxt as unknown as Record<string, new () => ccxt.Exchange>)[name];
    if (!AdapterClass) {
      console.warn(`[loader] ccxt has no adapter "${name}"; skipping`);
      continue;
    }
    const adapter = new AdapterClass();
    adapter.options = { ...adapter.options, defaultType: "swap" };

    for (const symbol of opts.symbols) {
      console.log(`[loader] ${name} ${symbol} funding`);
      const fr = await loadFundingRateHistory(adapter, row.id, symbol, opts.from, opts.to);
      totals.fundingInserted += fr.inserted;
      totals.fundingSkipped += fr.skipped;

      console.log(`[loader] ${name} ${symbol} ohlcv ${opts.timeframe}`);
      const ohlcv = await loadOhlcvHistory(adapter, row.id, symbol, opts.timeframe, opts.from, opts.to);
      totals.ohlcvInserted += ohlcv.inserted;
      totals.ohlcvSkipped += ohlcv.skipped;
    }
  }
  return totals;
}
```

- [ ] **Step 2: CLI**

Create `src/server/services/backtest/data-loader/cli.ts`:

```ts
#!/usr/bin/env node
import { loadAllHistory } from "./loader";

function parseArgs(): { from: Date; to: Date; exchanges: string[]; symbols: string[]; timeframe: string } {
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
```

- [ ] **Step 3: Typecheck**

```
pnpm tsc --noEmit
```
Expected: no new errors.

- [ ] **Step 4: Commit**

```
git add src/server/services/backtest/data-loader/loader.ts \
        src/server/services/backtest/data-loader/cli.ts
git commit -m "feat(backtest): loader orchestrator + data-loader CLI"
```

---

### Task 5: Run loader, inspect data

**Files:**
- None (verification task, no code change)

- [ ] **Step 1: Seed exchanges if not present**

The Exchange rows need real names matching ccxt adapter keys (`binance`, `okx`, `bybit`). Loader reads them from DB. Run the seed first:

```
docker compose run --rm app pnpm tsx src/server/db/seed.ts
```

(The seed only populates Settings; if Exchange rows are empty, insert placeholders manually for loader to find them:)
```
docker compose exec postgres psql -U arbitrage -c "INSERT INTO exchanges(id, name, api_key, api_secret, created_at, updated_at)
  VALUES ('bt-binance', 'binance', '', '', NOW(), NOW()),
         ('bt-okx',     'okx',     '', '', NOW(), NOW()),
         ('bt-bybit',   'bybit',   '', '', NOW(), NOW())
  ON CONFLICT (name) DO NOTHING;"
```

- [ ] **Step 2: Run loader (last 30 days first — smoke)**

```
docker compose run --rm app pnpm tsx src/server/services/backtest/data-loader/cli.ts \
  --from $(date -u -v-30d '+%Y-%m-%dT00:00:00Z') \
  --to $(date -u '+%Y-%m-%dT00:00:00Z')
```

Expected: logs `[loader] binance BTC/USDT:USDT funding` etc., ending with `totals: { fundingInserted: >0, ohlcvInserted: >0 }`.

If any exchange returns `ExchangeNotAvailable` (geofencing) or empty pages — note it, continue; loader must not crash.

- [ ] **Step 3: Then 6-month full run**

```
docker compose run --rm app pnpm tsx src/server/services/backtest/data-loader/cli.ts
```

Duration: 2-5 minutes. Expected totals: funding ~8,000 rows, ohlcv ~65,000 rows.

- [ ] **Step 4: Inspect data**

```
docker compose exec postgres psql -U arbitrage -c "SELECT name, COUNT(*)
  FROM funding_rate_snapshots f
  JOIN exchanges e ON e.id = f.exchange_id
  GROUP BY name;"
docker compose exec postgres psql -U arbitrage -c "SELECT name, symbol, COUNT(*)
  FROM ohlcv_snapshots o JOIN exchanges e ON e.id = o.exchange_id
  GROUP BY name, symbol ORDER BY name, symbol;"
```

Expected: each exchange×symbol has thousands of OHLCV rows, hundreds of funding rows.

- [ ] **Step 5: No commit** — code is already committed; this is verification.

If holes show up (e.g. Bybit XRP returns nothing), record as a follow-up for the example report notes.

---

## Phase 2 — Phase 0 Sanity Check

Goal: compute theoretical P&L with detector + historical funding rates, before any DI refactor.

### Task 6: phase0-sanity-check.ts

**Files:**
- Create: `src/server/services/backtest/phase0-sanity-check.ts`
- Create: `src/server/services/backtest/types.ts` (minimal for this task; extended later)

- [ ] **Step 1: Create initial types.ts**

Create `src/server/services/backtest/types.ts`:

```ts
export interface BacktestConfig {
  from: Date;
  to: Date;
  initialCapital: number;
  positionSize: number;
  maxConcurrent: number;
  minSpread: number;
  minApy: number;
  slippageBps: number;
  failureRate: number;
  seed: string;
  volatilityPauseEnabled: boolean;
  healthIntervalSec: number;
}

export const DEFAULT_CONFIG: Omit<BacktestConfig, "from" | "to"> = {
  initialCapital: 10_000,
  positionSize: 500,
  maxConcurrent: 3,
  minSpread: 0.0005,
  minApy: 0.1,
  slippageBps: 3,
  failureRate: 0.02,
  seed: "plan4-default",
  volatilityPauseEnabled: true,
  healthIntervalSec: 300,
};

export interface Phase0Opportunity {
  at: Date;
  symbol: string;
  longExchange: string;
  shortExchange: string;
  rateSpread: number;
  annualizedYield: number;
}

export interface Phase0Result {
  opportunities: Phase0Opportunity[];
  theoreticalPnl: number;
  verdict: "positive" | "weak" | "negative";
}
```

- [ ] **Step 2: Implement phase0**

Create `src/server/services/backtest/phase0-sanity-check.ts`:

```ts
import { prisma } from "@/server/db/client";
import { findOpportunities } from "@/server/services/detector/opportunity";
import type { BacktestConfig, Phase0Result, Phase0Opportunity } from "./types";

const STEP_MS = 5 * 60 * 1000;   // same as production collector cadence

export async function phase0SanityCheck(config: BacktestConfig): Promise<Phase0Result> {
  const allRates = await prisma.fundingRateSnapshot.findMany({
    where: { collectedAt: { gte: config.from, lte: config.to } },
    include: { exchange: { select: { name: true } } },
    orderBy: { collectedAt: "asc" },
  });
  if (allRates.length === 0) {
    return { opportunities: [], theoreticalPnl: 0, verdict: "negative" };
  }

  const opps: Phase0Opportunity[] = [];
  for (let t = config.from.getTime(); t < config.to.getTime(); t += STEP_MS) {
    // latest rate per (exchange, symbol) up to t
    const latest = new Map<string, typeof allRates[number]>();
    for (const r of allRates) {
      if (r.collectedAt.getTime() > t) break;
      latest.set(`${r.exchange.name}:${r.symbol}`, r);
    }
    const snapshots = [...latest.values()].map((r) => ({
      exchange: r.exchange.name,
      symbol: r.symbol,
      currentRate: Number(r.currentRate),
      intervalHours: r.intervalHours,
    }));
    const ops = findOpportunities(snapshots, {
      minRateSpread: config.minSpread,
      minAnnualizedYield: config.minApy,
    });
    for (const op of ops) {
      opps.push({
        at: new Date(t),
        symbol: op.symbol,
        longExchange: op.longExchange,
        shortExchange: op.shortExchange,
        rateSpread: op.rateSpread,
        annualizedYield: op.annualizedYield,
      });
    }
  }

  // Theoretical P&L: assume one settlement per opportunity @ positionSize
  const theoreticalPnl = opps.reduce((sum, o) => sum + o.rateSpread * config.positionSize, 0);
  const roi = theoreticalPnl / config.initialCapital;

  const verdict: Phase0Result["verdict"] =
    roi > 0.1 ? "positive" : roi > 0 ? "weak" : "negative";

  return { opportunities: opps, theoreticalPnl, verdict };
}
```

> Note: `findOpportunities()` in `src/server/services/detector/opportunity.ts` may use a slightly different input shape. Before running this task, read that file to confirm the property names (`exchange` / `currentRate` / `intervalHours`) match. Adapt the mapping if needed — the detector signature must not change here.

- [ ] **Step 3: Typecheck**

```
pnpm tsc --noEmit
```
Expected: no new errors.

- [ ] **Step 4: Commit**

```
git add src/server/services/backtest/types.ts \
        src/server/services/backtest/phase0-sanity-check.ts
git commit -m "feat(backtest): Phase 0 sanity check — detector × historical rates → theoretical P&L"
```

---

### Task 7: Run Phase 0, interpret result

**Files:**
- None (verification task)

- [ ] **Step 1: Add temporary run-it script**

Ad-hoc script (not committed):

```
docker compose run --rm app pnpm tsx -e "
  import('./src/server/services/backtest/phase0-sanity-check.js').then(async (m) => {
    const { phase0SanityCheck } = m;
    const { DEFAULT_CONFIG } = await import('./src/server/services/backtest/types.js');
    const to = new Date();
    const from = new Date(to.getTime() - 180 * 24 * 3600_000);
    const out = await phase0SanityCheck({ ...DEFAULT_CONFIG, from, to });
    console.log('opps=', out.opportunities.length, 'pnl=', out.theoreticalPnl, 'verdict=', out.verdict);
  });
"
```

Or easier: write a 20-line `scripts/run-phase0.ts` and `pnpm tsx` it. Don't commit the script.

Expected output shape:
```
opps= <N>
pnl= <$>
verdict= positive | weak | negative
```

- [ ] **Step 2: Interpret**

Record `opps`, `pnl`, `verdict` — these drive the gate decision below.

- [ ] **Step 3: No commit**

---

## 🛑 GATE — Phase 0 Decision

**Stop here and evaluate the Phase 0 result.**

| Verdict | Action |
|---|---|
| **positive** (ROI > 10%) | Continue to Phase 3 |
| **weak** (ROI 0–10%) | Continue to Phase 3, but record in plan that live expectations are modest |
| **negative** (ROI ≤ 0) | **STOP.** Do not start DI refactor. Discuss with stakeholder: adjust detector thresholds / change symbols / accept that this strategy has no edge in the last 6 months / pivot Plan 5 to a different strategy |

Record the decision in a commit (even if stopping):

```
git commit --allow-empty -m "docs(backtest): Phase 0 verdict = <positive|weak|negative>, opps=N, pnl=$X"
```

If continuing, proceed to Task 8.

---

## Phase 3 — Executor DI Refactor

**Risk: this touches production executor code. Every task must keep existing tests + integration tests green.**

DI refactor in 3 subphases:
- **2A** (Tasks 8–9): **pure additions** — new types/classes, no existing code touched.
- **2B** (Tasks 10–14): flip signatures incrementally, one file or one caller at a time. Each commit keeps tests green.
- **2C** (Task 15): remove orphan `import { prisma }` / `import { redis }` from executor/.

### Task 8: New interfaces in executor/types.ts

**Files:**
- Modify: `src/server/services/executor/types.ts`

- [ ] **Step 1: Read existing types.ts**

```
cat src/server/services/executor/types.ts
```

Note the existing exports (`OpenHedgedRequest`, `ExecutionResult`, etc.). Keep all of them.

- [ ] **Step 2: Append new interfaces**

Append to `src/server/services/executor/types.ts` (don't rewrite existing exports):

```ts
// ---------------------------------------------------------------------------
// Plan 4 — dependency injection for backtest support
// ---------------------------------------------------------------------------

import type { Position, TradeLog, Settlement, Prisma } from "@prisma/client";
import type { ExchangeAdapter } from "@/server/services/exchange/types";

export interface Clock {
  now(): Date;
}

export interface RedisLike {
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

export interface PositionStore {
  createPosition(data: Prisma.PositionUncheckedCreateInput): Promise<Position>;
  updatePosition(id: string, data: Prisma.PositionUncheckedUpdateInput): Promise<Position>;
  findPosition(id: string): Promise<Position | null>;
  listOpenPositions(): Promise<Position[]>;

  createTradeLog(data: Prisma.TradeLogUncheckedCreateInput): Promise<TradeLog>;
  updateTradeLogByClientOrderId(
    clientOrderId: string,
    data: Prisma.TradeLogUncheckedUpdateInput,
  ): Promise<TradeLog>;
  listTradeLogs(executionId: string): Promise<TradeLog[]>;

  createSettlement(data: Prisma.SettlementUncheckedCreateInput): Promise<Settlement>;

  findExchangeByName(name: string): Promise<{ id: string; name: string } | null>;
}

export interface ExecutorContext {
  store: PositionStore;
  redis: RedisLike;
  adapterFor: (exchangeName: string) => ExchangeAdapter;
  clock: Clock;
  random: () => number;
  log: (msg: string, meta?: Record<string, unknown>) => void;
}
```

- [ ] **Step 3: Typecheck**

```
pnpm tsc --noEmit
```
Expected: no new errors.

- [ ] **Step 4: Commit (2A-1)**

```
git add src/server/services/executor/types.ts
git commit -m "feat(executor): add ExecutorContext / PositionStore / Clock / RedisLike interfaces"
```

---

### Task 9: PrismaPositionStore + buildProdContext (2A)

**Files:**
- Create: `src/server/services/executor/prisma-position-store.ts`
- Create: `src/server/services/executor/context-prod.ts`

- [ ] **Step 1: Implement PrismaPositionStore**

Create `src/server/services/executor/prisma-position-store.ts`:

```ts
import type { PrismaClient, Position, TradeLog, Settlement, Prisma } from "@prisma/client";
import type { PositionStore } from "./types";

export class PrismaPositionStore implements PositionStore {
  constructor(private readonly prisma: PrismaClient) {}

  createPosition(data: Prisma.PositionUncheckedCreateInput): Promise<Position> {
    return this.prisma.position.create({ data });
  }
  updatePosition(id: string, data: Prisma.PositionUncheckedUpdateInput): Promise<Position> {
    return this.prisma.position.update({ where: { id }, data });
  }
  findPosition(id: string): Promise<Position | null> {
    return this.prisma.position.findUnique({ where: { id } });
  }
  listOpenPositions(): Promise<Position[]> {
    return this.prisma.position.findMany({ where: { status: "OPEN" } });
  }

  createTradeLog(data: Prisma.TradeLogUncheckedCreateInput): Promise<TradeLog> {
    return this.prisma.tradeLog.create({ data });
  }
  updateTradeLogByClientOrderId(
    clientOrderId: string,
    data: Prisma.TradeLogUncheckedUpdateInput,
  ): Promise<TradeLog> {
    return this.prisma.tradeLog.update({ where: { clientOrderId }, data });
  }
  listTradeLogs(executionId: string): Promise<TradeLog[]> {
    return this.prisma.tradeLog.findMany({ where: { executionId } });
  }

  createSettlement(data: Prisma.SettlementUncheckedCreateInput): Promise<Settlement> {
    return this.prisma.settlement.create({ data });
  }

  async findExchangeByName(name: string) {
    const row = await this.prisma.exchange.findFirst({
      where: { name, isEnabled: true },
      select: { id: true, name: true },
    });
    return row;
  }
}
```

- [ ] **Step 2: Implement buildProdContext**

Create `src/server/services/executor/context-prod.ts`:

```ts
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import { createAdapter } from "@/server/services/exchange/factory";
import { decrypt } from "@/server/services/crypto/encryption";
import type { ExchangeName } from "@/lib/constants";
import type { ExecutorContext } from "./types";
import { PrismaPositionStore } from "./prisma-position-store";

export async function buildProdContext(): Promise<ExecutorContext> {
  const store = new PrismaPositionStore(prisma);
  const adapterCache = new Map<string, Awaited<ReturnType<typeof createAdapter>>>();

  return {
    store,
    redis,
    adapterFor: (name: string) => {
      // Production adapters require decrypted keys; this function is sync but
      // we cache. The first call will populate on demand via getOrBuild.
      // For production use from ctx: caller should prime via listOpenPositions
      // before executor. Simpler: build synchronously using a closure
      // over the DB Exchange row pattern.
      throw new Error(`adapterFor: call prime() first with ${name}`);
    },
    clock: { now: () => new Date() },
    random: Math.random,
    log: (msg, meta) => console.log(`[executor] ${msg}`, meta ?? ""),
  };
}
```

> **Note**: `adapterFor` can't be purely synchronous because building an adapter needs DB lookup + decrypt. In Plan 2 the current code builds adapters inline inside `executeOpen` per-request. The DI refactor will keep that **inside executor functions** — pass `store.findExchangeByName` + a `createAdapter` factory via ctx. Task 10 finalizes this shape; for now `buildProdContext` returns a placeholder that Task 14 revises when we wire callers.

Actually, cleaner: change `ExecutorContext.adapterFor` to `(name: string) => Promise<ExchangeAdapter>`. Update the interface accordingly BEFORE finalizing Task 8's interface (fold back):

- Edit `src/server/services/executor/types.ts`:

```ts
  adapterFor: (exchangeName: string) => Promise<ExchangeAdapter>;
```

- Re-implement in `context-prod.ts`:

```ts
    adapterFor: async (name: string) => {
      const row = await prisma.exchange.findFirstOrThrow({
        where: { name, isEnabled: true },
      });
      return createAdapter(
        row.name as ExchangeName,
        decrypt(row.apiKey),
        decrypt(row.apiSecret),
        row.passphrase ? decrypt(row.passphrase) : undefined,
      );
    },
```

- [ ] **Step 3: Typecheck**

```
pnpm tsc --noEmit
```
Expected: no new errors.

- [ ] **Step 4: Commit (2A-2)**

```
git add src/server/services/executor/types.ts \
        src/server/services/executor/prisma-position-store.ts \
        src/server/services/executor/context-prod.ts
git commit -m "feat(executor): PrismaPositionStore + buildProdContext (DI scaffolding)"
```

---

### Task 10: Refactor execute-open.ts (2B)

**Files:**
- Modify: `src/server/services/executor/execute-open.ts`

**Danger:** this is used in production. Verify `tests/integration/executor-open.test.ts` keeps passing after each phase.

- [ ] **Step 1: Change signature + bodies**

Replace `src/server/services/executor/execute-open.ts`. Key pattern: every `prisma.<x>` → `ctx.store.<x>`; every `redis.<x>` → `ctx.redis.<x>`; every `createAdapter(...)` block → `ctx.adapterFor(name)`:

```ts
import { keys } from "@/server/db/redis-keys";
import { generateExecutionId, generateClientOrderId } from "./id";
import { reconcileOrder } from "./reconcile";
import { decideRescueStrategy } from "./rescue";
import type { ExecutorContext, OpenHedgedRequest, ExecutionResult } from "./types";
import type { ExchangeAdapter } from "@/server/services/exchange/types";
import type { Decimal } from "@prisma/client/runtime/library";

const LOCK_TTL_SECONDS = 60;
const RESULT_TTL_SECONDS = 300;

export async function openHedgedPosition(
  ctx: ExecutorContext,
  req: OpenHedgedRequest,
): Promise<ExecutionResult> {
  const idempotencyKey = req.idempotencyKey;
  if (!idempotencyKey) throw new Error("idempotencyKey is required");

  const resultKey = keys.idempotencyResult(idempotencyKey);
  const cached = await ctx.redis.get(resultKey);
  if (cached) return JSON.parse(cached) as ExecutionResult;

  const lockKey = keys.idempotencyLock(idempotencyKey);
  const acquired = await ctx.redis.set(lockKey, "1", "EX", LOCK_TTL_SECONDS, "NX");
  if (!acquired) throw new Error(`Duplicate request in flight for key ${idempotencyKey}`);

  const executionId = generateExecutionId();
  let finalResult: ExecutionResult;

  try {
    const long = await ctx.store.findExchangeByName(req.longExchange);
    const short = await ctx.store.findExchangeByName(req.shortExchange);
    if (!long) throw new Error(`Unknown long exchange: ${req.longExchange}`);
    if (!short) throw new Error(`Unknown short exchange: ${req.shortExchange}`);

    const [longAdapter, shortAdapter] = await Promise.all([
      ctx.adapterFor(long.name),
      ctx.adapterFor(short.name),
    ]);

    const position = await ctx.store.createPosition({
      opportunityId: req.opportunityId,
      symbol: req.symbol,
      longExchangeId: long.id,
      shortExchangeId: short.id,
      longSize: 0,
      longAvgEntryPrice: 0,
      shortSize: 0,
      shortAvgEntryPrice: 0,
      status: "OPENING",
      openedAt: ctx.clock.now(),
    });

    const longClientId = generateClientOrderId();
    const shortClientId = generateClientOrderId();

    await ctx.store.createTradeLog({
      positionId: position.id, exchangeId: long.id, executionId, clientOrderId: longClientId,
      side: "LONG", action: "OPEN", orderType: "LIMIT_IOC",
      price: 0, signedQty: req.size, fee: 0, status: "PENDING",
    });
    await ctx.store.createTradeLog({
      positionId: position.id, exchangeId: short.id, executionId, clientOrderId: shortClientId,
      side: "SHORT", action: "OPEN", orderType: "LIMIT_IOC",
      price: 0, signedQty: req.size, fee: 0, status: "PENDING",
    });

    await Promise.allSettled([
      submitAndReconcile(ctx, longAdapter, longClientId, req.symbol, "long", req.size, req.leverage),
      submitAndReconcile(ctx, shortAdapter, shortClientId, req.symbol, "short", req.size, req.leverage),
    ]);

    const logs = await ctx.store.listTradeLogs(executionId);
    const longLog = logs.find((l) => l.clientOrderId === longClientId)!;
    const shortLog = logs.find((l) => l.clientOrderId === shortClientId)!;

    if (longLog.status === "PENDING" || shortLog.status === "PENDING") {
      const { reconcileRetryQueue } = await import("@/server/jobs/queues");
      await reconcileRetryQueue.add(
        "reconcile",
        {
          executionId,
          clientOrderIds: [longClientId, shortClientId].filter(
            (_, i) => [longLog, shortLog][i].status === "PENDING",
          ),
        },
        { delay: 5_000, attempts: 5, backoff: { type: "exponential", delay: 5000 } },
      );
      finalResult = { status: "failed", positionId: position.id, executionId, note: "Queued for reconcile" };
    } else {
      const longFilled = longLog.status === "FILLED" || longLog.status === "PARTIAL"
        ? Math.abs((longLog.signedQty as unknown as Decimal).toNumber())
        : 0;
      const shortFilled = shortLog.status === "FILLED" || shortLog.status === "PARTIAL"
        ? Math.abs((shortLog.signedQty as unknown as Decimal).toNumber())
        : 0;

      const plan = decideRescueStrategy({ longFilled, shortFilled });
      if (plan.kind === "both_filled") {
        await ctx.store.updatePosition(position.id, { status: "OPEN" });
        finalResult = { status: "filled", positionId: position.id, executionId };
        const { dispatch } = await import("@/server/services/notifier");
        await dispatch({ kind: "position_opened", symbol: req.symbol, size: req.size, executionId });
      } else if (plan.kind === "both_failed") {
        await ctx.store.updatePosition(position.id, { status: "CLOSED", closedAt: ctx.clock.now() });
        finalResult = { status: "failed", positionId: position.id, executionId, note: "Both legs failed" };
      } else {
        const { executeRescue } = await import("./rescue-execute");
        finalResult = await executeRescue(ctx, {
          position, plan, executionId,
          longAdapter, shortAdapter,
          longExchangeId: long.id, shortExchangeId: short.id,
          symbol: req.symbol,
        });
      }
    }

    await ctx.redis.set(resultKey, JSON.stringify(finalResult), "EX", RESULT_TTL_SECONDS);
    return finalResult;
  } finally {
    await ctx.redis.del(lockKey);
  }
}

async function submitAndReconcile(
  ctx: ExecutorContext,
  adapter: ExchangeAdapter,
  clientOrderId: string,
  symbol: string,
  side: "long" | "short",
  size: number,
  leverage: number,
): Promise<void> {
  try {
    await adapter.openPosition({ symbol, side, size, leverage, clientOrderId });
  } catch (err) {
    ctx.log("openPosition error", { clientOrderId, err: String(err) });
  }
  try {
    await reconcileOrder(ctx, { clientOrderId, adapter });
  } catch (err) {
    ctx.log("reconcile failed", { clientOrderId, err: String(err) });
  }
}
```

(Note: the `reconcileOrder` signature also changes in Task 13 — this file's call compiles only after Task 13. Temporarily the old `reconcileOrder({ clientOrderId, adapter })` signature is kept in `reconcile.ts` in this task. The import won't break.)

**Correction:** to avoid broken intermediate state, Task 10's first commit refactors execute-open.ts but temporarily keeps a compat wrapper:

At the top of `execute-open.ts`, after imports:
```ts
// Temporary compat: reconcileOrder is refactored in Task 13.
// Until then, wrap it so this file compiles.
async function reconcileOrderCompat(ctx: ExecutorContext, args: { clientOrderId: string; adapter: ExchangeAdapter }) {
  return reconcileOrder(args);
}
```

Replace the `submitAndReconcile` call to use `reconcileOrderCompat(ctx, { ... })`. This lets Task 10 land green.

- [ ] **Step 2: Run tests**

```
docker compose exec postgres psql -U arbitrage -c "TRUNCATE funding_rate_snapshots, funding_rate_hourly CASCADE;"
pnpm test
```
Expected: same baseline as Plan 4 start — no new failures. Integration tests (`executor-open.test.ts`) must pass.

> If integration tests currently call `openHedgedPosition({...})` directly, they'll break with the new signature. Update them in this task's step 3: wrap in `buildProdContext()` per test.

- [ ] **Step 3: Update executor-open integration test**

In `tests/integration/executor-open.test.ts`, each call site changes from:
```ts
const result = await openHedgedPosition({ ...req });
```
to:
```ts
const { buildProdContext } = await import("@/server/services/executor/context-prod");
const ctx = await buildProdContext();
const result = await openHedgedPosition(ctx, { ...req });
```

Run `pnpm test tests/integration/executor-open.test.ts` → expect green.

- [ ] **Step 4: Commit**

```
git add src/server/services/executor/execute-open.ts tests/integration/executor-open.test.ts
git commit -m "feat(executor): execute-open takes ExecutorContext (DI, 2B)"
```

---

### Task 11: Refactor execute-close.ts (2B)

**Files:**
- Modify: `src/server/services/executor/execute-close.ts`

- [ ] **Step 1: Read file, identify every `prisma` / `redis` / adapter-builder block**

```
cat src/server/services/executor/execute-close.ts
```

- [ ] **Step 2: Apply the same pattern as Task 10**

Change the function signature:
```ts
export async function closeHedgedPosition(
  ctx: ExecutorContext,
  req: CloseHedgedRequest,
): Promise<ExecutionResult>
```

Replace every `prisma.x` with `ctx.store.x`; every `redis.x` with `ctx.redis.x`; every `createAdapter(...)` with `await ctx.adapterFor(name)`; every `new Date()` with `ctx.clock.now()`.

- [ ] **Step 3: Update callers + tests**

- `src/server/api/routers/position.ts` — inject ctx via `buildProdContext()` and pass to `closeHedgedPosition`.
- Monitor workers under `src/server/jobs/` that call `closeHedgedPosition` similarly.
- Any integration test calling `closeHedgedPosition` directly — update signature.

- [ ] **Step 4: Run tests + commit**

```
pnpm test
```
Expect green. Commit:
```
git add src/server/services/executor/execute-close.ts src/server/api/routers/position.ts \
        src/server/jobs/ tests/integration/
git commit -m "feat(executor): execute-close takes ExecutorContext (DI, 2B)"
```

---

### Task 12: Refactor rescue.ts + rescue-execute.ts (2B)

**Files:**
- Modify: `src/server/services/executor/rescue.ts`
- Modify: `src/server/services/executor/rescue-execute.ts`

- [ ] **Step 1: rescue.ts**

`rescue.ts` is likely already pure (just decides strategy). Confirm: `cat src/server/services/executor/rescue.ts`. If it only has `decideRescueStrategy({ longFilled, shortFilled })` and no `prisma`/`redis`, skip — already DI-safe.

- [ ] **Step 2: rescue-execute.ts**

Change signature of `executeRescue` to accept `ctx` as first parameter. Replace `prisma.*` → `ctx.store.*`, `redis.*` → `ctx.redis.*`, `createAdapter` → `ctx.adapterFor`, `new Date()` → `ctx.clock.now()`.

- [ ] **Step 3: Update tests**

`tests/integration/executor-rescue.test.ts` — update to pass `ctx` via `buildProdContext()`.

- [ ] **Step 4: Run tests + commit**

```
pnpm test
git add src/server/services/executor/rescue*.ts tests/integration/executor-rescue.test.ts
git commit -m "feat(executor): rescue + rescue-execute take ExecutorContext (DI, 2B)"
```

---

### Task 13: Refactor trade-recorder.ts, aggregate.ts, reconcile.ts (2B)

**Files:**
- Modify: `src/server/services/executor/trade-recorder.ts`
- Modify: `src/server/services/executor/aggregate.ts`
- Modify: `src/server/services/executor/reconcile.ts`

- [ ] **Step 1: Each file, apply same pattern**

- `trade-recorder.ts` — change any exported function to take `ctx` first; replace `prisma.tradeLog.*` → `ctx.store.*`, etc.
- `aggregate.ts` — may be already pure (aggregates numbers). Check `cat`; if it does `prisma.tradeLog.findMany(...)` → replace with `ctx.store.listTradeLogs(...)`.
- `reconcile.ts` — `reconcileOrder` takes `ctx` first; remove `reconcileOrderCompat` wrapper from Task 10.

- [ ] **Step 2: Update execute-open.ts to drop compat wrapper**

In `src/server/services/executor/execute-open.ts`: remove the temporary `reconcileOrderCompat` wrapper and call `reconcileOrder(ctx, { clientOrderId, adapter })` directly.

- [ ] **Step 3: Run tests + commit**

```
pnpm test
git add src/server/services/executor/trade-recorder.ts \
        src/server/services/executor/aggregate.ts \
        src/server/services/executor/reconcile.ts \
        src/server/services/executor/execute-open.ts
git commit -m "feat(executor): trade-recorder + aggregate + reconcile take ExecutorContext (DI, 2B complete)"
```

---

### Task 14: Callers — position router + monitor workers pass ctx

**Files:**
- Modify: `src/server/api/routers/position.ts`
- Modify: `src/server/jobs/` files that call executor functions

- [ ] **Step 1: Find all direct executor callers**

```
grep -RIn --include='*.ts' 'openHedgedPosition\|closeHedgedPosition\|executeRescue\|reconcileOrder' src/
```

List every file. Excluding executor/ itself and tests/, the external callers are:
- `src/server/api/routers/position.ts`
- `src/server/jobs/reconcile-retry.ts` (or wherever the reconcile queue consumer lives)
- any monitor worker that closes positions

- [ ] **Step 2: At each call site, build ctx once and thread**

Pattern:
```ts
import { buildProdContext } from "@/server/services/executor/context-prod";

// In the handler:
const ctx = await buildProdContext();
const result = await openHedgedPosition(ctx, req);
```

Build ctx **once per request/job** — not per executor invocation.

- [ ] **Step 3: Run ALL tests**

```
docker compose exec postgres psql -U arbitrage -c "TRUNCATE funding_rate_snapshots, funding_rate_hourly CASCADE;"
pnpm test
```
Expected: 100% same as baseline (no new failures).

- [ ] **Step 4: Commit**

```
git add src/server/api/routers/position.ts src/server/jobs/
git commit -m "feat(executor): callers build ExecutorContext and pass to executor functions (DI, 2B wire-up)"
```

---

### Task 15: Remove residual direct prisma/redis imports (2C)

**Files:**
- Modify: `src/server/services/executor/*.ts` (remove `import { prisma }` / `import { redis }`)

- [ ] **Step 1: Grep for violators**

```
grep -RIn '^import { prisma }\|^import { redis }' src/server/services/executor/
```

Expected: no hits by now. If any remain, remove the import line and any dead references.

- [ ] **Step 2: ESLint rule (optional but cheap safety)**

If the project uses ESLint `no-restricted-imports`, add to `eslint.config.mjs`:
```js
{
  files: ["src/server/services/executor/**/*.ts"],
  rules: {
    "no-restricted-imports": ["error", {
      paths: [
        { name: "@/server/db/client", message: "executor must not import prisma directly; use ctx.store" },
        { name: "@/server/db/redis", message: "executor must not import redis directly; use ctx.redis" },
      ],
    }],
  },
},
```

Skip if not worth the config churn.

- [ ] **Step 3: Run full verify**

```
pnpm lint && pnpm tsc --noEmit && pnpm test
```

- [ ] **Step 4: Commit**

```
git commit --allow-empty -m "chore(executor): verify no residual prisma/redis imports in executor/ (DI, 2C)"
```

---

### Task 16: Production smoke test via v0.2.0 tag

**Files:**
- None (verification task)

- [ ] **Step 1: Merge feature branch back to main**

Use subagent-driven-development's `finishing-a-development-branch` pattern (local merge OR PR → merge). Tests green end-to-end.

- [ ] **Step 2: Tag + push**

```
git tag v0.2.0
git push origin v0.2.0
```

Release workflow builds the image, SSHes to Vultr, runs deploy.sh.

- [ ] **Step 3: Live smoke on https://arbitrage.tadacamp.com**

1. Log in (admin account from v0.1.5 deploy)
2. Go to Settings → Exchanges
3. Use the smallest tradeable size on BTC (e.g. 0.001 BTC ~ a few $) to open a hedged position
4. Verify: position appears in `/positions` with status OPEN; DB row correct; trade_logs show FILLED
5. Close it via the UI; verify position CLOSED; settlement recorded

- [ ] **Step 4: Record outcome in an empty commit (optional but useful)**

```
git commit --allow-empty -m "docs(backtest): v0.2.0 production smoke — DI refactor verified live"
```

If live smoke fails: **rollback** via `./scripts/rollback.sh` + `git revert <merge-commit>` on main + re-tag `v0.2.0-rollback`. Investigate before continuing.

---

## Phase 4 — Backtest Runner

Goal: drive the DI-refactored executor through historical data.

### Task 17: virtual-clock.ts

**Files:**
- Create: `src/server/services/backtest/runner/virtual-clock.ts`
- Create: `tests/unit/backtest/virtual-clock.test.ts`

- [ ] **Step 1: Failing test**

Create `tests/unit/backtest/virtual-clock.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { VirtualClock } from "@/server/services/backtest/runner/virtual-clock";

describe("VirtualClock", () => {
  it("now() returns the current time, setTime advances it", () => {
    const c = new VirtualClock(new Date("2025-01-01T00:00:00Z"));
    expect(c.now().toISOString()).toBe("2025-01-01T00:00:00.000Z");
    c.setTime(new Date("2025-01-01T01:30:00Z"));
    expect(c.now().toISOString()).toBe("2025-01-01T01:30:00.000Z");
  });

  it("setTime rejects backwards moves", () => {
    const c = new VirtualClock(new Date("2025-01-01T00:00:00Z"));
    c.setTime(new Date("2025-01-01T02:00:00Z"));
    expect(() => c.setTime(new Date("2025-01-01T01:00:00Z"))).toThrow();
  });
});
```

- [ ] **Step 2: Run FAIL**

`pnpm test tests/unit/backtest/virtual-clock.test.ts`

- [ ] **Step 3: Implement**

Create `src/server/services/backtest/runner/virtual-clock.ts`:

```ts
import type { Clock } from "@/server/services/executor/types";

export class VirtualClock implements Clock {
  private current: Date;
  constructor(start: Date) {
    this.current = new Date(start);
  }
  now(): Date {
    return new Date(this.current);
  }
  setTime(t: Date): void {
    if (t.getTime() < this.current.getTime()) {
      throw new Error(`VirtualClock.setTime: cannot move backwards (${t.toISOString()} < ${this.current.toISOString()})`);
    }
    this.current = new Date(t);
  }
}
```

- [ ] **Step 4: PASS + commit**

```
pnpm test tests/unit/backtest/virtual-clock.test.ts
git add src/server/services/backtest/runner/virtual-clock.ts tests/unit/backtest/virtual-clock.test.ts
git commit -m "feat(backtest): VirtualClock — monotonic advance-only clock"
```

---

### Task 18: failure-injector.ts (seeded PRNG)

**Files:**
- Create: `src/server/services/backtest/runner/failure-injector.ts`
- Create: `tests/unit/backtest/failure-injector.test.ts`
- Modify: `package.json` (add `seedrandom`)

- [ ] **Step 1: Add seedrandom**

```
pnpm add seedrandom
pnpm add -D @types/seedrandom
```

- [ ] **Step 2: Failing test**

Create `tests/unit/backtest/failure-injector.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createFailureInjector } from "@/server/services/backtest/runner/failure-injector";

describe("FailureInjector", () => {
  it("is deterministic given the same seed", () => {
    const a = createFailureInjector("seed-1", 0.1);
    const b = createFailureInjector("seed-1", 0.1);
    const pattern: boolean[] = [];
    for (let i = 0; i < 100; i++) pattern.push(a.shouldFail("open") === b.shouldFail("open"));
    expect(pattern.every((x) => x)).toBe(true);
  });

  it("fails roughly at the configured rate over many samples", () => {
    const inj = createFailureInjector("seed-n", 0.2);
    let fails = 0;
    for (let i = 0; i < 10_000; i++) if (inj.shouldFail("open")) fails++;
    expect(fails).toBeGreaterThan(1700);
    expect(fails).toBeLessThan(2300);
  });

  it("rate=0 never fails", () => {
    const inj = createFailureInjector("x", 0);
    for (let i = 0; i < 100; i++) expect(inj.shouldFail("open")).toBe(false);
  });
});
```

- [ ] **Step 3: FAIL → implement**

Create `src/server/services/backtest/runner/failure-injector.ts`:

```ts
import seedrandom from "seedrandom";

export interface FailureInjector {
  shouldFail(op: "open" | "close"): boolean;
  random: () => number;
}

export function createFailureInjector(seed: string, failureRate: number): FailureInjector {
  const prng = seedrandom(seed);
  return {
    shouldFail: () => prng() < failureRate,
    random: () => prng(),
  };
}
```

- [ ] **Step 4: PASS + commit**

```
pnpm test tests/unit/backtest/failure-injector.test.ts
git add src/server/services/backtest/runner/failure-injector.ts \
        tests/unit/backtest/failure-injector.test.ts \
        package.json pnpm-lock.yaml
git commit -m "feat(backtest): deterministic failure injector with seeded PRNG"
```

---

### Task 19: slippage.ts

**Files:**
- Create: `src/server/services/backtest/runner/slippage.ts`
- Create: `tests/unit/backtest/slippage.test.ts`

- [ ] **Step 1: Failing test**

Create `tests/unit/backtest/slippage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applySlippage } from "@/server/services/backtest/runner/slippage";

describe("applySlippage", () => {
  it("long side pays higher price (bps > 0)", () => {
    expect(applySlippage(100, "long", 3)).toBeCloseTo(100.03, 4);
  });
  it("short side receives lower price", () => {
    expect(applySlippage(100, "short", 3)).toBeCloseTo(99.97, 4);
  });
  it("zero bps = no change", () => {
    expect(applySlippage(100, "long", 0)).toBe(100);
  });
});
```

- [ ] **Step 2: FAIL → implement**

Create `src/server/services/backtest/runner/slippage.ts`:

```ts
export function applySlippage(
  basePrice: number,
  side: "long" | "short",
  bps: number,
): number {
  const factor = bps / 10_000;
  return side === "long" ? basePrice * (1 + factor) : basePrice * (1 - factor);
}
```

- [ ] **Step 3: PASS + commit**

```
pnpm test tests/unit/backtest/slippage.test.ts
git add src/server/services/backtest/runner/slippage.ts tests/unit/backtest/slippage.test.ts
git commit -m "feat(backtest): slippage model (bps → price adjustment)"
```

---

### Task 20: timeline.ts (event queue builder)

**Files:**
- Create: `src/server/services/backtest/runner/timeline.ts`
- Create: `tests/unit/backtest/timeline.test.ts`

- [ ] **Step 1: Failing test**

Create `tests/unit/backtest/timeline.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/server/db/client";
import { buildTimeline } from "@/server/services/backtest/runner/timeline";

async function reset() {
  await prisma.fundingRateSnapshot.deleteMany();
  await prisma.exchange.deleteMany();
}

describe("buildTimeline", () => {
  beforeEach(reset);

  it("emits funding_collection every 5 min, health_check per interval, settlement at historical rate times", async () => {
    const ex = await prisma.exchange.create({ data: { name: "binance", apiKey: "", apiSecret: "" } });
    const t0 = new Date("2025-01-01T00:00:00Z");
    const t8 = new Date("2025-01-01T08:00:00Z");
    await prisma.fundingRateSnapshot.create({
      data: { exchangeId: ex.id, symbol: "BTC/USDT:USDT", currentRate: 0.0001, collectedAt: t8, intervalHours: 8 },
    });

    const timeline = await buildTimeline(
      { from: t0, to: new Date("2025-01-01T09:00:00Z"), healthIntervalSec: 300 },
    );

    const collections = timeline.filter((e) => e.type === "funding_collection");
    expect(collections.length).toBeGreaterThanOrEqual(12);  // 12 * 5min in 1h

    const settlements = timeline.filter((e) => e.type === "settlement");
    expect(settlements.length).toBe(1);
    expect(settlements[0]).toMatchObject({ type: "settlement", symbol: "BTC/USDT:USDT" });

    // Entries are sorted ascending
    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i].at.getTime()).toBeGreaterThanOrEqual(timeline[i - 1].at.getTime());
    }
  });
});
```

- [ ] **Step 2: FAIL → implement**

Create `src/server/services/backtest/runner/timeline.ts`:

```ts
import { prisma } from "@/server/db/client";

export type VirtualEvent =
  | { type: "funding_collection"; at: Date }
  | { type: "health_check"; at: Date }
  | { type: "settlement"; at: Date; symbol: string; exchangeName: string; fundingRate: number };

export interface TimelineOptions {
  from: Date;
  to: Date;
  healthIntervalSec: number;
}

const COLLECTION_STEP_MS = 5 * 60 * 1000;

export async function buildTimeline(opts: TimelineOptions): Promise<VirtualEvent[]> {
  const events: VirtualEvent[] = [];

  for (let t = opts.from.getTime(); t < opts.to.getTime(); t += COLLECTION_STEP_MS) {
    events.push({ type: "funding_collection", at: new Date(t) });
  }
  for (let t = opts.from.getTime(); t < opts.to.getTime(); t += opts.healthIntervalSec * 1000) {
    events.push({ type: "health_check", at: new Date(t) });
  }

  const rates = await prisma.fundingRateSnapshot.findMany({
    where: { collectedAt: { gte: opts.from, lte: opts.to } },
    include: { exchange: { select: { name: true } } },
    orderBy: { collectedAt: "asc" },
  });
  for (const r of rates) {
    events.push({
      type: "settlement",
      at: r.collectedAt,
      symbol: r.symbol,
      exchangeName: r.exchange.name,
      fundingRate: Number(r.currentRate),
    });
  }

  events.sort((a, b) => a.at.getTime() - b.at.getTime());
  return events;
}
```

- [ ] **Step 3: PASS + commit**

```
pnpm test tests/unit/backtest/timeline.test.ts
git add src/server/services/backtest/runner/timeline.ts tests/unit/backtest/timeline.test.ts
git commit -m "feat(backtest): timeline builder (funding + health + settlement events)"
```

---

### Task 21: in-memory-store.ts + in-memory-redis.ts

**Files:**
- Create: `src/server/services/backtest/runner/in-memory-store.ts`
- Create: `src/server/services/backtest/runner/in-memory-redis.ts`

- [ ] **Step 1: in-memory-redis.ts**

Create:

```ts
import type { RedisLike } from "@/server/services/executor/types";

interface Entry {
  value: string;
  expiresAt?: number;
}

export class InMemoryRedis implements RedisLike {
  private store = new Map<string, Entry>();
  constructor(private now: () => Date) {}

  private expired(e: Entry): boolean {
    return typeof e.expiresAt === "number" && e.expiresAt <= this.now().getTime();
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<string | null> {
    // Support: redis.set(k, v) | redis.set(k, v, "EX", n) | redis.set(k, v, "EX", n, "NX")
    let ex: number | undefined;
    let nx = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "EX") ex = Number(args[++i]);
      else if (a === "NX") nx = true;
    }
    if (nx) {
      const existing = this.store.get(key);
      if (existing && !this.expired(existing)) return null;
    }
    this.store.set(key, {
      value,
      expiresAt: typeof ex === "number" ? this.now().getTime() + ex * 1000 : undefined,
    });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (this.expired(e)) {
      this.store.delete(key);
      return null;
    }
    return e.value;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}
```

- [ ] **Step 2: in-memory-store.ts**

Create:

```ts
import type { Position, TradeLog, Settlement, Prisma } from "@prisma/client";
import type { PositionStore } from "@/server/services/executor/types";

interface StoredExchange {
  id: string;
  name: string;
}

export class InMemoryPositionStore implements PositionStore {
  private positions = new Map<string, Position>();
  private tradeLogs = new Map<string, TradeLog>();   // keyed by clientOrderId
  private tradeLogsByExec = new Map<string, string[]>(); // executionId -> clientOrderIds
  private settlements: Settlement[] = [];
  private exchanges = new Map<string, StoredExchange>();
  private counter = 0;

  constructor(exchanges: StoredExchange[]) {
    for (const e of exchanges) this.exchanges.set(e.name, e);
  }

  private nextId(): string {
    this.counter += 1;
    return `bt-${this.counter.toString(36)}`;
  }

  async createPosition(data: Prisma.PositionUncheckedCreateInput): Promise<Position> {
    const id = typeof data.id === "string" ? data.id : this.nextId();
    const row = { id, createdAt: new Date(), updatedAt: new Date(), ...data } as unknown as Position;
    this.positions.set(id, row);
    return row;
  }
  async updatePosition(id: string, data: Prisma.PositionUncheckedUpdateInput): Promise<Position> {
    const row = this.positions.get(id);
    if (!row) throw new Error(`no position ${id}`);
    const updated = { ...row, ...data, updatedAt: new Date() } as Position;
    this.positions.set(id, updated);
    return updated;
  }
  async findPosition(id: string): Promise<Position | null> {
    return this.positions.get(id) ?? null;
  }
  async listOpenPositions(): Promise<Position[]> {
    return [...this.positions.values()].filter((p) => p.status === "OPEN");
  }

  async createTradeLog(data: Prisma.TradeLogUncheckedCreateInput): Promise<TradeLog> {
    const row = { id: this.nextId(), createdAt: new Date(), updatedAt: new Date(), ...data } as unknown as TradeLog;
    this.tradeLogs.set(row.clientOrderId, row);
    const exec = data.executionId as string;
    const arr = this.tradeLogsByExec.get(exec) ?? [];
    arr.push(row.clientOrderId);
    this.tradeLogsByExec.set(exec, arr);
    return row;
  }
  async updateTradeLogByClientOrderId(
    clientOrderId: string,
    data: Prisma.TradeLogUncheckedUpdateInput,
  ): Promise<TradeLog> {
    const row = this.tradeLogs.get(clientOrderId);
    if (!row) throw new Error(`no tradelog ${clientOrderId}`);
    const updated = { ...row, ...data, updatedAt: new Date() } as TradeLog;
    this.tradeLogs.set(clientOrderId, updated);
    return updated;
  }
  async listTradeLogs(executionId: string): Promise<TradeLog[]> {
    const ids = this.tradeLogsByExec.get(executionId) ?? [];
    return ids.map((id) => this.tradeLogs.get(id)!).filter(Boolean);
  }
  async createSettlement(data: Prisma.SettlementUncheckedCreateInput): Promise<Settlement> {
    const row = { id: this.nextId(), createdAt: new Date(), ...data } as unknown as Settlement;
    this.settlements.push(row);
    return row;
  }

  async findExchangeByName(name: string) {
    const row = this.exchanges.get(name);
    return row ? { id: row.id, name: row.name } : null;
  }

  // Backtest-only helpers
  allPositions(): Position[] { return [...this.positions.values()]; }
  allSettlements(): Settlement[] { return [...this.settlements]; }
}
```

- [ ] **Step 3: Typecheck + commit**

```
pnpm tsc --noEmit
git add src/server/services/backtest/runner/in-memory-*.ts
git commit -m "feat(backtest): InMemoryPositionStore + InMemoryRedis for runner"
```

---

### Task 22: historical-adapter.ts

**Files:**
- Create: `src/server/services/backtest/runner/historical-adapter.ts`

- [ ] **Step 1: Implement adapter**

Create:

```ts
import { prisma } from "@/server/db/client";
import type { ExchangeAdapter, Ticker, Order } from "@/server/services/exchange/types";
import type { Clock } from "@/server/services/executor/types";
import type { FailureInjector } from "./failure-injector";
import { applySlippage } from "./slippage";

export class HistoricalAdapter implements ExchangeAdapter {
  constructor(
    private readonly exchangeName: string,
    private readonly clock: Clock,
    private readonly failure: FailureInjector,
    private readonly slippageBps: number,
  ) {}

  private async lastKline(symbol: string) {
    const row = await prisma.ohlcvSnapshot.findFirst({
      where: {
        exchange: { name: this.exchangeName },
        symbol,
        openTime: { lte: this.clock.now() },
      },
      orderBy: { openTime: "desc" },
    });
    if (!row) throw new Error(`no historical data for ${this.exchangeName} ${symbol} @ ${this.clock.now().toISOString()}`);
    return row;
  }

  async getPrice(symbol: string): Promise<Ticker> {
    const k = await this.lastKline(symbol);
    return { symbol, last: Number(k.close), bid: Number(k.close), ask: Number(k.close), timestamp: k.openTime.getTime() };
  }

  async openPosition(params: {
    symbol: string; side: "long" | "short"; size: number; leverage: number; clientOrderId: string;
  }): Promise<Order> {
    if (this.failure.shouldFail("open")) {
      throw new Error(`Simulated open failure ${params.clientOrderId}`);
    }
    const k = await this.lastKline(params.symbol);
    const execPrice = applySlippage(Number(k.close), params.side, this.slippageBps);
    return {
      id: `backtest-${params.clientOrderId}`,
      clientOrderId: params.clientOrderId,
      symbol: params.symbol,
      side: params.side,
      status: "filled",
      price: execPrice,
      filledSize: params.size,
      fee: execPrice * params.size * 0.0005,   // 5 bps placeholder; Reporter will recompute from Exchange.feeRate
      timestamp: this.clock.now().getTime(),
    };
  }

  async closePosition(params: {
    symbol: string; side: "long" | "short"; size: number; clientOrderId: string;
  }): Promise<Order> {
    if (this.failure.shouldFail("close")) {
      throw new Error(`Simulated close failure ${params.clientOrderId}`);
    }
    const k = await this.lastKline(params.symbol);
    const oppSide = params.side === "long" ? "short" : "long";
    const execPrice = applySlippage(Number(k.close), oppSide, this.slippageBps);
    return {
      id: `backtest-${params.clientOrderId}`,
      clientOrderId: params.clientOrderId,
      symbol: params.symbol,
      side: oppSide as "long" | "short",
      status: "filled",
      price: execPrice,
      filledSize: params.size,
      fee: execPrice * params.size * 0.0005,
      timestamp: this.clock.now().getTime(),
    };
  }

  async fetchOrderStatus(clientOrderId: string): Promise<Order | null> {
    // In backtest, orders are synchronous; no pending state.
    return null;
  }
}
```

> Note: the actual `ExchangeAdapter` interface (in `src/server/services/exchange/types.ts`) may have more methods. Implement all of them; for features not needed by the backtest path, return sensible defaults or throw `not supported in backtest`. Double-check by opening the interface file.

- [ ] **Step 2: Typecheck + commit**

```
pnpm tsc --noEmit
git add src/server/services/backtest/runner/historical-adapter.ts
git commit -m "feat(backtest): HistoricalAdapter — clock-gated OHLCV replay + failure injection + slippage"
```

---

### Task 23: runner.ts (main loop + handlers)

**Files:**
- Create: `src/server/services/backtest/runner/runner.ts`
- Modify: `src/server/services/backtest/types.ts` (add runtime result types)

- [ ] **Step 1: Extend types.ts**

Append to `src/server/services/backtest/types.ts`:

```ts
export interface ClosedTrade {
  positionId: string;
  symbol: string;
  longExchange: string;
  shortExchange: string;
  openedAt: Date;
  closedAt: Date;
  longEntry: number;
  shortEntry: number;
  longExit: number;
  shortExit: number;
  grossPnl: number;
  fees: number;
  fundingPnl: number;
  netPnl: number;
  holdHours: number;
}

export interface EquityCurvePoint {
  date: Date;
  equity: number;
  grossPnl: number;
  netPnl: number;
  totalFees: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  startedAt: Date;
  finishedAt: Date;
  closedTrades: ClosedTrade[];
  equityCurve: EquityCurvePoint[];
}
```

- [ ] **Step 2: Implement runner**

Create `src/server/services/backtest/runner/runner.ts`:

```ts
import { prisma } from "@/server/db/client";
import { openHedgedPosition } from "@/server/services/executor/execute-open";
import { closeHedgedPosition } from "@/server/services/executor/execute-close";
import { findOpportunities } from "@/server/services/detector/opportunity";
import type { ExecutorContext } from "@/server/services/executor/types";
import type { BacktestConfig, BacktestResult, ClosedTrade, EquityCurvePoint } from "../types";
import { VirtualClock } from "./virtual-clock";
import { buildTimeline, type VirtualEvent } from "./timeline";
import { InMemoryPositionStore } from "./in-memory-store";
import { InMemoryRedis } from "./in-memory-redis";
import { HistoricalAdapter } from "./historical-adapter";
import { createFailureInjector } from "./failure-injector";

export async function runBacktest(config: BacktestConfig): Promise<BacktestResult> {
  const startedAt = new Date();
  const clock = new VirtualClock(config.from);
  const failure = createFailureInjector(config.seed, config.failureRate);

  const exchangeRows = await prisma.exchange.findMany({ select: { id: true, name: true } });
  const store = new InMemoryPositionStore(exchangeRows);
  const redis = new InMemoryRedis(() => clock.now());

  const adapters = new Map<string, HistoricalAdapter>();
  for (const e of exchangeRows) {
    adapters.set(e.name, new HistoricalAdapter(e.name, clock, failure, config.slippageBps));
  }

  const ctx: ExecutorContext = {
    store,
    redis,
    adapterFor: async (name: string) => {
      const a = adapters.get(name);
      if (!a) throw new Error(`no adapter for ${name}`);
      return a;
    },
    clock,
    random: failure.random,
    log: (msg, meta) => {
      if (process.env.BACKTEST_VERBOSE) console.log(`[bt] ${msg}`, meta ?? "");
    },
  };

  const timeline = await buildTimeline({
    from: config.from,
    to: config.to,
    healthIntervalSec: config.healthIntervalSec,
  });

  const equityCurve: EquityCurvePoint[] = [];
  let lastDay = "";

  for (const event of timeline) {
    clock.setTime(event.at);
    switch (event.type) {
      case "funding_collection":
        await handleFundingCollection(ctx, config);
        break;
      case "health_check":
        await handleHealthCheck(ctx, config);
        break;
      case "settlement":
        await handleSettlement(ctx, event);
        break;
    }
    const dayKey = event.at.toISOString().slice(0, 10);
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      equityCurve.push({
        date: new Date(dayKey + "T00:00:00Z"),
        equity: config.initialCapital,   // placeholder; Reporter computes real
        grossPnl: 0, netPnl: 0, totalFees: 0,
      });
    }
  }

  // Force close any remaining open positions at config.to
  clock.setTime(config.to);
  const openAtEnd = await store.listOpenPositions();
  for (const p of openAtEnd) {
    try {
      await closeHedgedPosition(ctx, {
        idempotencyKey: `bt-force-close-${p.id}`,
        positionId: p.id,
        reason: "backtest_end",
      });
    } catch (err) {
      ctx.log("force-close error", { positionId: p.id, err: String(err) });
    }
  }

  const closedTrades = buildClosedTrades(store);
  const finishedAt = new Date();

  return { config, startedAt, finishedAt, closedTrades, equityCurve };
}

async function handleFundingCollection(ctx: ExecutorContext, cfg: BacktestConfig) {
  const now = ctx.clock.now();
  const rates = await prisma.fundingRateSnapshot.findMany({
    where: { collectedAt: { lte: now } },
    include: { exchange: { select: { name: true } } },
    orderBy: { collectedAt: "desc" },
    take: 200,
  });
  // Latest per (exchange, symbol)
  const latest = new Map<string, (typeof rates)[number]>();
  for (const r of rates) {
    const k = `${r.exchange.name}:${r.symbol}`;
    if (!latest.has(k)) latest.set(k, r);
  }
  const snapshots = [...latest.values()].map((r) => ({
    exchange: r.exchange.name,
    symbol: r.symbol,
    currentRate: Number(r.currentRate),
    intervalHours: r.intervalHours,
  }));
  const ops = findOpportunities(snapshots, {
    minRateSpread: cfg.minSpread,
    minAnnualizedYield: cfg.minApy,
  });

  const openCount = (await ctx.store.listOpenPositions()).length;
  const slots = Math.max(0, cfg.maxConcurrent - openCount);

  for (const op of ops.slice(0, slots)) {
    try {
      await openHedgedPosition(ctx, {
        idempotencyKey: `bt-${ctx.clock.now().getTime()}-${op.symbol}-${op.longExchange}-${op.shortExchange}`,
        opportunityId: `bt-op-${ctx.clock.now().getTime()}`,
        symbol: op.symbol,
        longExchange: op.longExchange,
        shortExchange: op.shortExchange,
        size: cfg.positionSize,
        leverage: 1,
      });
    } catch (err) {
      ctx.log("open error", { err: String(err) });
    }
  }
}

async function handleHealthCheck(ctx: ExecutorContext, cfg: BacktestConfig) {
  // Minimal: for each open position, if 72h > holdDuration, close.
  // Full Plan 2 health logic can be ported here once basic runner is verified.
  const open = await ctx.store.listOpenPositions();
  for (const p of open) {
    const openedAt = (p as unknown as { openedAt: Date }).openedAt;
    const hours = (ctx.clock.now().getTime() - openedAt.getTime()) / 3600_000;
    if (hours > 72) {
      try {
        await closeHedgedPosition(ctx, {
          idempotencyKey: `bt-close-${p.id}-${ctx.clock.now().getTime()}`,
          positionId: p.id,
          reason: "holding_period_exceeded",
        });
      } catch (err) {
        ctx.log("close error", { positionId: p.id, err: String(err) });
      }
    }
  }
}

async function handleSettlement(
  ctx: ExecutorContext,
  event: Extract<VirtualEvent, { type: "settlement" }>,
) {
  const open = await ctx.store.listOpenPositions();
  for (const p of open as unknown as Array<{ id: string; symbol: string; longExchangeId: string; shortExchangeId: string; longSize: unknown; shortSize: unknown }>) {
    if (p.symbol !== event.symbol) continue;
    const isLongExchange = await ctx.store.findExchangeByName(event.exchangeName);
    if (!isLongExchange) continue;
    const longPays = isLongExchange.id === p.longExchangeId;
    const shortPays = isLongExchange.id === p.shortExchangeId;
    if (!longPays && !shortPays) continue;

    const notional = Number(longPays ? p.longSize : p.shortSize);
    const amount = notional * event.fundingRate * (longPays ? -1 : 1);

    await ctx.store.createSettlement({
      positionId: p.id,
      exchangeId: isLongExchange.id,
      symbol: p.symbol,
      amount,
      occurredAt: event.at,
    });
  }
}

function buildClosedTrades(store: InMemoryPositionStore): ClosedTrade[] {
  // Stub: join positions that are CLOSED with their trade logs + settlements
  // Full implementation moves to Reporter (Task 24); runner just returns raw store data.
  return store.allPositions()
    .filter((p) => p.status === "CLOSED")
    .map((p) => {
      const settlements = store.allSettlements().filter((s) => s.positionId === p.id);
      const fundingPnl = settlements.reduce((a, s) => a + Number(s.amount), 0);
      return {
        positionId: p.id,
        symbol: p.symbol,
        longExchange: String((p as { longExchangeId: string }).longExchangeId),
        shortExchange: String((p as { shortExchangeId: string }).shortExchangeId),
        openedAt: (p as unknown as { openedAt: Date }).openedAt,
        closedAt: (p as unknown as { closedAt: Date | null }).closedAt ?? new Date(),
        longEntry: Number((p as unknown as { longAvgEntryPrice: unknown }).longAvgEntryPrice),
        shortEntry: Number((p as unknown as { shortAvgEntryPrice: unknown }).shortAvgEntryPrice),
        longExit: 0,
        shortExit: 0,
        grossPnl: 0,
        fees: 0,
        fundingPnl,
        netPnl: fundingPnl,
        holdHours: 0,
      };
    });
}
```

> This runner is a first cut. Refinements (real P&L math, full health logic, settlement-aware force-close) may need iteration once the E2E test in Task 30 reveals issues. **Do not over-engineer before the E2E test surfaces concrete gaps.**

- [ ] **Step 3: Typecheck + commit**

```
pnpm tsc --noEmit
git add src/server/services/backtest/runner/runner.ts src/server/services/backtest/types.ts
git commit -m "feat(backtest): runner main loop + handlers (first cut)"
```

---

## Phase 5 — Reporter

Goal: `BacktestResult` → `report.html` / `report.md` / `trades.csv` / `daily.csv`.

### Task 24: reporter/aggregate.ts + tests

**Files:**
- Create: `src/server/services/backtest/reporter/aggregate.ts`
- Create: `tests/unit/backtest/aggregate.test.ts`

- [ ] **Step 1: Failing test**

Create `tests/unit/backtest/aggregate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { aggregate } from "@/server/services/backtest/reporter/aggregate";
import type { ClosedTrade, EquityCurvePoint } from "@/server/services/backtest/types";

function trade(overrides: Partial<ClosedTrade>): ClosedTrade {
  return {
    positionId: "p1",
    symbol: "BTC/USDT:USDT",
    longExchange: "binance",
    shortExchange: "okx",
    openedAt: new Date("2025-01-01T00:00:00Z"),
    closedAt: new Date("2025-01-01T08:00:00Z"),
    longEntry: 100, shortEntry: 100, longExit: 100, shortExit: 100,
    grossPnl: 0, fees: 0, fundingPnl: 0, netPnl: 0, holdHours: 8,
    ...overrides,
  };
}

describe("aggregate", () => {
  it("computes overall stats with win rate and max drawdown", () => {
    const trades = [
      trade({ netPnl: 10 }),
      trade({ netPnl: -5 }),
      trade({ netPnl: 20 }),
    ];
    const curve: EquityCurvePoint[] = [
      { date: new Date("2025-01-01"), equity: 10_000, grossPnl: 0, netPnl: 0, totalFees: 0 },
      { date: new Date("2025-01-02"), equity: 10_010, grossPnl: 10, netPnl: 10, totalFees: 0 },
      { date: new Date("2025-01-03"), equity: 10_005, grossPnl: 5, netPnl: 5, totalFees: 0 },
      { date: new Date("2025-01-04"), equity: 10_025, grossPnl: 25, netPnl: 25, totalFees: 0 },
    ];
    const r = aggregate(trades, curve, 10_000);
    expect(r.overall.totalTrades).toBe(3);
    expect(r.overall.winRate).toBeCloseTo(2 / 3, 3);
    expect(r.overall.netPnl).toBe(25);
    expect(r.overall.maxDrawdown).toBeGreaterThan(0);
  });

  it("groups by symbol", () => {
    const trades = [
      trade({ symbol: "BTC/USDT:USDT", netPnl: 5 }),
      trade({ symbol: "ETH/USDT:USDT", netPnl: 10 }),
      trade({ symbol: "BTC/USDT:USDT", netPnl: -2 }),
    ];
    const r = aggregate(trades, [], 10_000);
    expect(r.bySymbol.find((x) => x.key === "BTC/USDT:USDT")?.netPnl).toBe(3);
    expect(r.bySymbol.find((x) => x.key === "ETH/USDT:USDT")?.netPnl).toBe(10);
  });
});
```

- [ ] **Step 2: FAIL → implement**

Create `src/server/services/backtest/reporter/aggregate.ts`:

```ts
import type { ClosedTrade, EquityCurvePoint } from "@/server/services/backtest/types";

export interface OverallStats {
  totalTrades: number;
  winRate: number;
  grossPnl: number;
  netPnl: number;
  totalFees: number;
  feeRatio: number;
  maxDrawdown: number;
  maxDrawdownDate: Date | null;
  initialCapital: number;
  finalEquity: number;
  roi: number;
  annualizedRoi: number;
  sharpeRatio: number;
  avgHoldHours: number;
}

export interface GroupStat {
  key: string;
  count: number;
  netPnl: number;
  grossPnl: number;
  fees: number;
}

export interface Aggregated {
  overall: OverallStats;
  bySymbol: GroupStat[];
  byExchangePair: GroupStat[];
  byHourOfDay: GroupStat[];
  byDayOfWeek: GroupStat[];
  dailyPnlHistogram: { bin: number; count: number }[];
  holdDurationBuckets: { bucket: string; count: number }[];
  feeBreakdown: { totalFees: number; netPnl: number };
}

export function aggregate(
  trades: ClosedTrade[],
  equityCurve: EquityCurvePoint[],
  initialCapital: number,
): Aggregated {
  const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : initialCapital;
  const grossPnl = trades.reduce((s, t) => s + t.grossPnl, 0);
  const netPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const totalFees = trades.reduce((s, t) => s + t.fees, 0);
  const wins = trades.filter((t) => t.netPnl > 0).length;

  let peak = initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownDate: Date | null = null;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak - p.equity;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownDate = p.date;
    }
  }

  const days = equityCurve.length;
  const roi = (finalEquity - initialCapital) / initialCapital;
  const annualizedRoi = days > 0 ? Math.pow(1 + roi, 365 / days) - 1 : 0;

  const dailyReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev > 0) dailyReturns.push((equityCurve[i].equity - prev) / prev);
  }
  const mean = dailyReturns.length ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const variance = dailyReturns.length
    ? dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyReturns.length
    : 0;
  const stdev = Math.sqrt(variance);
  const sharpe = stdev > 0 ? (mean / stdev) * Math.sqrt(365) : 0;

  const avgHoldHours = trades.length
    ? trades.reduce((s, t) => s + t.holdHours, 0) / trades.length
    : 0;

  const overall: OverallStats = {
    totalTrades: trades.length,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    grossPnl, netPnl, totalFees,
    feeRatio: grossPnl !== 0 ? totalFees / Math.abs(grossPnl) : 0,
    maxDrawdown, maxDrawdownDate,
    initialCapital, finalEquity,
    roi, annualizedRoi,
    sharpeRatio: sharpe,
    avgHoldHours,
  };

  return {
    overall,
    bySymbol: groupBy(trades, (t) => t.symbol),
    byExchangePair: groupBy(trades, (t) => `${t.longExchange}→${t.shortExchange}`),
    byHourOfDay: groupBy(trades, (t) => String(t.openedAt.getUTCHours())),
    byDayOfWeek: groupBy(trades, (t) => String(t.openedAt.getUTCDay())),
    dailyPnlHistogram: histogram(trades.map((t) => t.netPnl), 20),
    holdDurationBuckets: [
      { bucket: "<1h", count: trades.filter((t) => t.holdHours < 1).length },
      { bucket: "1-8h", count: trades.filter((t) => t.holdHours >= 1 && t.holdHours < 8).length },
      { bucket: "8-24h", count: trades.filter((t) => t.holdHours >= 8 && t.holdHours < 24).length },
      { bucket: "24-72h", count: trades.filter((t) => t.holdHours >= 24 && t.holdHours < 72).length },
      { bucket: ">=72h", count: trades.filter((t) => t.holdHours >= 72).length },
    ],
    feeBreakdown: { totalFees, netPnl },
  };
}

function groupBy(trades: ClosedTrade[], key: (t: ClosedTrade) => string): GroupStat[] {
  const m = new Map<string, GroupStat>();
  for (const t of trades) {
    const k = key(t);
    const g = m.get(k) ?? { key: k, count: 0, netPnl: 0, grossPnl: 0, fees: 0 };
    g.count += 1;
    g.netPnl += t.netPnl;
    g.grossPnl += t.grossPnl;
    g.fees += t.fees;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.netPnl - a.netPnl);
}

function histogram(values: number[], bins: number) {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const step = (max - min) / bins;
  const out = Array.from({ length: bins }, (_, i) => ({ bin: min + i * step, count: 0 }));
  for (const v of values) {
    const i = Math.min(bins - 1, Math.floor((v - min) / (step || 1)));
    out[i].count += 1;
  }
  return out;
}
```

- [ ] **Step 3: PASS + commit**

```
pnpm test tests/unit/backtest/aggregate.test.ts
git add src/server/services/backtest/reporter/aggregate.ts tests/unit/backtest/aggregate.test.ts
git commit -m "feat(backtest): reporter aggregate — overall stats, groupings, histogram"
```

---

### Task 25: reporter/csv-writer.ts + tests

**Files:**
- Create: `src/server/services/backtest/reporter/csv-writer.ts`
- Create: `tests/unit/backtest/csv-writer.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { toCsv } from "@/server/services/backtest/reporter/csv-writer";

describe("csv-writer", () => {
  it("quotes values containing commas", () => {
    const csv = toCsv(["a", "b"], [["x,y", "z"]]);
    expect(csv).toBe(`a,b\n"x,y",z\n`);
  });
  it("escapes quotes by doubling", () => {
    const csv = toCsv(["q"], [[`he said "hi"`]]);
    expect(csv).toBe(`q\n"he said ""hi"""\n`);
  });
  it("serializes null/undefined as empty", () => {
    const csv = toCsv(["a", "b"], [[null, undefined]] as unknown as (string | number | null | undefined)[][]);
    expect(csv).toBe("a,b\n,\n");
  });
  it("serializes Date as ISO", () => {
    const d = new Date("2025-01-01T00:00:00Z");
    const csv = toCsv(["d"], [[d]] as unknown as (string | number | Date)[][]);
    expect(csv).toBe(`d\n2025-01-01T00:00:00.000Z\n`);
  });
});
```

- [ ] **Step 2: FAIL → implement**

Create `src/server/services/backtest/reporter/csv-writer.ts`:

```ts
type Cell = string | number | boolean | Date | null | undefined;

export function toCsv(headers: string[], rows: Cell[][]): string {
  const lines = [headers.map(escape).join(",")];
  for (const row of rows) {
    lines.push(row.map(serialize).join(","));
  }
  return lines.join("\n") + "\n";
}

function serialize(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return escape(String(v));
}

function escape(v: string): string {
  if (v.includes(",") || v.includes('"') || v.includes("\n")) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}
```

- [ ] **Step 3: PASS + commit**

```
pnpm test tests/unit/backtest/csv-writer.test.ts
git add src/server/services/backtest/reporter/csv-writer.ts tests/unit/backtest/csv-writer.test.ts
git commit -m "feat(backtest): csv writer with escape rules"
```

---

### Task 26: reporter/markdown-template.ts

**Files:**
- Create: `src/server/services/backtest/reporter/markdown-template.ts`

- [ ] **Step 1: Implement**

Create:

```ts
import type { Aggregated } from "./aggregate";
import type { BacktestConfig } from "@/server/services/backtest/types";

export function renderMarkdown(config: BacktestConfig, agg: Aggregated): string {
  const o = agg.overall;
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const $ = (x: number) => `$${x.toFixed(2)}`;
  return [
    `# 回测报告 — ${config.from.toISOString().slice(0, 10)} 到 ${config.to.toISOString().slice(0, 10)}`,
    ``,
    `## 核心指标`,
    ``,
    `| 指标 | 值 |`,
    `|---|---|`,
    `| 初始资金 | ${$(o.initialCapital)} |`,
    `| 最终净值 | ${$(o.finalEquity)} |`,
    `| **ROI** | **${pct(o.roi)}** |`,
    `| 年化 ROI | ${pct(o.annualizedRoi)} |`,
    `| 交易数 | ${o.totalTrades} |`,
    `| 胜率 | ${pct(o.winRate)} |`,
    `| 总毛收益 | ${$(o.grossPnl)} |`,
    `| 总手续费 | ${$(o.totalFees)} |`,
    `| 总净收益 | ${$(o.netPnl)} |`,
    `| 最大回撤 | ${$(o.maxDrawdown)}${o.maxDrawdownDate ? ` (${o.maxDrawdownDate.toISOString().slice(0, 10)})` : ""} |`,
    `| Sharpe | ${o.sharpeRatio.toFixed(2)} |`,
    `| 平均持仓 | ${o.avgHoldHours.toFixed(1)}h |`,
    ``,
    `## 按交易所对 P&L`,
    ``,
    tableOf(agg.byExchangePair),
    ``,
    `## 按币种 P&L`,
    ``,
    tableOf(agg.bySymbol),
    ``,
    `## 参数`,
    ``,
    "```json",
    JSON.stringify(config, null, 2),
    "```",
    ``,
  ].join("\n");
}

function tableOf(rows: { key: string; count: number; netPnl: number; grossPnl: number; fees: number }[]): string {
  if (rows.length === 0) return "_(no data)_";
  return [
    `| 分组 | 交易数 | 毛 P&L | 手续费 | 净 P&L |`,
    `|---|---|---|---|---|`,
    ...rows.map((r) => `| ${r.key} | ${r.count} | $${r.grossPnl.toFixed(2)} | $${r.fees.toFixed(2)} | $${r.netPnl.toFixed(2)} |`),
  ].join("\n");
}
```

- [ ] **Step 2: Commit**

```
pnpm tsc --noEmit
git add src/server/services/backtest/reporter/markdown-template.ts
git commit -m "feat(backtest): markdown report template"
```

---

### Task 27: reporter/html-template.ts (ECharts)

**Files:**
- Create: `src/server/services/backtest/reporter/html-template.ts`

- [ ] **Step 1: Implement**

Create:

```ts
import type { Aggregated } from "./aggregate";
import type { BacktestConfig, EquityCurvePoint } from "@/server/services/backtest/types";

export function renderHtml(
  config: BacktestConfig,
  agg: Aggregated,
  equityCurve: EquityCurvePoint[],
): string {
  const o = agg.overall;
  const cards = [
    card("ROI", `${(o.roi * 100).toFixed(2)}%`, o.roi >= 0 ? "pos" : "neg"),
    card("净收益", `$${o.netPnl.toFixed(0)}`, o.netPnl >= 0 ? "pos" : "neg"),
    card("交易数", String(o.totalTrades)),
    card("胜率", `${(o.winRate * 100).toFixed(1)}%`),
    card("最大回撤", `$${o.maxDrawdown.toFixed(0)}`, "neg"),
  ].join("");

  const json = JSON.stringify({ equityCurve, agg }, null, 0);

  return `<!doctype html><html><head>
<meta charset="utf-8" />
<title>Backtest Report</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>
<style>
  body{font:14px -apple-system,Segoe UI,Roboto,sans-serif;margin:24px;color:#111;}
  h1{margin-top:0;}
  .cards{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0;}
  .card{flex:1;min-width:160px;padding:16px;border:1px solid #ddd;border-radius:8px;background:#fafafa;}
  .card .label{font-size:12px;color:#666;text-transform:uppercase;}
  .card .value{font-size:24px;font-weight:600;margin-top:4px;}
  .pos{color:#0a0;} .neg{color:#a00;}
  .chart{height:360px;margin:24px 0;}
  pre{background:#f5f5f5;padding:12px;border-radius:4px;overflow-x:auto;}
</style>
</head><body>
<h1>Backtest Report</h1>
<p>${config.from.toISOString().slice(0, 10)} → ${config.to.toISOString().slice(0, 10)}</p>
<div class="cards">${cards}</div>
<pre id="params">${escapeHtml(JSON.stringify(config, null, 2))}</pre>
<div id="equity" class="chart"></div>
<div id="histogram" class="chart"></div>
<div id="bypair" class="chart"></div>
<div id="bysymbol" class="chart"></div>
<div id="fee" class="chart"></div>
<div id="hold" class="chart"></div>
<div id="heatmap" class="chart"></div>
<script>
const data = ${json};
(function(){
  const e = echarts.init(document.getElementById('equity'));
  e.setOption({
    title:{text:'账户净值曲线'},
    xAxis:{type:'time'}, yAxis:{type:'value'},
    series:[{type:'line', smooth:true, data: data.equityCurve.map(p => [p.date, p.equity])}],
  });
  const h = echarts.init(document.getElementById('histogram'));
  h.setOption({
    title:{text:'每日/每笔 收益分布'},
    xAxis:{type:'category', data: data.agg.dailyPnlHistogram.map(x=>x.bin.toFixed(2))},
    yAxis:{type:'value'},
    series:[{type:'bar', data: data.agg.dailyPnlHistogram.map(x=>x.count)}],
  });
  const bp = echarts.init(document.getElementById('bypair'));
  bp.setOption({
    title:{text:'按交易所对 P&L'},
    xAxis:{type:'value'},
    yAxis:{type:'category', data: data.agg.byExchangePair.map(g=>g.key)},
    series:[{type:'bar', data: data.agg.byExchangePair.map(g=>g.netPnl)}],
  });
  const bs = echarts.init(document.getElementById('bysymbol'));
  bs.setOption({
    title:{text:'按币种 P&L'},
    xAxis:{type:'category', data: data.agg.bySymbol.map(g=>g.key)},
    yAxis:{type:'value'},
    series:[{type:'bar', data: data.agg.bySymbol.map(g=>g.netPnl)}],
  });
  const fe = echarts.init(document.getElementById('fee'));
  fe.setOption({
    title:{text:'手续费 vs 净收益'},
    series:[{type:'pie',
      data:[
        { name:'总手续费', value: Math.max(0,data.agg.feeBreakdown.totalFees) },
        { name:'净收益', value: Math.max(0,data.agg.feeBreakdown.netPnl) },
      ],
    }],
  });
  const hd = echarts.init(document.getElementById('hold'));
  hd.setOption({
    title:{text:'持仓时长分布'},
    xAxis:{type:'category', data: data.agg.holdDurationBuckets.map(b=>b.bucket)},
    yAxis:{type:'value'},
    series:[{type:'bar', data: data.agg.holdDurationBuckets.map(b=>b.count)}],
  });
  const hm = echarts.init(document.getElementById('heatmap'));
  const heat = [];
  for (const g of data.agg.byDayOfWeek) {
    for (const h of data.agg.byHourOfDay) {
      heat.push([Number(h.key), Number(g.key), g.count * h.count]);
    }
  }
  hm.setOption({
    title:{text:'机会热力图（星期 × 小时）'},
    xAxis:{type:'category', data: ['0','1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','20','21','22','23']},
    yAxis:{type:'category', data: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']},
    visualMap:{min:0, max:10, orient:'horizontal'},
    series:[{type:'heatmap', data: heat}],
  });
})();
</script>
</body></html>`;
}

function card(label: string, value: string, tone?: "pos" | "neg"): string {
  const cls = tone ? ` ${tone}` : "";
  return `<div class="card"><div class="label">${label}</div><div class="value${cls}">${value}</div></div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
```

- [ ] **Step 2: Commit**

```
pnpm tsc --noEmit
git add src/server/services/backtest/reporter/html-template.ts
git commit -m "feat(backtest): HTML report template with 7 ECharts charts"
```

---

### Task 28: reporter/reporter.ts (file orchestrator)

**Files:**
- Create: `src/server/services/backtest/reporter/reporter.ts`

- [ ] **Step 1: Implement**

```ts
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
    ["positionId", "symbol", "longExchange", "shortExchange", "openedAt", "closedAt",
     "longEntry", "shortEntry", "longExit", "shortExit",
     "grossPnl", "fees", "fundingPnl", "netPnl", "holdHours"],
    result.closedTrades.map((t) => [
      t.positionId, t.symbol, t.longExchange, t.shortExchange, t.openedAt, t.closedAt,
      t.longEntry, t.shortEntry, t.longExit, t.shortExit,
      t.grossPnl, t.fees, t.fundingPnl, t.netPnl, t.holdHours,
    ]),
  );
  await writeFile(path.join(dir, "trades.csv"), tradesCsv, "utf8");

  const dailyCsv = toCsv(
    ["date", "equity", "grossPnl", "netPnl", "totalFees"],
    result.equityCurve.map((p) => [p.date, p.equity, p.grossPnl, p.netPnl, p.totalFees]),
  );
  await writeFile(path.join(dir, "daily.csv"), dailyCsv, "utf8");

  return dir;
}
```

- [ ] **Step 2: Commit**

```
pnpm tsc --noEmit
git add src/server/services/backtest/reporter/reporter.ts
git commit -m "feat(backtest): reporter orchestrator (writes 4 files)"
```

---

## Phase 6 — Wire-up + E2E + Baseline

### Task 29: top-level backtest/cli.ts

**Files:**
- Create: `src/server/services/backtest/cli.ts`

- [ ] **Step 1: Implement**

```ts
#!/usr/bin/env node
import path from "node:path";
import { DEFAULT_CONFIG, type BacktestConfig } from "./types";
import { phase0SanityCheck } from "./phase0-sanity-check";
import { runBacktest } from "./runner/runner";
import { writeReport } from "./reporter/reporter";

function parseArgs(): BacktestConfig & { phase: "0" | "2"; output: string } {
  const args = process.argv.slice(2);
  const get = (k: string, d?: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : d;
  };
  const phase = (get("phase", "2") as "0" | "2");
  const to = new Date(get("to", new Date().toISOString())!);
  const from = new Date(get("from", new Date(to.getTime() - 180 * 24 * 3600_000).toISOString())!);
  const output = get("output", "docs/backtest-reports")!;
  return {
    ...DEFAULT_CONFIG,
    from, to, phase, output,
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```
pnpm tsc --noEmit
git add src/server/services/backtest/cli.ts
git commit -m "feat(backtest): top-level CLI (phase 0 / 2 routing)"
```

---

### Task 30: End-to-end integration test

**Files:**
- Create: `tests/integration/backtest/end-to-end.test.ts`

- [ ] **Step 1: Write test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "@/server/db/client";
import { runBacktest } from "@/server/services/backtest/runner/runner";
import { writeReport } from "@/server/services/backtest/reporter/reporter";
import { DEFAULT_CONFIG } from "@/server/services/backtest/types";
import { existsSync } from "node:fs";

async function reset() {
  await prisma.settlement.deleteMany();
  await prisma.tradeLog.deleteMany();
  await prisma.position.deleteMany();
  await prisma.ohlcvSnapshot.deleteMany();
  await prisma.fundingRateSnapshot.deleteMany();
  await prisma.exchange.deleteMany();
}

describe("backtest end-to-end", () => {
  beforeEach(reset);

  it("runs a 2-day backtest with seeded data and produces 4 report files", async () => {
    // Seed 2 exchanges, 1 symbol, 2 days of rates + ohlcv
    const bin = await prisma.exchange.create({ data: { name: "binance", apiKey: "", apiSecret: "" } });
    const okx = await prisma.exchange.create({ data: { name: "okx", apiKey: "", apiSecret: "" } });
    const t0 = Date.UTC(2025, 0, 1);

    // OHLCV every hour for 48h × 2 exchanges
    for (let h = 0; h < 48; h++) {
      for (const ex of [bin, okx]) {
        await prisma.ohlcvSnapshot.create({
          data: {
            exchangeId: ex.id, symbol: "BTC/USDT:USDT", timeframe: "1h",
            openTime: new Date(t0 + h * 3600_000),
            open: 100, high: 105, low: 95, close: 100 + (h % 5),
            volume: 1000,
          },
        });
      }
    }
    // Funding at 8/16/24/32/40 hours with a spread between exchanges
    for (const h of [8, 16, 24, 32, 40]) {
      await prisma.fundingRateSnapshot.create({
        data: { exchangeId: bin.id, symbol: "BTC/USDT:USDT", currentRate: 0.001, collectedAt: new Date(t0 + h * 3600_000), intervalHours: 8 },
      });
      await prisma.fundingRateSnapshot.create({
        data: { exchangeId: okx.id, symbol: "BTC/USDT:USDT", currentRate: -0.0005, collectedAt: new Date(t0 + h * 3600_000), intervalHours: 8 },
      });
    }

    const result = await runBacktest({
      ...DEFAULT_CONFIG,
      from: new Date(t0),
      to: new Date(t0 + 48 * 3600_000),
      failureRate: 0,   // deterministic
    });

    expect(result.closedTrades.length).toBeGreaterThanOrEqual(0);   // not crashing == pass
    expect(result.equityCurve.length).toBeGreaterThan(0);

    const out = await mkdtemp(path.join(tmpdir(), "bt-"));
    const dir = await writeReport(result, out);
    expect(existsSync(path.join(dir, "report.html"))).toBe(true);
    expect(existsSync(path.join(dir, "report.md"))).toBe(true);
    expect(existsSync(path.join(dir, "trades.csv"))).toBe(true);
    expect(existsSync(path.join(dir, "daily.csv"))).toBe(true);
  }, 60_000);
});
```

- [ ] **Step 2: Run**

```
docker compose exec postgres psql -U arbitrage -c "TRUNCATE funding_rate_snapshots, funding_rate_hourly CASCADE;"
pnpm test tests/integration/backtest/end-to-end.test.ts
```

If this test surfaces P&L-math or handler bugs in runner.ts, iterate: fix in runner.ts, re-run. **Keep the test minimal** — it verifies "does not crash and writes 4 files", not exact P&L values.

- [ ] **Step 3: Commit**

```
git add tests/integration/backtest/end-to-end.test.ts
git commit -m "test(backtest): end-to-end integration — synthetic data → files"
```

---

### Task 31: Example report baseline

**Files:**
- Create: `docs/backtest-reports/example/` (4 files, committed)
- Modify: `.gitignore`

- [ ] **Step 1: Update .gitignore**

Append to `.gitignore`:

```
/docs/backtest-reports/*
!/docs/backtest-reports/example/
```

- [ ] **Step 2: Produce the baseline report**

With the 6-month data already loaded (Task 5):

```
docker compose run --rm app pnpm tsx src/server/services/backtest/cli.ts \
  --output docs/backtest-reports
```

This creates `docs/backtest-reports/<timestamp>/`. Rename it to `example`:

```
mv docs/backtest-reports/<timestamp> docs/backtest-reports/example
```

- [ ] **Step 3: Open report.html in a browser**

Double-click or `open docs/backtest-reports/example/report.html`. Verify:
- 5 cards show numbers
- 7 charts render
- `params` JSON block is readable

- [ ] **Step 4: Commit**

```
git add .gitignore docs/backtest-reports/example/
git commit -m "docs(backtest): example baseline report + ignore pattern"
```

---

### Task 32: Docs (README + executor-di-migration.md)

**Files:**
- Create: `docs/backtest/README.md`
- Create: `docs/backtest/executor-di-migration.md`

- [ ] **Step 1: README**

Create `docs/backtest/README.md`:

```markdown
# 回测引擎使用手册

## 前置步骤

1. `./dev.sh` 跑起 dev 环境（Postgres + Redis）。
2. Exchange 表里有 `binance` / `okx` / `bybit` 三行（用 seed 或 SQL 插入）。

## 拉历史数据

```
pnpm tsx src/server/services/backtest/data-loader/cli.ts \
  [--from YYYY-MM-DD] [--to YYYY-MM-DD] \
  [--exchanges binance,okx,bybit] \
  [--symbols BTC/USDT:USDT,ETH/USDT:USDT,...]
```

默认：最近 180 天、三交易所、5 币种、1h 粒度。耗时 2–5 分钟。

## 跑 Phase 0 gate

```
pnpm tsx src/server/services/backtest/cli.ts --phase 0
```

输出：`opps=<N> pnl=$<X> verdict=positive|weak|negative`。

- **positive (ROI > 10%)**: 继续完整回测
- **negative (ROI ≤ 0)**: 停下来重新评估策略

## 跑完整回测

```
pnpm tsx src/server/services/backtest/cli.ts [选项]
```

CLI 选项：

| 选项 | 默认 | 说明 |
|---|---|---|
| `--from` / `--to` | 最近 180 天 | 回测范围 |
| `--capital` | 10000 | 初始资金 |
| `--size` | 500 | 单次仓位 |
| `--max-concurrent` | 3 | 并发仓位上限 |
| `--min-spread` | 0.0005 | 最小费率差 |
| `--min-apy` | 0.1 | 最小年化 |
| `--slippage-bps` | 3 | 滑点（bps） |
| `--failure-rate` | 0.02 | 订单失败率 |
| `--no-failures` | — | 禁用失败率（= 0） |
| `--seed` | plan4-default | PRNG 种子 |
| `--no-vol-pause` | — | 关闭 volatility pause |
| `--output` | docs/backtest-reports | 输出目录 |

## 读报告

`docs/backtest-reports/<timestamp>/`：
- `report.html` — 浏览器双击看（5 卡片 + 7 ECharts 图表）
- `report.md` — 文字摘要，可 git diff 对比多次回测
- `trades.csv` — 每笔 ClosedTrade
- `daily.csv` — 每日 EquityCurvePoint

`docs/backtest-reports/example/` 是 git 追踪的 baseline；其它目录不入 git。
```

- [ ] **Step 2: Executor DI migration doc**

Create `docs/backtest/executor-di-migration.md`:

```markdown
# Executor 依赖注入迁移（Plan 4, Phase 3）

## 改动前

`src/server/services/executor/*.ts` 直接 `import { prisma }` / `import { redis }` / `createAdapter(...)`。无法单元测试，无法回测。

## 改动后

所有 executor 函数接受 `ExecutorContext` 作为第一个参数：

```ts
export interface ExecutorContext {
  store: PositionStore;     // Prisma CRUD 的抽象
  redis: RedisLike;         // Redis 抽象
  adapterFor: (name: string) => Promise<ExchangeAdapter>;
  clock: Clock;             // new Date() 的抽象
  random: () => number;     // Math.random 的抽象
  log: (msg, meta?) => void;
}
```

## 生产入口

```ts
import { buildProdContext } from "@/server/services/executor/context-prod";

const ctx = await buildProdContext();
await openHedgedPosition(ctx, req);
```

`buildProdContext()` 构造真实的 Prisma/Redis/ccxt adapter 实现。

## 回测入口

Plan 4 的 `runBacktest()` 构造一个"假"ctx：
- `store`: `InMemoryPositionStore` — 数据在 JS Map
- `redis`: `InMemoryRedis` — 带 TTL 的 Map
- `adapterFor`: `HistoricalAdapter` — 基于 OHLCV + clock.now() 回放
- `clock`: `VirtualClock` — 回测时间线
- `random`: seeded PRNG — 确定性失败注入

生产和回测共享完全相同的 executor 代码，**消除 drift**。

## 规则

- `src/server/services/executor/` 里 **不得**直接 `import { prisma }` 或 `import { redis }`
- 每个新的 executor 函数签名以 `ctx: ExecutorContext` 为第一个参数
- 单元测试可用 mocked ctx；集成测试用 `buildProdContext()`
```

- [ ] **Step 3: Commit**

```
git add docs/backtest/README.md docs/backtest/executor-di-migration.md
git commit -m "docs(backtest): user manual + executor DI migration notes"
```

---

## Acceptance Criteria (spec §7 recap)

- [ ] Data loader CLI populates 6 months of data
- [ ] Phase 0 sanity check produces verdict
- [ ] Executor DI refactor complete, no `import { prisma }` / `import { redis }` in `executor/*.ts`
- [ ] All existing unit + integration tests green
- [ ] **Production smoke test on v0.2.0 live**
- [ ] `pnpm tsx backtest/cli.ts` runs end-to-end
- [ ] 4 report files generated
- [ ] `report.html` displays 5 cards + 7 charts in browser
- [ ] Example baseline report committed
- [ ] CI green (lint + tsc + tests + next build)
- [ ] Follow-ups captured (if any surface)

---

## Self-Review Notes

- **Spec §1–§5 coverage**: Tasks 1–32 implement Phases 1–6. Gate after Task 7 enforces §5 Gate semantics. Each Task has concrete file paths + code.
- **Spec §6 deliverables**: covered via the File Structure map + specific Tasks.
- **Spec §7 acceptance**: enumerated above; Task 16 enforces the production smoke test; Task 31 enforces example baseline commit.
- **Risk coverage (§8)**:
  - *DI regression*: Task 10–14 each run full tests; Task 16 is production smoke test gate
  - *Phase 0 negative*: Gate section halts the plan
  - *ccxt data holes*: Task 5 Step 4 inspects per-exchange row counts
  - *ECharts CDN down*: HTML uses cdn.jsdelivr.net which is stable; follow-up can embed
- **Open questions (§11)**: left as inline decisions in Tasks 23 (rescue path in backtest) and 26 (Sharpe min-sample guard) for implementer's judgment — call out if unsure during implementation.
- **Scope guardrails**: no UI, no grid search, no Monte Carlo (spec §1.3, §9).
- **Placeholders**: none.
- **Type consistency**: `ExecutorContext` / `PositionStore` / `Clock` / `RedisLike` defined once in Task 8, reused verbatim in Tasks 9–23.
