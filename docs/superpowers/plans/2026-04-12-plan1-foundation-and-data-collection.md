# Plan 1: Foundation + Data Collection

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the full project skeleton with Docker, database, exchange adapters, funding rate collection, opportunity detection, and a working UI shell with real-time rate display.

**Architecture:** Next.js 15 App Router single-repo monolith. tRPC for API. Prisma + PostgreSQL for persistence. Redis + BullMQ for caching and job scheduling. ccxt for exchange integration. Dark/light theme via CSS variables + Tailwind.

**Tech Stack:** Next.js 15, TypeScript, tRPC, Prisma, PostgreSQL 15, Redis 7, BullMQ, ccxt, shadcn/ui, Tailwind CSS, Recharts, Docker Compose, Vitest

**Spec:** `docs/superpowers/specs/2026-04-12-funding-rate-arbitrage-platform-design.md`

**Design System:** `DESIGN.md` (Coinbase-inspired, dark + light theme)

---

## File Structure

```
arbitrage/
├── docker-compose.yml              # Dev: app + postgres + redis
├── docker-compose.prod.yml         # Prod override
├── Dockerfile.dev                  # Dev with hot reload
├── Dockerfile                      # Prod multi-stage build
├── .env.example                    # Template for env vars
├── package.json
├── tsconfig.json
├── tailwind.config.ts
├── next.config.ts
├── vitest.config.ts
├── prisma/
│   └── schema.prisma               # All table definitions
├── src/
│   ├── app/
│   │   ├── layout.tsx              # Root layout: fonts, theme provider, sidebar
│   │   ├── globals.css             # Tailwind + CSS variables (dark/light tokens)
│   │   ├── (dashboard)/
│   │   │   ├── layout.tsx          # Dashboard shell: sidebar + main
│   │   │   ├── page.tsx            # Dashboard overview (placeholder)
│   │   │   ├── opportunities/
│   │   │   │   └── page.tsx        # Real-time rate table + opportunity cards
│   │   │   ├── positions/
│   │   │   │   └── page.tsx        # Placeholder for Plan 2
│   │   │   ├── backtest/
│   │   │   │   └── page.tsx        # Placeholder for Plan 3
│   │   │   └── settings/
│   │   │       └── page.tsx        # Exchange API config + strategy params
│   │   └── api/
│   │       └── trpc/[trpc]/route.ts
│   ├── server/
│   │   ├── api/
│   │   │   ├── root.ts             # tRPC root router
│   │   │   ├── trpc.ts             # tRPC init (context, middleware)
│   │   │   └── routers/
│   │   │       ├── exchange.ts     # CRUD exchanges, connection test
│   │   │       ├── opportunity.ts  # List opportunities, real-time sub
│   │   │       ├── settings.ts     # Get/set system config
│   │   │       └── dashboard.ts    # Balance overview
│   │   ├── services/
│   │   │   ├── exchange/
│   │   │   │   ├── types.ts        # ExchangeAdapter interface + shared types
│   │   │   │   ├── factory.ts      # getAdapter(exchangeName) factory
│   │   │   │   ├── binance.ts      # BinanceAdapter implements ExchangeAdapter
│   │   │   │   ├── okx.ts
│   │   │   │   ├── bybit.ts
│   │   │   │   └── gateio.ts
│   │   │   ├── collector/
│   │   │   │   └── funding-rate.ts # collectAllRates() — fetch + store + cache
│   │   │   ├── detector/
│   │   │   │   └── opportunity.ts  # detectOpportunities() — compare + filter + store
│   │   │   └── crypto/
│   │   │       └── encryption.ts   # AES-256-GCM encrypt/decrypt for API keys
│   │   ├── jobs/
│   │   │   ├── worker.ts           # BullMQ worker bootstrap
│   │   │   ├── queues.ts           # Queue definitions + schedulers
│   │   │   └── collect-rates.ts    # Job handler: collect → detect → notify
│   │   └── db/
│   │       ├── client.ts           # Prisma client singleton
│   │       ├── redis.ts            # Redis + BullMQ connection
│   │       └── seed.ts             # Seed default settings
│   ├── lib/
│   │   ├── types.ts                # Shared types (FundingRate, Opportunity, etc.)
│   │   ├── constants.ts            # Exchange names, default params
│   │   ├── utils.ts                # annualizedYield(), formatRate(), etc.
│   │   └── trpc.ts                 # tRPC client hooks for React
│   └── components/
│       ├── ui/                     # shadcn/ui primitives (installed via CLI)
│       ├── theme-provider.tsx      # next-themes provider
│       ├── theme-toggle.tsx        # Dark/light switch button
│       ├── layout/
│       │   ├── sidebar.tsx         # Nav sidebar
│       │   └── header.tsx          # Top bar with theme toggle
│       ├── opportunities/
│       │   ├── rate-table.tsx      # Real-time funding rate comparison table
│       │   └── opportunity-card.tsx # Detected opportunity with action button
│       └── settings/
│           ├── exchange-form.tsx   # Add/edit exchange API keys
│           └── params-form.tsx     # Strategy parameter editor
└── tests/
    ├── unit/
    │   ├── encryption.test.ts
    │   ├── utils.test.ts
    │   ├── detector.test.ts
    │   └── collector.test.ts
    └── integration/
        └── exchange-router.test.ts
```

---

## Task 1: Project Scaffold + Docker

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `.env.example`, `docker-compose.yml`, `Dockerfile.dev`

- [ ] **Step 1: Initialize Next.js project**

```bash
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-pnpm
```

Expected: Next.js 15 project created with App Router, Tailwind, ESLint, pnpm.

- [ ] **Step 2: Install core dependencies**

```bash
pnpm add @trpc/server @trpc/client @trpc/next @trpc/react-query @tanstack/react-query zod prisma @prisma/client bullmq ioredis ccxt next-themes recharts
pnpm add -D vitest @vitejs/plugin-react tsx nodemon
```

- [ ] **Step 3: Create `.env.example`**

```env
# Database
DATABASE_URL=postgresql://arbitrage:changeme@localhost:5432/arbitrage

# Redis
REDIS_URL=redis://localhost:6379

# Encryption (generate with: openssl rand -hex 32)
ENCRYPTION_KEY=

# Exchange API keys are stored encrypted in DB, not here
```

- [ ] **Step 4: Create `docker-compose.yml`**

```yaml
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile.dev
    volumes:
      - .:/app
      - /app/node_modules
    ports:
      - "3000:3000"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    env_file: .env.local

  postgres:
    image: postgres:15-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: arbitrage
      POSTGRES_USER: arbitrage
      POSTGRES_PASSWORD: ${DB_PASSWORD:-changeme}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U arbitrage"]
      interval: 5s
      timeout: 3s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
```

- [ ] **Step 5: Create `Dockerfile.dev`**

```dockerfile
FROM node:20-alpine
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm prisma generate
CMD ["pnpm", "dev"]
```

- [ ] **Step 6: Create `.env.local` from example**

```bash
cp .env.example .env.local
```

Edit `.env.local` and set `ENCRYPTION_KEY` (generate with `openssl rand -hex 32`).

- [ ] **Step 7: Verify Docker Compose starts**

```bash
docker compose up -d postgres redis
docker compose logs postgres redis
```

Expected: Both containers healthy, no errors.

- [ ] **Step 8: Verify Next.js dev server starts locally**

```bash
pnpm dev
```

Expected: Next.js running on http://localhost:3000, default page loads.

- [ ] **Step 9: Commit**

```bash
git init
echo "node_modules/\n.next/\n.env.local\n*.env\n!.env.example" > .gitignore
git add .
git commit -m "feat: project scaffold with Next.js 15, Docker Compose, PG + Redis"
```

---

## Task 2: Prisma Schema + Database

**Files:**
- Create: `prisma/schema.prisma`, `src/server/db/client.ts`, `src/server/db/redis.ts`, `src/server/db/seed.ts`

- [ ] **Step 1: Initialize Prisma**

```bash
pnpm prisma init --datasource-provider postgresql
```

- [ ] **Step 2: Write `prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Exchange {
  id         String   @id @default(uuid())
  name       String   @unique // "binance" | "okx" | "bybit" | "gateio"
  apiKey     String   @map("api_key")
  apiSecret  String   @map("api_secret")
  passphrase String?
  isEnabled  Boolean  @default(true) @map("is_enabled")
  feeRate    Decimal  @default(0.001) @map("fee_rate") @db.Decimal(10, 6)
  createdAt  DateTime @default(now()) @map("created_at")
  updatedAt  DateTime @updatedAt @map("updated_at")

  fundingRateSnapshots FundingRateSnapshot[]
  opportunitiesLong    Opportunity[]         @relation("LongExchange")
  opportunitiesShort   Opportunity[]         @relation("ShortExchange")
  positionsLong        Position[]            @relation("PositionLongExchange")
  positionsShort       Position[]            @relation("PositionShortExchange")
  settlements          Settlement[]
  tradeLogs            TradeLog[]

  @@map("exchanges")
}

model FundingRateSnapshot {
  id             String   @id @default(uuid())
  exchangeId     String   @map("exchange_id")
  symbol         String
  currentRate    Decimal  @map("current_rate") @db.Decimal(18, 10)
  predictedRate  Decimal? @map("predicted_rate") @db.Decimal(18, 10)
  nextSettlement DateTime @map("next_settlement")
  intervalHours  Int      @map("interval_hours")
  collectedAt    DateTime @map("collected_at")
  createdAt      DateTime @default(now()) @map("created_at")

  exchange Exchange @relation(fields: [exchangeId], references: [id])

  @@index([symbol, collectedAt])
  @@index([exchangeId, symbol])
  @@map("funding_rate_snapshots")
}

model FundingRateHourly {
  id          String   @id @default(uuid())
  exchangeId  String   @map("exchange_id")
  symbol      String
  hour        DateTime
  avgRate     Decimal  @map("avg_rate") @db.Decimal(18, 10)
  maxRate     Decimal  @map("max_rate") @db.Decimal(18, 10)
  minRate     Decimal  @map("min_rate") @db.Decimal(18, 10)
  sampleCount Int      @map("sample_count")

  @@unique([exchangeId, symbol, hour])
  @@index([symbol, hour])
  @@map("funding_rate_hourly")
}

enum OpportunityStatus {
  DETECTED
  NOTIFIED
  ACCEPTED
  REJECTED
  EXPIRED
}

model Opportunity {
  id              String            @id @default(uuid())
  symbol          String
  longExchangeId  String            @map("long_exchange_id")
  shortExchangeId String            @map("short_exchange_id")
  longRate        Decimal           @map("long_rate") @db.Decimal(18, 10)
  shortRate       Decimal           @map("short_rate") @db.Decimal(18, 10)
  rateSpread      Decimal           @map("rate_spread") @db.Decimal(18, 10)
  annualizedYield Decimal           @map("annualized_yield") @db.Decimal(10, 4)
  suggestedSize   Decimal           @map("suggested_size") @db.Decimal(20, 8)
  status          OpportunityStatus @default(DETECTED)
  cooldownUntil   DateTime?         @map("cooldown_until")
  detectedAt      DateTime          @map("detected_at")
  createdAt       DateTime          @default(now()) @map("created_at")

  longExchange  Exchange   @relation("LongExchange", fields: [longExchangeId], references: [id])
  shortExchange Exchange   @relation("ShortExchange", fields: [shortExchangeId], references: [id])
  positions     Position[]

  @@index([symbol, status])
  @@index([detectedAt])
  @@map("opportunities")
}

enum PositionStatus {
  OPENING
  OPEN
  CLOSING
  CLOSED
  RESCUE
}

enum CloseReason {
  MANUAL
  RATE_REVERSAL
  TAKE_PROFIT
  RISK_CONTROL
}

model Position {
  id                 String         @id @default(uuid())
  opportunityId      String         @map("opportunity_id")
  symbol             String
  longExchangeId     String         @map("long_exchange_id")
  longSize           Decimal        @map("long_size") @db.Decimal(20, 8)
  longAvgEntryPrice  Decimal        @map("long_avg_entry_price") @db.Decimal(20, 8)
  shortExchangeId    String         @map("short_exchange_id")
  shortSize          Decimal        @map("short_size") @db.Decimal(20, 8)
  shortAvgEntryPrice Decimal        @map("short_avg_entry_price") @db.Decimal(20, 8)
  status             PositionStatus @default(OPENING)
  closeReason        CloseReason?   @map("close_reason")
  openedAt           DateTime       @map("opened_at")
  closedAt           DateTime?      @map("closed_at")
  createdAt          DateTime       @default(now()) @map("created_at")
  updatedAt          DateTime       @updatedAt @map("updated_at")

  opportunity  Opportunity  @relation(fields: [opportunityId], references: [id])
  longExchange  Exchange    @relation("PositionLongExchange", fields: [longExchangeId], references: [id])
  shortExchange Exchange    @relation("PositionShortExchange", fields: [shortExchangeId], references: [id])
  settlements  Settlement[]
  tradeLogs    TradeLog[]

  @@index([status])
  @@index([symbol])
  @@map("positions")
}

enum TradeSide {
  LONG
  SHORT
}

enum TradeAction {
  OPEN
  CLOSE
  RESCUE
}

enum OrderType {
  MARKET
  LIMIT_IOC
}

enum TradeStatus {
  PENDING
  FILLED
  PARTIAL
  FAILED
}

model TradeLog {
  id              String      @id @default(uuid())
  positionId      String      @map("position_id")
  exchangeId      String      @map("exchange_id")
  executionId     String      @map("execution_id")
  clientOrderId   String      @unique @map("client_order_id")
  side            TradeSide
  action          TradeAction
  orderType       OrderType   @map("order_type")
  price           Decimal     @db.Decimal(20, 8)
  signedQty       Decimal     @map("signed_qty") @db.Decimal(20, 8)
  fee             Decimal     @db.Decimal(20, 8)
  exchangeOrderId String?     @map("exchange_order_id")
  status          TradeStatus @default(PENDING)
  executedAt      DateTime?   @map("executed_at")
  createdAt       DateTime    @default(now()) @map("created_at")

  position Position @relation(fields: [positionId], references: [id])
  exchange Exchange @relation(fields: [exchangeId], references: [id])

  @@index([positionId, side])
  @@index([executionId])
  @@index([clientOrderId])
  @@map("trade_logs")
}

model Settlement {
  id            String   @id @default(uuid())
  positionId    String   @map("position_id")
  exchangeId    String   @map("exchange_id")
  side          TradeSide
  fundingRate   Decimal  @map("funding_rate") @db.Decimal(18, 10)
  fundingAmount Decimal  @map("funding_amount") @db.Decimal(20, 8)
  settledAt     DateTime @map("settled_at")
  createdAt     DateTime @default(now()) @map("created_at")

  position Position @relation(fields: [positionId], references: [id])
  exchange Exchange @relation(fields: [exchangeId], references: [id])

  @@index([positionId])
  @@map("settlements")
}

model Setting {
  key         String   @id
  value       Json
  description String?
  updatedAt   DateTime @updatedAt @map("updated_at")

  @@map("settings")
}
```

- [ ] **Step 3: Create `src/server/db/client.ts`**

```typescript
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ log: ["error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```

- [ ] **Step 4: Create `src/server/db/redis.ts`**

```typescript
import IORedis from "ioredis";

const globalForRedis = globalThis as unknown as { redis: IORedis };

export const redis =
  globalForRedis.redis ??
  new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null, // Required by BullMQ
  });

if (process.env.NODE_ENV !== "production") globalForRedis.redis = redis;
```

- [ ] **Step 5: Create `src/server/db/seed.ts`**

```typescript
import { prisma } from "./client";

const DEFAULT_SETTINGS: Array<{
  key: string;
  value: unknown;
  description: string;
}> = [
  {
    key: "min_rate_spread",
    value: 0.0001,
    description: "Minimum funding rate spread (0.01%)",
  },
  {
    key: "min_annualized_yield",
    value: 0.15,
    description: "Minimum annualized yield (15%)",
  },
  { key: "max_leverage", value: 3, description: "Maximum leverage" },
  {
    key: "safety_margin_ratio",
    value: 0.5,
    description: "Margin safety buffer (50%)",
  },
  {
    key: "max_single_position",
    value: 0.2,
    description: "Max single position as % of total (20%)",
  },
  {
    key: "rate_reversal_exit",
    value: -0.00005,
    description: "Rate reversal exit threshold (-0.005%)",
  },
  {
    key: "min_holding_periods",
    value: 3,
    description: "Minimum settlement periods to hold",
  },
  {
    key: "rate_collect_interval_ms",
    value: 180000,
    description: "Rate collection interval in ms (3 min)",
  },
  {
    key: "health_check_interval_ms",
    value: 300000,
    description: "Health check interval in ms (5 min)",
  },
  {
    key: "settlement_pre_check_ms",
    value: 900000,
    description: "Pre-settlement check lead time in ms (15 min)",
  },
  {
    key: "max_single_leg_exposure",
    value: 1000,
    description: "Max single leg exposure in USDT",
  },
  {
    key: "volatility_threshold_1h",
    value: 0.05,
    description: "1h price volatility pause threshold (5%)",
  },
  {
    key: "volatility_threshold_24h",
    value: 0.15,
    description: "24h price volatility pause threshold (15%)",
  },
  {
    key: "backtest_slippage",
    value: 0.0005,
    description: "Backtest slippage assumption (0.05%)",
  },
];

async function main() {
  for (const setting of DEFAULT_SETTINGS) {
    await prisma.setting.upsert({
      where: { key: setting.key },
      update: {},
      create: {
        key: setting.key,
        value: setting.value as any,
        description: setting.description,
      },
    });
  }
  console.log("Seed complete: %d settings", DEFAULT_SETTINGS.length);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 6: Generate Prisma client and run migration**

```bash
pnpm prisma generate
pnpm prisma db push
pnpm tsx src/server/db/seed.ts
```

Expected: Tables created in PostgreSQL, 14 default settings seeded.

- [ ] **Step 7: Verify with Prisma Studio**

```bash
pnpm prisma studio
```

Expected: Browser opens, all tables visible, settings table has 14 rows.

- [ ] **Step 8: Commit**

```bash
git add prisma/ src/server/db/
git commit -m "feat: Prisma schema with all tables, seed default settings"
```

---

## Task 3: Shared Types + Utility Functions

**Files:**
- Create: `src/lib/types.ts`, `src/lib/constants.ts`, `src/lib/utils.ts`, `tests/unit/utils.test.ts`

- [ ] **Step 1: Write failing tests for utility functions**

Create `tests/unit/utils.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  annualizedYield,
  formatRate,
  formatUsd,
  rateSpread,
} from "@/lib/utils";

describe("annualizedYield", () => {
  it("calculates correctly for 8h interval", () => {
    // 0.03% spread * 3 settlements/day * 365 days
    const result = annualizedYield(0.0003, 8);
    expect(result).toBeCloseTo(0.3285, 4); // 32.85%
  });

  it("calculates correctly for 4h interval", () => {
    const result = annualizedYield(0.0001, 4);
    expect(result).toBeCloseTo(0.219, 3); // 21.9%
  });

  it("returns 0 for zero spread", () => {
    expect(annualizedYield(0, 8)).toBe(0);
  });
});

describe("rateSpread", () => {
  it("returns positive spread when short rate > long rate", () => {
    expect(rateSpread(0.0003, 0.0001)).toBeCloseTo(0.0002);
  });

  it("returns negative spread when reversed", () => {
    expect(rateSpread(0.0001, 0.0003)).toBeCloseTo(-0.0002);
  });
});

describe("formatRate", () => {
  it("formats as percentage with 4 decimal places", () => {
    expect(formatRate(0.000312)).toBe("0.0312%");
  });

  it("handles negative rates", () => {
    expect(formatRate(-0.0001)).toBe("-0.0100%");
  });
});

describe("formatUsd", () => {
  it("formats with 2 decimals and $ prefix", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });
});
```

- [ ] **Step 2: Create `vitest.config.ts` and run test to verify it fails**

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
```

```bash
pnpm vitest run tests/unit/utils.test.ts
```

Expected: FAIL — module `@/lib/utils` not found.

- [ ] **Step 3: Create `src/lib/constants.ts`**

```typescript
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
```

- [ ] **Step 4: Create `src/lib/types.ts`**

```typescript
import type { ExchangeName } from "./constants";

export interface FundingRate {
  exchange: ExchangeName;
  symbol: string;
  currentRate: number;
  predictedRate: number | null;
  nextSettlement: Date;
  intervalHours: number;
  timestamp: Date;
}

export interface OpportunitySignal {
  symbol: string;
  longExchange: ExchangeName;
  shortExchange: ExchangeName;
  longRate: number;
  shortRate: number;
  rateSpread: number;
  annualizedYield: number;
  suggestedSize: number;
}

export interface Ticker {
  exchange: ExchangeName;
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  timestamp: Date;
}

export interface Balance {
  currency: string;
  total: number;
  free: number;
  used: number;
}

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
```

- [ ] **Step 5: Create `src/lib/utils.ts`**

```typescript
import { SETTLEMENTS_PER_DAY } from "./constants";

export function annualizedYield(
  rateSpreadValue: number,
  intervalHours: number,
): number {
  const settlementsPerDay = SETTLEMENTS_PER_DAY[intervalHours] ?? 24 / intervalHours;
  return rateSpreadValue * settlementsPerDay * 365;
}

export function rateSpread(shortRate: number, longRate: number): number {
  return shortRate - longRate;
}

export function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(4)}%`;
}

export function formatUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(amount);
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
pnpm vitest run tests/unit/utils.test.ts
```

Expected: All 7 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add vitest.config.ts src/lib/ tests/unit/utils.test.ts
git commit -m "feat: shared types, constants, utility functions with tests"
```

---

## Task 4: AES-256-GCM Encryption for API Keys

**Files:**
- Create: `src/server/services/crypto/encryption.ts`, `tests/unit/encryption.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/encryption.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { encrypt, decrypt } from "@/server/services/crypto/encryption";

describe("encryption", () => {
  beforeAll(() => {
    // 32 bytes hex = 64 chars
    process.env.ENCRYPTION_KEY =
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2";
  });

  it("encrypts and decrypts a string", () => {
    const plaintext = "my-secret-api-key-12345";
    const encrypted = encrypt(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it("produces different ciphertexts for same plaintext (random IV)", () => {
    const plaintext = "same-key";
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    expect(a).not.toBe(b);
  });

  it("throws on tampered ciphertext", () => {
    const encrypted = encrypt("test");
    const tampered = encrypted.slice(0, -4) + "AAAA";
    expect(() => decrypt(tampered)).toThrow();
  });

  it("throws when ENCRYPTION_KEY is missing", () => {
    const key = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt("test")).toThrow("ENCRYPTION_KEY");
    process.env.ENCRYPTION_KEY = key;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run tests/unit/encryption.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server/services/crypto/encryption.ts`**

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) throw new Error("ENCRYPTION_KEY environment variable is required");
  return Buffer.from(hex, "hex");
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Format: base64(iv + tag + ciphertext)
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decrypt(encoded: string): string {
  const key = getKey();
  const data = Buffer.from(encoded, "base64");

  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

export function maskKey(key: string): string {
  if (key.length <= 4) return "****";
  return "*".repeat(key.length - 4) + key.slice(-4);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run tests/unit/encryption.test.ts
```

Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/services/crypto/ tests/unit/encryption.test.ts
git commit -m "feat: AES-256-GCM encryption for exchange API keys"
```

---

## Task 5: Exchange Adapter Interface + Binance Implementation

**Files:**
- Create: `src/server/services/exchange/types.ts`, `src/server/services/exchange/factory.ts`, `src/server/services/exchange/binance.ts`

- [ ] **Step 1: Create `src/server/services/exchange/types.ts`**

```typescript
import type {
  FundingRate,
  Ticker,
  Balance,
  OHLCV,
} from "@/lib/types";

export interface OpenParams {
  symbol: string;
  side: "long" | "short";
  size: number;
  leverage: number;
  clientOrderId: string;
}

export interface CloseParams {
  symbol: string;
  side: "long" | "short";
  size: number;
  clientOrderId: string;
}

export interface Order {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: "long" | "short";
  price: number;
  filledSize: number;
  fee: number;
  status: "filled" | "partial" | "failed";
  timestamp: Date;
}

export interface SymbolInfo {
  symbol: string;
  baseCurrency: string;
  quoteCurrency: string;
  minSize: number;
  pricePrecision: number;
  sizePrecision: number;
}

export interface ExchangeAdapter {
  readonly name: string;

  // Funding rates
  getFundingRates(symbols: string[]): Promise<FundingRate[]>;
  getNextSettlementTime(symbol: string): Promise<Date>;

  // Market data
  getPrice(symbol: string): Promise<Ticker>;
  getKline(
    symbol: string,
    timeframe: "1h" | "1d",
    limit: number,
  ): Promise<OHLCV[]>;

  // Account
  getBalances(): Promise<Balance[]>;

  // Trading
  openPosition(params: OpenParams): Promise<Order>;
  closePosition(params: CloseParams): Promise<Order>;
  getOrder(orderId: string): Promise<Order>;

  // Metadata
  getSymbols(): Promise<SymbolInfo[]>;
  getFeeRate(): Promise<number>;

  // Connection test
  testConnection(): Promise<boolean>;
}
```

- [ ] **Step 2: Create `src/server/services/exchange/binance.ts`**

```typescript
import ccxt, { type Exchange } from "ccxt";
import type {
  ExchangeAdapter,
  OpenParams,
  CloseParams,
  Order,
  SymbolInfo,
} from "./types";
import type { FundingRate, Ticker, Balance, OHLCV } from "@/lib/types";

export class BinanceAdapter implements ExchangeAdapter {
  readonly name = "binance" as const;
  private client: Exchange;

  constructor(apiKey: string, apiSecret: string) {
    this.client = new ccxt.binanceusdm({
      apiKey,
      secret: apiSecret,
      options: { defaultType: "swap" },
    });
  }

  async getFundingRates(symbols: string[]): Promise<FundingRate[]> {
    const rates: FundingRate[] = [];
    for (const symbol of symbols) {
      const data = await this.client.fetchFundingRate(symbol);
      rates.push({
        exchange: "binance",
        symbol,
        currentRate: data.fundingRate ?? 0,
        predictedRate: data.nextFundingRate ?? null,
        nextSettlement: new Date(data.fundingDatetime ?? Date.now()),
        intervalHours: 8,
        timestamp: new Date(data.datetime ?? Date.now()),
      });
    }
    return rates;
  }

  async getNextSettlementTime(symbol: string): Promise<Date> {
    const data = await this.client.fetchFundingRate(symbol);
    return new Date(data.fundingDatetime ?? Date.now());
  }

  async getPrice(symbol: string): Promise<Ticker> {
    const ticker = await this.client.fetchTicker(symbol);
    return {
      exchange: "binance",
      symbol,
      last: ticker.last ?? 0,
      bid: ticker.bid ?? 0,
      ask: ticker.ask ?? 0,
      timestamp: new Date(ticker.timestamp ?? Date.now()),
    };
  }

  async getKline(
    symbol: string,
    timeframe: "1h" | "1d",
    limit: number,
  ): Promise<OHLCV[]> {
    const data = await this.client.fetchOHLCV(symbol, timeframe, undefined, limit);
    return data.map(([ts, o, h, l, c, v]) => ({
      timestamp: ts!,
      open: o!,
      high: h!,
      low: l!,
      close: c!,
      volume: v!,
    }));
  }

  async getBalances(): Promise<Balance[]> {
    const balance = await this.client.fetchBalance();
    return Object.entries(balance.total)
      .filter(([, total]) => (total as number) > 0)
      .map(([currency, total]) => ({
        currency,
        total: total as number,
        free: (balance.free[currency] as number) ?? 0,
        used: (balance.used[currency] as number) ?? 0,
      }));
  }

  async openPosition(params: OpenParams): Promise<Order> {
    const ccxtSide = params.side === "long" ? "buy" : "sell";
    await this.client.setLeverage(params.leverage, params.symbol);

    const order = await this.client.createOrder(
      params.symbol,
      "limit",
      ccxtSide,
      params.size,
      undefined,
      {
        clientOrderId: params.clientOrderId,
        timeInForce: "IOC",
      },
    );

    return this.mapOrder(order, params.side);
  }

  async closePosition(params: CloseParams): Promise<Order> {
    const ccxtSide = params.side === "long" ? "sell" : "buy";

    const order = await this.client.createOrder(
      params.symbol,
      "market",
      ccxtSide,
      params.size,
      undefined,
      {
        clientOrderId: params.clientOrderId,
        reduceOnly: true,
      },
    );

    return this.mapOrder(order, params.side);
  }

  async getOrder(orderId: string): Promise<Order> {
    const order = await this.client.fetchOrder(orderId);
    const side = order.side === "buy" ? "long" : "short";
    return this.mapOrder(order, side);
  }

  async getSymbols(): Promise<SymbolInfo[]> {
    const markets = await this.client.loadMarkets();
    return Object.values(markets)
      .filter((m) => m.swap && m.quote === "USDT")
      .map((m) => ({
        symbol: m.symbol,
        baseCurrency: m.base,
        quoteCurrency: m.quote,
        minSize: m.limits?.amount?.min ?? 0,
        pricePrecision: m.precision?.price ?? 2,
        sizePrecision: m.precision?.amount ?? 3,
      }));
  }

  async getFeeRate(): Promise<number> {
    return 0.0004; // Binance USDT-M taker fee
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.client.fetchBalance();
      return true;
    } catch {
      return false;
    }
  }

  private mapOrder(order: any, side: "long" | "short"): Order {
    const filled = order.filled ?? 0;
    let status: Order["status"] = "failed";
    if (filled > 0 && filled >= (order.amount ?? 0)) status = "filled";
    else if (filled > 0) status = "partial";

    return {
      id: order.id,
      clientOrderId: order.clientOrderId ?? "",
      symbol: order.symbol,
      side,
      price: order.average ?? order.price ?? 0,
      filledSize: filled,
      fee: order.fee?.cost ?? 0,
      status,
      timestamp: new Date(order.timestamp ?? Date.now()),
    };
  }
}
```

- [ ] **Step 3: Create the other 3 adapters (OKX, Bybit, Gate.io)**

Create `src/server/services/exchange/okx.ts`:

```typescript
import ccxt, { type Exchange } from "ccxt";
import type {
  ExchangeAdapter,
  OpenParams,
  CloseParams,
  Order,
  SymbolInfo,
} from "./types";
import type { FundingRate, Ticker, Balance, OHLCV } from "@/lib/types";

export class OkxAdapter implements ExchangeAdapter {
  readonly name = "okx" as const;
  private client: Exchange;

  constructor(apiKey: string, apiSecret: string, passphrase?: string) {
    this.client = new ccxt.okx({
      apiKey,
      secret: apiSecret,
      password: passphrase,
      options: { defaultType: "swap" },
    });
  }

  async getFundingRates(symbols: string[]): Promise<FundingRate[]> {
    const rates: FundingRate[] = [];
    for (const symbol of symbols) {
      const data = await this.client.fetchFundingRate(symbol);
      rates.push({
        exchange: "okx",
        symbol,
        currentRate: data.fundingRate ?? 0,
        predictedRate: data.nextFundingRate ?? null,
        nextSettlement: new Date(data.fundingDatetime ?? Date.now()),
        intervalHours: 8,
        timestamp: new Date(data.datetime ?? Date.now()),
      });
    }
    return rates;
  }

  async getNextSettlementTime(symbol: string): Promise<Date> {
    const data = await this.client.fetchFundingRate(symbol);
    return new Date(data.fundingDatetime ?? Date.now());
  }

  async getPrice(symbol: string): Promise<Ticker> {
    const ticker = await this.client.fetchTicker(symbol);
    return {
      exchange: "okx",
      symbol,
      last: ticker.last ?? 0,
      bid: ticker.bid ?? 0,
      ask: ticker.ask ?? 0,
      timestamp: new Date(ticker.timestamp ?? Date.now()),
    };
  }

  async getKline(symbol: string, timeframe: "1h" | "1d", limit: number): Promise<OHLCV[]> {
    const data = await this.client.fetchOHLCV(symbol, timeframe, undefined, limit);
    return data.map(([ts, o, h, l, c, v]) => ({
      timestamp: ts!, open: o!, high: h!, low: l!, close: c!, volume: v!,
    }));
  }

  async getBalances(): Promise<Balance[]> {
    const balance = await this.client.fetchBalance();
    return Object.entries(balance.total)
      .filter(([, total]) => (total as number) > 0)
      .map(([currency, total]) => ({
        currency,
        total: total as number,
        free: (balance.free[currency] as number) ?? 0,
        used: (balance.used[currency] as number) ?? 0,
      }));
  }

  async openPosition(params: OpenParams): Promise<Order> {
    const ccxtSide = params.side === "long" ? "buy" : "sell";
    await this.client.setLeverage(params.leverage, params.symbol);
    const order = await this.client.createOrder(
      params.symbol, "limit", ccxtSide, params.size, undefined,
      { clientOrderId: params.clientOrderId, timeInForce: "IOC" },
    );
    return this.mapOrder(order, params.side);
  }

  async closePosition(params: CloseParams): Promise<Order> {
    const ccxtSide = params.side === "long" ? "sell" : "buy";
    const order = await this.client.createOrder(
      params.symbol, "market", ccxtSide, params.size, undefined,
      { clientOrderId: params.clientOrderId, reduceOnly: true },
    );
    return this.mapOrder(order, params.side);
  }

  async getOrder(orderId: string): Promise<Order> {
    const order = await this.client.fetchOrder(orderId);
    return this.mapOrder(order, order.side === "buy" ? "long" : "short");
  }

  async getSymbols(): Promise<SymbolInfo[]> {
    const markets = await this.client.loadMarkets();
    return Object.values(markets)
      .filter((m) => m.swap && m.quote === "USDT")
      .map((m) => ({
        symbol: m.symbol, baseCurrency: m.base, quoteCurrency: m.quote,
        minSize: m.limits?.amount?.min ?? 0,
        pricePrecision: m.precision?.price ?? 2,
        sizePrecision: m.precision?.amount ?? 3,
      }));
  }

  async getFeeRate(): Promise<number> { return 0.0005; }

  async testConnection(): Promise<boolean> {
    try { await this.client.fetchBalance(); return true; } catch { return false; }
  }

  private mapOrder(order: any, side: "long" | "short"): Order {
    const filled = order.filled ?? 0;
    let status: Order["status"] = "failed";
    if (filled > 0 && filled >= (order.amount ?? 0)) status = "filled";
    else if (filled > 0) status = "partial";
    return {
      id: order.id, clientOrderId: order.clientOrderId ?? "",
      symbol: order.symbol, side, price: order.average ?? order.price ?? 0,
      filledSize: filled, fee: order.fee?.cost ?? 0, status,
      timestamp: new Date(order.timestamp ?? Date.now()),
    };
  }
}
```

Create `src/server/services/exchange/bybit.ts`:

```typescript
import ccxt, { type Exchange } from "ccxt";
import type {
  ExchangeAdapter, OpenParams, CloseParams, Order, SymbolInfo,
} from "./types";
import type { FundingRate, Ticker, Balance, OHLCV } from "@/lib/types";

export class BybitAdapter implements ExchangeAdapter {
  readonly name = "bybit" as const;
  private client: Exchange;

  constructor(apiKey: string, apiSecret: string) {
    this.client = new ccxt.bybit({
      apiKey, secret: apiSecret,
      options: { defaultType: "swap" },
    });
  }

  async getFundingRates(symbols: string[]): Promise<FundingRate[]> {
    const rates: FundingRate[] = [];
    for (const symbol of symbols) {
      const data = await this.client.fetchFundingRate(symbol);
      rates.push({
        exchange: "bybit", symbol,
        currentRate: data.fundingRate ?? 0,
        predictedRate: data.nextFundingRate ?? null,
        nextSettlement: new Date(data.fundingDatetime ?? Date.now()),
        intervalHours: 8,
        timestamp: new Date(data.datetime ?? Date.now()),
      });
    }
    return rates;
  }

  async getNextSettlementTime(symbol: string): Promise<Date> {
    const data = await this.client.fetchFundingRate(symbol);
    return new Date(data.fundingDatetime ?? Date.now());
  }

  async getPrice(symbol: string): Promise<Ticker> {
    const ticker = await this.client.fetchTicker(symbol);
    return {
      exchange: "bybit", symbol, last: ticker.last ?? 0,
      bid: ticker.bid ?? 0, ask: ticker.ask ?? 0,
      timestamp: new Date(ticker.timestamp ?? Date.now()),
    };
  }

  async getKline(symbol: string, timeframe: "1h" | "1d", limit: number): Promise<OHLCV[]> {
    const data = await this.client.fetchOHLCV(symbol, timeframe, undefined, limit);
    return data.map(([ts, o, h, l, c, v]) => ({
      timestamp: ts!, open: o!, high: h!, low: l!, close: c!, volume: v!,
    }));
  }

  async getBalances(): Promise<Balance[]> {
    const balance = await this.client.fetchBalance();
    return Object.entries(balance.total)
      .filter(([, total]) => (total as number) > 0)
      .map(([currency, total]) => ({
        currency, total: total as number,
        free: (balance.free[currency] as number) ?? 0,
        used: (balance.used[currency] as number) ?? 0,
      }));
  }

  async openPosition(params: OpenParams): Promise<Order> {
    const ccxtSide = params.side === "long" ? "buy" : "sell";
    await this.client.setLeverage(params.leverage, params.symbol);
    const order = await this.client.createOrder(
      params.symbol, "limit", ccxtSide, params.size, undefined,
      { clientOrderId: params.clientOrderId, timeInForce: "IOC" },
    );
    return this.mapOrder(order, params.side);
  }

  async closePosition(params: CloseParams): Promise<Order> {
    const ccxtSide = params.side === "long" ? "sell" : "buy";
    const order = await this.client.createOrder(
      params.symbol, "market", ccxtSide, params.size, undefined,
      { clientOrderId: params.clientOrderId, reduceOnly: true },
    );
    return this.mapOrder(order, params.side);
  }

  async getOrder(orderId: string): Promise<Order> {
    const order = await this.client.fetchOrder(orderId);
    return this.mapOrder(order, order.side === "buy" ? "long" : "short");
  }

  async getSymbols(): Promise<SymbolInfo[]> {
    const markets = await this.client.loadMarkets();
    return Object.values(markets)
      .filter((m) => m.swap && m.quote === "USDT")
      .map((m) => ({
        symbol: m.symbol, baseCurrency: m.base, quoteCurrency: m.quote,
        minSize: m.limits?.amount?.min ?? 0,
        pricePrecision: m.precision?.price ?? 2,
        sizePrecision: m.precision?.amount ?? 3,
      }));
  }

  async getFeeRate(): Promise<number> { return 0.0006; }

  async testConnection(): Promise<boolean> {
    try { await this.client.fetchBalance(); return true; } catch { return false; }
  }

  private mapOrder(order: any, side: "long" | "short"): Order {
    const filled = order.filled ?? 0;
    let status: Order["status"] = "failed";
    if (filled > 0 && filled >= (order.amount ?? 0)) status = "filled";
    else if (filled > 0) status = "partial";
    return {
      id: order.id, clientOrderId: order.clientOrderId ?? "",
      symbol: order.symbol, side, price: order.average ?? order.price ?? 0,
      filledSize: filled, fee: order.fee?.cost ?? 0, status,
      timestamp: new Date(order.timestamp ?? Date.now()),
    };
  }
}
```

Create `src/server/services/exchange/gateio.ts`:

```typescript
import ccxt, { type Exchange } from "ccxt";
import type {
  ExchangeAdapter, OpenParams, CloseParams, Order, SymbolInfo,
} from "./types";
import type { FundingRate, Ticker, Balance, OHLCV } from "@/lib/types";

export class GateioAdapter implements ExchangeAdapter {
  readonly name = "gateio" as const;
  private client: Exchange;

  constructor(apiKey: string, apiSecret: string) {
    this.client = new ccxt.gateio({
      apiKey, secret: apiSecret,
      options: { defaultType: "swap" },
    });
  }

  async getFundingRates(symbols: string[]): Promise<FundingRate[]> {
    const rates: FundingRate[] = [];
    for (const symbol of symbols) {
      const data = await this.client.fetchFundingRate(symbol);
      rates.push({
        exchange: "gateio", symbol,
        currentRate: data.fundingRate ?? 0,
        predictedRate: data.nextFundingRate ?? null,
        nextSettlement: new Date(data.fundingDatetime ?? Date.now()),
        intervalHours: 8,
        timestamp: new Date(data.datetime ?? Date.now()),
      });
    }
    return rates;
  }

  async getNextSettlementTime(symbol: string): Promise<Date> {
    const data = await this.client.fetchFundingRate(symbol);
    return new Date(data.fundingDatetime ?? Date.now());
  }

  async getPrice(symbol: string): Promise<Ticker> {
    const ticker = await this.client.fetchTicker(symbol);
    return {
      exchange: "gateio", symbol, last: ticker.last ?? 0,
      bid: ticker.bid ?? 0, ask: ticker.ask ?? 0,
      timestamp: new Date(ticker.timestamp ?? Date.now()),
    };
  }

  async getKline(symbol: string, timeframe: "1h" | "1d", limit: number): Promise<OHLCV[]> {
    const data = await this.client.fetchOHLCV(symbol, timeframe, undefined, limit);
    return data.map(([ts, o, h, l, c, v]) => ({
      timestamp: ts!, open: o!, high: h!, low: l!, close: c!, volume: v!,
    }));
  }

  async getBalances(): Promise<Balance[]> {
    const balance = await this.client.fetchBalance();
    return Object.entries(balance.total)
      .filter(([, total]) => (total as number) > 0)
      .map(([currency, total]) => ({
        currency, total: total as number,
        free: (balance.free[currency] as number) ?? 0,
        used: (balance.used[currency] as number) ?? 0,
      }));
  }

  async openPosition(params: OpenParams): Promise<Order> {
    const ccxtSide = params.side === "long" ? "buy" : "sell";
    await this.client.setLeverage(params.leverage, params.symbol);
    const order = await this.client.createOrder(
      params.symbol, "limit", ccxtSide, params.size, undefined,
      { clientOrderId: params.clientOrderId, timeInForce: "IOC" },
    );
    return this.mapOrder(order, params.side);
  }

  async closePosition(params: CloseParams): Promise<Order> {
    const ccxtSide = params.side === "long" ? "sell" : "buy";
    const order = await this.client.createOrder(
      params.symbol, "market", ccxtSide, params.size, undefined,
      { clientOrderId: params.clientOrderId, reduceOnly: true },
    );
    return this.mapOrder(order, params.side);
  }

  async getOrder(orderId: string): Promise<Order> {
    const order = await this.client.fetchOrder(orderId);
    return this.mapOrder(order, order.side === "buy" ? "long" : "short");
  }

  async getSymbols(): Promise<SymbolInfo[]> {
    const markets = await this.client.loadMarkets();
    return Object.values(markets)
      .filter((m) => m.swap && m.quote === "USDT")
      .map((m) => ({
        symbol: m.symbol, baseCurrency: m.base, quoteCurrency: m.quote,
        minSize: m.limits?.amount?.min ?? 0,
        pricePrecision: m.precision?.price ?? 2,
        sizePrecision: m.precision?.amount ?? 3,
      }));
  }

  async getFeeRate(): Promise<number> { return 0.00075; }

  async testConnection(): Promise<boolean> {
    try { await this.client.fetchBalance(); return true; } catch { return false; }
  }

  private mapOrder(order: any, side: "long" | "short"): Order {
    const filled = order.filled ?? 0;
    let status: Order["status"] = "failed";
    if (filled > 0 && filled >= (order.amount ?? 0)) status = "filled";
    else if (filled > 0) status = "partial";
    return {
      id: order.id, clientOrderId: order.clientOrderId ?? "",
      symbol: order.symbol, side, price: order.average ?? order.price ?? 0,
      filledSize: filled, fee: order.fee?.cost ?? 0, status,
      timestamp: new Date(order.timestamp ?? Date.now()),
    };
  }
}
```

- [ ] **Step 4: Create `src/server/services/exchange/factory.ts`**

```typescript
import type { ExchangeName } from "@/lib/constants";
import type { ExchangeAdapter } from "./types";
import { BinanceAdapter } from "./binance";
import { OkxAdapter } from "./okx";
import { BybitAdapter } from "./bybit";
import { GateioAdapter } from "./gateio";

export function createAdapter(
  name: ExchangeName,
  apiKey: string,
  apiSecret: string,
  passphrase?: string,
): ExchangeAdapter {
  switch (name) {
    case "binance":
      return new BinanceAdapter(apiKey, apiSecret);
    case "okx":
      return new OkxAdapter(apiKey, apiSecret, passphrase ?? undefined);
    case "bybit":
      return new BybitAdapter(apiKey, apiSecret);
    case "gateio":
      return new GateioAdapter(apiKey, apiSecret);
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add src/server/services/exchange/
git commit -m "feat: exchange adapter interface + Binance/OKX/Bybit/Gate.io implementations"
```

---

## Task 6: Funding Rate Collector + Opportunity Detector

**Files:**
- Create: `src/server/services/collector/funding-rate.ts`, `src/server/services/detector/opportunity.ts`, `tests/unit/detector.test.ts`, `tests/unit/collector.test.ts`

- [ ] **Step 1: Write failing tests for opportunity detector**

Create `tests/unit/detector.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { findOpportunities } from "@/server/services/detector/opportunity";
import type { FundingRate } from "@/lib/types";

const makeRate = (
  exchange: "binance" | "okx" | "bybit" | "gateio",
  symbol: string,
  rate: number,
): FundingRate => ({
  exchange,
  symbol,
  currentRate: rate,
  predictedRate: null,
  nextSettlement: new Date("2026-04-12T08:00:00Z"),
  intervalHours: 8,
  timestamp: new Date(),
});

describe("findOpportunities", () => {
  it("detects opportunity when rate spread exceeds threshold", () => {
    const rates = [
      makeRate("binance", "BTC/USDT:USDT", 0.0003),
      makeRate("okx", "BTC/USDT:USDT", 0.0001),
    ];

    const result = findOpportunities(rates, {
      minRateSpread: 0.0001,
      minAnnualizedYield: 0,
    });

    expect(result).toHaveLength(1);
    expect(result[0].shortExchange).toBe("binance"); // higher rate → short
    expect(result[0].longExchange).toBe("okx"); // lower rate → long
    expect(result[0].rateSpread).toBeCloseTo(0.0002);
  });

  it("returns empty when spread below threshold", () => {
    const rates = [
      makeRate("binance", "BTC/USDT:USDT", 0.00011),
      makeRate("okx", "BTC/USDT:USDT", 0.0001),
    ];

    const result = findOpportunities(rates, {
      minRateSpread: 0.0001,
      minAnnualizedYield: 0,
    });

    expect(result).toHaveLength(0);
  });

  it("finds the best pair among multiple exchanges", () => {
    const rates = [
      makeRate("binance", "ETH/USDT:USDT", 0.0005),
      makeRate("okx", "ETH/USDT:USDT", 0.0002),
      makeRate("bybit", "ETH/USDT:USDT", 0.0001),
    ];

    const result = findOpportunities(rates, {
      minRateSpread: 0.0001,
      minAnnualizedYield: 0,
    });

    // Best pair: binance (0.05%) short, bybit (0.01%) long → spread 0.04%
    const best = result[0];
    expect(best.shortExchange).toBe("binance");
    expect(best.longExchange).toBe("bybit");
    expect(best.rateSpread).toBeCloseTo(0.0004);
  });

  it("filters by minimum annualized yield", () => {
    const rates = [
      makeRate("binance", "BTC/USDT:USDT", 0.00015),
      makeRate("okx", "BTC/USDT:USDT", 0.0001),
    ];

    const result = findOpportunities(rates, {
      minRateSpread: 0,
      minAnnualizedYield: 0.20, // 20% — spread 0.005% annualizes to ~5.5%, below 20%
    });

    expect(result).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run tests/unit/detector.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server/services/detector/opportunity.ts`**

```typescript
import type { FundingRate, OpportunitySignal } from "@/lib/types";
import type { ExchangeName } from "@/lib/constants";
import { annualizedYield, rateSpread } from "@/lib/utils";

interface DetectorConfig {
  minRateSpread: number;
  minAnnualizedYield: number;
}

export function findOpportunities(
  rates: FundingRate[],
  config: DetectorConfig,
): OpportunitySignal[] {
  // Group by symbol
  const bySymbol = new Map<string, FundingRate[]>();
  for (const rate of rates) {
    const list = bySymbol.get(rate.symbol) ?? [];
    list.push(rate);
    bySymbol.set(rate.symbol, list);
  }

  const opportunities: OpportunitySignal[] = [];

  for (const [symbol, symbolRates] of bySymbol) {
    if (symbolRates.length < 2) continue;

    // Find max and min rate exchanges
    let maxRate = symbolRates[0];
    let minRate = symbolRates[0];

    for (const r of symbolRates) {
      if (r.currentRate > maxRate.currentRate) maxRate = r;
      if (r.currentRate < minRate.currentRate) minRate = r;
    }

    if (maxRate.exchange === minRate.exchange) continue;

    const spread = rateSpread(maxRate.currentRate, minRate.currentRate);
    if (spread < config.minRateSpread) continue;

    const intervalHours = maxRate.intervalHours;
    const yield_ = annualizedYield(spread, intervalHours);
    if (yield_ < config.minAnnualizedYield) continue;

    opportunities.push({
      symbol,
      longExchange: minRate.exchange,  // lower rate → go long (pay less)
      shortExchange: maxRate.exchange, // higher rate → go short (receive more)
      longRate: minRate.currentRate,
      shortRate: maxRate.currentRate,
      rateSpread: spread,
      annualizedYield: yield_,
      suggestedSize: 0, // Calculated by executor based on balance/risk
    });
  }

  // Sort by annualized yield descending
  return opportunities.sort((a, b) => b.annualizedYield - a.annualizedYield);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run tests/unit/detector.test.ts
```

Expected: All 4 tests PASS.

- [ ] **Step 5: Implement `src/server/services/collector/funding-rate.ts`**

```typescript
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import { createAdapter } from "@/server/services/exchange/factory";
import { decrypt } from "@/server/services/crypto/encryption";
import type { FundingRate } from "@/lib/types";

const DEFAULT_SYMBOLS = [
  "BTC/USDT:USDT",
  "ETH/USDT:USDT",
  "SOL/USDT:USDT",
  "BNB/USDT:USDT",
  "XRP/USDT:USDT",
];

export async function collectAllRates(): Promise<FundingRate[]> {
  const exchanges = await prisma.exchange.findMany({
    where: { isEnabled: true },
  });

  const allRates: FundingRate[] = [];

  const results = await Promise.allSettled(
    exchanges.map(async (ex) => {
      const adapter = createAdapter(
        ex.name as any,
        decrypt(ex.apiKey),
        decrypt(ex.apiSecret),
        ex.passphrase ? decrypt(ex.passphrase) : undefined,
      );
      return adapter.getFundingRates(DEFAULT_SYMBOLS);
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      allRates.push(...result.value);
    } else {
      console.error(
        `Failed to collect rates from ${exchanges[i].name}:`,
        result.reason,
      );
    }
  }

  // Store snapshots in DB
  if (allRates.length > 0) {
    const exchangeMap = new Map(exchanges.map((e) => [e.name, e.id]));

    await prisma.fundingRateSnapshot.createMany({
      data: allRates.map((r) => ({
        exchangeId: exchangeMap.get(r.exchange)!,
        symbol: r.symbol,
        currentRate: r.currentRate,
        predictedRate: r.predictedRate,
        nextSettlement: r.nextSettlement,
        intervalHours: r.intervalHours,
        collectedAt: r.timestamp,
      })),
    });

    // Update Redis cache
    const pipeline = redis.pipeline();
    for (const r of allRates) {
      pipeline.set(
        `rate:${r.exchange}:${r.symbol}`,
        JSON.stringify(r),
        "EX",
        600, // 10 min TTL
      );
    }
    await pipeline.exec();
  }

  return allRates;
}
```

- [ ] **Step 6: Commit**

```bash
git add src/server/services/collector/ src/server/services/detector/ tests/unit/detector.test.ts
git commit -m "feat: funding rate collector and opportunity detector with tests"
```

---

## Task 7: BullMQ Jobs (Rate Collection + Detection Pipeline)

**Files:**
- Create: `src/server/jobs/queues.ts`, `src/server/jobs/collect-rates.ts`, `src/server/jobs/worker.ts`

- [ ] **Step 1: Create `src/server/jobs/queues.ts`**

```typescript
import { Queue } from "bullmq";
import { redis } from "@/server/db/redis";

export const rateCollectionQueue = new Queue("rate-collection", {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 200,
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  },
});

export async function setupSchedulers() {
  // Remove existing repeatable jobs before adding
  const existing = await rateCollectionQueue.getRepeatableJobs();
  for (const job of existing) {
    await rateCollectionQueue.removeRepeatableByKey(job.key);
  }

  // Collect rates every 3 minutes
  await rateCollectionQueue.add(
    "collect",
    {},
    { repeat: { every: 180_000 } },
  );

  console.log("Job schedulers configured");
}
```

- [ ] **Step 2: Create `src/server/jobs/collect-rates.ts`**

```typescript
import { collectAllRates } from "@/server/services/collector/funding-rate";
import { findOpportunities } from "@/server/services/detector/opportunity";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";

export async function handleCollectRates() {
  console.log("[job] Collecting funding rates...");

  // 1. Collect rates from all exchanges
  const rates = await collectAllRates();
  console.log("[job] Collected %d rates", rates.length);

  if (rates.length === 0) return;

  // 2. Load detection config from settings
  const [minSpread, minYield] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "min_rate_spread" } }),
    prisma.setting.findUnique({ where: { key: "min_annualized_yield" } }),
  ]);

  const config = {
    minRateSpread: (minSpread?.value as number) ?? 0.0001,
    minAnnualizedYield: (minYield?.value as number) ?? 0.15,
  };

  // 3. Detect opportunities
  const opportunities = findOpportunities(rates, config);
  console.log("[job] Detected %d opportunities", opportunities.length);

  // 4. Store opportunities in DB
  const exchangeMap = new Map<string, string>();
  const exchanges = await prisma.exchange.findMany({
    where: { isEnabled: true },
    select: { id: true, name: true },
  });
  for (const ex of exchanges) exchangeMap.set(ex.name, ex.id);

  for (const opp of opportunities) {
    const longExId = exchangeMap.get(opp.longExchange);
    const shortExId = exchangeMap.get(opp.shortExchange);
    if (!longExId || !shortExId) continue;

    await prisma.opportunity.create({
      data: {
        symbol: opp.symbol,
        longExchangeId: longExId,
        shortExchangeId: shortExId,
        longRate: opp.longRate,
        shortRate: opp.shortRate,
        rateSpread: opp.rateSpread,
        annualizedYield: opp.annualizedYield,
        suggestedSize: opp.suggestedSize,
        status: "DETECTED",
        detectedAt: new Date(),
      },
    });
  }

  // 5. Cache latest opportunities for UI
  if (opportunities.length > 0) {
    await redis.set(
      "opportunity:latest",
      JSON.stringify(opportunities),
      "EX",
      600,
    );
  }
}
```

- [ ] **Step 3: Create `src/server/jobs/worker.ts`**

```typescript
import { Worker } from "bullmq";
import { redis } from "@/server/db/redis";
import { handleCollectRates } from "./collect-rates";

export function startWorker() {
  const worker = new Worker(
    "rate-collection",
    async (job) => {
      switch (job.name) {
        case "collect":
          await handleCollectRates();
          break;
        default:
          console.warn("[worker] Unknown job:", job.name);
      }
    },
    {
      connection: redis,
      concurrency: 1,
    },
  );

  worker.on("completed", (job) => {
    console.log("[worker] Job %s completed", job.id);
  });

  worker.on("failed", (job, err) => {
    console.error("[worker] Job %s failed:", job?.id, err.message);
  });

  console.log("BullMQ worker started");
  return worker;
}
```

- [ ] **Step 4: Bootstrap worker in Next.js instrumentation**

Create `src/instrumentation.ts`:

```typescript
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorker } = await import("@/server/jobs/worker");
    const { setupSchedulers } = await import("@/server/jobs/queues");
    startWorker();
    await setupSchedulers();
  }
}
```

Update `next.config.ts` to enable instrumentation:

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    instrumentationHook: true,
  },
};

export default nextConfig;
```

- [ ] **Step 5: Commit**

```bash
git add src/server/jobs/ src/instrumentation.ts next.config.ts
git commit -m "feat: BullMQ rate collection pipeline with scheduled jobs"
```

---

## Task 8: tRPC Setup + API Routers

**Files:**
- Create: `src/server/api/trpc.ts`, `src/server/api/root.ts`, `src/server/api/routers/exchange.ts`, `src/server/api/routers/opportunity.ts`, `src/server/api/routers/settings.ts`, `src/server/api/routers/dashboard.ts`, `src/app/api/trpc/[trpc]/route.ts`, `src/lib/trpc.ts`

- [ ] **Step 1: Create `src/server/api/trpc.ts`**

```typescript
import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";

export const createTRPCContext = async () => {
  return { prisma, redis };
};

const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
```

Add `superjson` dependency:

```bash
pnpm add superjson
```

- [ ] **Step 2: Create `src/server/api/routers/exchange.ts`**

```typescript
import { z } from "zod";
import { router, publicProcedure } from "../trpc";
import { encrypt, decrypt, maskKey } from "@/server/services/crypto/encryption";
import { createAdapter } from "@/server/services/exchange/factory";
import { EXCHANGE_NAMES } from "@/lib/constants";

export const exchangeRouter = router({
  list: publicProcedure.query(async ({ ctx }) => {
    const exchanges = await ctx.prisma.exchange.findMany({
      orderBy: { name: "asc" },
    });
    return exchanges.map((ex) => ({
      ...ex,
      apiKey: maskKey(decrypt(ex.apiKey)),
      apiSecret: "********",
      passphrase: ex.passphrase ? "********" : null,
    }));
  }),

  create: publicProcedure
    .input(
      z.object({
        name: z.enum(EXCHANGE_NAMES),
        apiKey: z.string().min(1),
        apiSecret: z.string().min(1),
        passphrase: z.string().optional(),
        feeRate: z.number().min(0).max(0.01).default(0.001),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.exchange.create({
        data: {
          name: input.name,
          apiKey: encrypt(input.apiKey),
          apiSecret: encrypt(input.apiSecret),
          passphrase: input.passphrase ? encrypt(input.passphrase) : null,
          feeRate: input.feeRate,
        },
      });
    }),

  testConnection: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const ex = await ctx.prisma.exchange.findUniqueOrThrow({
        where: { id: input.id },
      });
      const adapter = createAdapter(
        ex.name as any,
        decrypt(ex.apiKey),
        decrypt(ex.apiSecret),
        ex.passphrase ? decrypt(ex.passphrase) : undefined,
      );
      return { success: await adapter.testConnection() };
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.exchange.delete({ where: { id: input.id } });
    }),

  toggleEnabled: publicProcedure
    .input(z.object({ id: z.string().uuid(), isEnabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.exchange.update({
        where: { id: input.id },
        data: { isEnabled: input.isEnabled },
      });
    }),
});
```

- [ ] **Step 3: Create `src/server/api/routers/opportunity.ts`**

```typescript
import { z } from "zod";
import { router, publicProcedure } from "../trpc";

export const opportunityRouter = router({
  list: publicProcedure
    .input(
      z.object({
        status: z.enum(["DETECTED", "NOTIFIED", "ACCEPTED", "REJECTED", "EXPIRED"]).optional(),
        limit: z.number().min(1).max(100).default(50),
      }).default({}),
    )
    .query(async ({ ctx, input }) => {
      return ctx.prisma.opportunity.findMany({
        where: input.status ? { status: input.status } : undefined,
        include: {
          longExchange: { select: { id: true, name: true } },
          shortExchange: { select: { id: true, name: true } },
        },
        orderBy: { detectedAt: "desc" },
        take: input.limit,
      });
    }),

  latestRates: publicProcedure.query(async ({ ctx }) => {
    const cached = await ctx.redis.get("opportunity:latest");
    return cached ? JSON.parse(cached) : [];
  }),
});
```

- [ ] **Step 4: Create `src/server/api/routers/settings.ts`**

```typescript
import { z } from "zod";
import { router, publicProcedure } from "../trpc";

export const settingsRouter = router({
  getAll: publicProcedure.query(async ({ ctx }) => {
    const settings = await ctx.prisma.setting.findMany();
    return Object.fromEntries(settings.map((s) => [s.key, s.value]));
  }),

  get: publicProcedure
    .input(z.object({ key: z.string() }))
    .query(async ({ ctx, input }) => {
      const setting = await ctx.prisma.setting.findUnique({
        where: { key: input.key },
      });
      return setting?.value ?? null;
    }),

  set: publicProcedure
    .input(z.object({ key: z.string(), value: z.any() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.setting.upsert({
        where: { key: input.key },
        update: { value: input.value },
        create: {
          key: input.key,
          value: input.value,
          description: "",
        },
      });
    }),
});
```

- [ ] **Step 5: Create `src/server/api/routers/dashboard.ts`**

```typescript
import { router, publicProcedure } from "../trpc";

export const dashboardRouter = router({
  overview: publicProcedure.query(async ({ ctx }) => {
    const [openPositions, todayOpportunities] = await Promise.all([
      ctx.prisma.position.count({ where: { status: "OPEN" } }),
      ctx.prisma.opportunity.count({
        where: {
          detectedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      }),
    ]);

    return {
      openPositions,
      todayOpportunities,
    };
  }),
});
```

- [ ] **Step 6: Create `src/server/api/root.ts`**

```typescript
import { router } from "./trpc";
import { exchangeRouter } from "./routers/exchange";
import { opportunityRouter } from "./routers/opportunity";
import { settingsRouter } from "./routers/settings";
import { dashboardRouter } from "./routers/dashboard";

export const appRouter = router({
  exchange: exchangeRouter,
  opportunity: opportunityRouter,
  settings: settingsRouter,
  dashboard: dashboardRouter,
});

export type AppRouter = typeof appRouter;
```

- [ ] **Step 7: Create `src/app/api/trpc/[trpc]/route.ts`**

```typescript
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/api/root";
import { createTRPCContext } from "@/server/api/trpc";

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: createTRPCContext,
  });

export { handler as GET, handler as POST };
```

- [ ] **Step 8: Create `src/lib/trpc.ts` (client hooks)**

```typescript
"use client";

import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@/server/api/root";

export const trpc = createTRPCReact<AppRouter>();
```

- [ ] **Step 9: Commit**

```bash
git add src/server/api/ src/app/api/ src/lib/trpc.ts
git commit -m "feat: tRPC setup with exchange, opportunity, settings, dashboard routers"
```

---

## Task 9: Theme System + UI Shell (Dark/Light)

**Files:**
- Create: `src/app/globals.css` (overwrite), `src/components/theme-provider.tsx`, `src/components/theme-toggle.tsx`, `src/components/layout/sidebar.tsx`, `src/components/layout/header.tsx`, `src/app/layout.tsx` (overwrite), `src/app/(dashboard)/layout.tsx`

- [ ] **Step 1: Install shadcn/ui and required components**

```bash
pnpm dlx shadcn@latest init
pnpm dlx shadcn@latest add button card table input label dialog badge tabs separator dropdown-menu
pnpm add next-themes
```

- [ ] **Step 2: Create `src/app/globals.css` with DESIGN.md tokens**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    /* Light theme — Coinbase-inspired */
    --background: 0 0% 100%;
    --foreground: 0 0% 9%;
    --card: 0 0% 98%;
    --card-foreground: 0 0% 9%;
    --popover: 0 0% 100%;
    --popover-foreground: 0 0% 9%;
    --primary: 224 93% 51%;      /* #1652F0 */
    --primary-foreground: 0 0% 100%;
    --secondary: 220 9% 94%;
    --secondary-foreground: 220 9% 20%;
    --muted: 220 9% 94%;
    --muted-foreground: 220 6% 53%;
    --accent: 220 9% 94%;
    --accent-foreground: 220 9% 20%;
    --destructive: 4 100% 59%;   /* #FF3B30 */
    --destructive-foreground: 0 0% 100%;
    --border: 220 9% 87%;
    --input: 220 9% 87%;
    --ring: 224 93% 51%;
    --radius: 0.5rem;

    --positive: 156 100% 41%;    /* #00D180 */
    --negative: 4 100% 59%;      /* #FF3B30 */
    --warning: 46 100% 50%;      /* #FFC801 */
  }

  .dark {
    --background: 225 14% 4%;     /* #0A0B0D */
    --foreground: 240 5% 96%;     /* #F5F5F7 */
    --card: 228 8% 7%;            /* #111214 */
    --card-foreground: 240 5% 96%;
    --popover: 230 10% 11%;       /* #1A1B1F */
    --popover-foreground: 240 5% 96%;
    --primary: 224 93% 51%;       /* #1652F0 */
    --primary-foreground: 0 0% 100%;
    --secondary: 230 10% 11%;
    --secondary-foreground: 240 5% 96%;
    --muted: 230 10% 11%;
    --muted-foreground: 223 5% 56%; /* #8A8F98 */
    --accent: 230 10% 11%;
    --accent-foreground: 240 5% 96%;
    --destructive: 4 100% 59%;
    --destructive-foreground: 0 0% 100%;
    --border: 232 10% 18%;        /* #2A2B33 */
    --input: 230 10% 11%;
    --ring: 224 93% 51%;

    --positive: 156 100% 41%;
    --negative: 4 100% 59%;
    --warning: 46 100% 50%;
  }
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
    font-feature-settings: "rlig" 1, "calt" 1;
  }
}
```

- [ ] **Step 3: Create `src/components/theme-provider.tsx`**

```tsx
"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
```

- [ ] **Step 4: Create `src/components/theme-toggle.tsx`**

```tsx
"use client";

import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
    >
      <span className="dark:hidden">Dark</span>
      <span className="hidden dark:inline">Light</span>
    </Button>
  );
}
```

- [ ] **Step 5: Create `src/components/layout/sidebar.tsx`**

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: "D" },
  { href: "/opportunities", label: "Opportunities", icon: "O" },
  { href: "/positions", label: "Positions", icon: "P" },
  { href: "/backtest", label: "Backtest", icon: "B" },
  { href: "/settings", label: "Settings", icon: "S" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden md:flex md:w-60 flex-col border-r border-border bg-background">
      <div className="p-4 font-semibold text-lg">Arbitrage</div>
      <nav className="flex-1 px-2 space-y-1">
        {NAV_ITEMS.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <span className="w-5 text-center">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
```

Note: Add `cn` to `src/lib/utils.ts` if shadcn/ui init didn't add it:

```typescript
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 6: Create `src/components/layout/header.tsx`**

```tsx
import { ThemeToggle } from "@/components/theme-toggle";

export function Header() {
  return (
    <header className="flex items-center justify-end h-14 px-6 border-b border-border">
      <ThemeToggle />
    </header>
  );
}
```

- [ ] **Step 7: Create tRPC provider**

Create `src/components/trpc-provider.tsx`:

```tsx
"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { useState } from "react";
import superjson from "superjson";
import { trpc } from "@/lib/trpc";

export function TRPCProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: "/api/trpc",
          transformer: superjson,
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
```

- [ ] **Step 8: Overwrite `src/app/layout.tsx`**

```tsx
import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { TRPCProvider } from "@/components/trpc-provider";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Funding Rate Arbitrage",
  description: "CEX-CEX funding rate arbitrage management platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} ${jetbrainsMono.variable} font-sans`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem={false}
        >
          <TRPCProvider>{children}</TRPCProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 9: Create `src/app/(dashboard)/layout.tsx`**

```tsx
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
```

- [ ] **Step 10: Create placeholder pages**

`src/app/(dashboard)/page.tsx`:
```tsx
export default function DashboardPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="text-muted-foreground mt-2">Overview coming in Plan 2.</p>
    </div>
  );
}
```

`src/app/(dashboard)/positions/page.tsx`:
```tsx
export default function PositionsPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Positions</h1>
      <p className="text-muted-foreground mt-2">Position management coming in Plan 2.</p>
    </div>
  );
}
```

`src/app/(dashboard)/backtest/page.tsx`:
```tsx
export default function BacktestPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Backtest</h1>
      <p className="text-muted-foreground mt-2">Backtesting coming in Plan 3.</p>
    </div>
  );
}
```

- [ ] **Step 11: Start dev server and verify**

```bash
pnpm dev
```

Open http://localhost:3000. Expected:
- Dark theme by default
- Sidebar with 5 nav items, active state highlighted
- Theme toggle switches between dark/light
- All placeholder pages accessible

- [ ] **Step 12: Commit**

```bash
git add src/app/ src/components/ src/lib/
git commit -m "feat: UI shell with sidebar, dark/light theme, tRPC provider"
```

---

## Task 10: Settings Page (Exchange Config + Strategy Params)

**Files:**
- Create: `src/app/(dashboard)/settings/page.tsx`, `src/components/settings/exchange-form.tsx`, `src/components/settings/params-form.tsx`

- [ ] **Step 1: Create `src/components/settings/exchange-form.tsx`**

```tsx
"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EXCHANGE_NAMES, type ExchangeName } from "@/lib/constants";

export function ExchangeForm() {
  const utils = trpc.useUtils();
  const { data: exchanges, isLoading } = trpc.exchange.list.useQuery();
  const createMutation = trpc.exchange.create.useMutation({
    onSuccess: () => utils.exchange.list.invalidate(),
  });
  const testMutation = trpc.exchange.testConnection.useMutation();
  const deleteMutation = trpc.exchange.delete.useMutation({
    onSuccess: () => utils.exchange.list.invalidate(),
  });

  const [form, setForm] = useState({
    name: "binance" as ExchangeName,
    apiKey: "",
    apiSecret: "",
    passphrase: "",
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate({
      name: form.name,
      apiKey: form.apiKey,
      apiSecret: form.apiSecret,
      passphrase: form.passphrase || undefined,
    });
    setForm({ name: "binance", apiKey: "", apiSecret: "", passphrase: "" });
  };

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <h3 className="text-lg font-semibold mb-4">Add Exchange</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <Label>Exchange</Label>
            <select
              className="w-full mt-1 rounded-lg border border-border bg-input px-3 py-2 text-sm"
              value={form.name}
              onChange={(e) =>
                setForm({ ...form, name: e.target.value as ExchangeName })
              }
            >
              {EXCHANGE_NAMES.map((n) => (
                <option key={n} value={n}>
                  {n.charAt(0).toUpperCase() + n.slice(1)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>API Key</Label>
            <Input
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            />
          </div>
          <div>
            <Label>API Secret</Label>
            <Input
              type="password"
              value={form.apiSecret}
              onChange={(e) => setForm({ ...form, apiSecret: e.target.value })}
            />
          </div>
          {form.name === "okx" && (
            <div>
              <Label>Passphrase</Label>
              <Input
                type="password"
                value={form.passphrase}
                onChange={(e) =>
                  setForm({ ...form, passphrase: e.target.value })
                }
              />
            </div>
          )}
          <Button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? "Adding..." : "Add Exchange"}
          </Button>
        </form>
      </Card>

      <Card className="p-6">
        <h3 className="text-lg font-semibold mb-4">Configured Exchanges</h3>
        {isLoading ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : !exchanges?.length ? (
          <p className="text-muted-foreground">No exchanges configured.</p>
        ) : (
          <div className="space-y-3">
            {exchanges.map((ex) => (
              <div
                key={ex.id}
                className="flex items-center justify-between p-3 rounded-lg border border-border"
              >
                <div>
                  <span className="font-medium">{ex.name}</span>
                  <span className="ml-3 text-sm text-muted-foreground font-mono">
                    {ex.apiKey}
                  </span>
                  <Badge
                    variant={ex.isEnabled ? "default" : "secondary"}
                    className="ml-3"
                  >
                    {ex.isEnabled ? "Enabled" : "Disabled"}
                  </Badge>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => testMutation.mutate({ id: ex.id })}
                    disabled={testMutation.isPending}
                  >
                    {testMutation.isPending ? "Testing..." : "Test"}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => deleteMutation.mutate({ id: ex.id })}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Create `src/components/settings/params-form.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";

const PARAM_LABELS: Record<string, { label: string; suffix: string }> = {
  min_rate_spread: { label: "Min Rate Spread", suffix: "%" },
  min_annualized_yield: { label: "Min Annualized Yield", suffix: "%" },
  max_leverage: { label: "Max Leverage", suffix: "x" },
  safety_margin_ratio: { label: "Margin Safety Buffer", suffix: "%" },
  max_single_position: { label: "Max Single Position", suffix: "%" },
  max_single_leg_exposure: { label: "Max Single Leg Exposure", suffix: "USDT" },
  volatility_threshold_1h: { label: "1h Volatility Threshold", suffix: "%" },
  volatility_threshold_24h: { label: "24h Volatility Threshold", suffix: "%" },
};

export function ParamsForm() {
  const { data: settings, isLoading } = trpc.settings.getAll.useQuery();
  const utils = trpc.useUtils();
  const setMutation = trpc.settings.set.useMutation({
    onSuccess: () => utils.settings.getAll.invalidate(),
  });

  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (settings) {
      const v: Record<string, string> = {};
      for (const [key, val] of Object.entries(settings)) {
        if (key in PARAM_LABELS) {
          // Display as percentage where applicable
          const isPercent = PARAM_LABELS[key].suffix === "%";
          v[key] = isPercent ? String(Number(val) * 100) : String(val);
        }
      }
      setValues(v);
    }
  }, [settings]);

  const handleSave = (key: string) => {
    const isPercent = PARAM_LABELS[key].suffix === "%";
    const raw = parseFloat(values[key]);
    const value = isPercent ? raw / 100 : raw;
    setMutation.mutate({ key, value });
  };

  if (isLoading) return <p className="text-muted-foreground">Loading...</p>;

  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold mb-4">Strategy Parameters</h3>
      <div className="grid gap-4 md:grid-cols-2">
        {Object.entries(PARAM_LABELS).map(([key, { label, suffix }]) => (
          <div key={key}>
            <Label>{label}</Label>
            <div className="flex gap-2 mt-1">
              <Input
                value={values[key] ?? ""}
                onChange={(e) =>
                  setValues({ ...values, [key]: e.target.value })
                }
              />
              <span className="flex items-center text-sm text-muted-foreground min-w-[40px]">
                {suffix}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleSave(key)}
                disabled={setMutation.isPending}
              >
                Save
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
```

- [ ] **Step 3: Create `src/app/(dashboard)/settings/page.tsx`**

```tsx
import { ExchangeForm } from "@/components/settings/exchange-form";
import { ParamsForm } from "@/components/settings/params-form";

export default function SettingsPage() {
  return (
    <div className="space-y-8 max-w-4xl">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <ExchangeForm />
      <ParamsForm />
    </div>
  );
}
```

- [ ] **Step 4: Start dev server and verify**

```bash
pnpm dev
```

Navigate to http://localhost:3000/settings. Expected:
- Exchange form with dropdown, API key/secret inputs, OKX shows passphrase field
- Strategy params display with current values from DB seed
- Add/test/delete exchange works (test will fail without real keys — that's OK)
- Save parameter changes and reload — values persist

- [ ] **Step 5: Commit**

```bash
git add src/app/\(dashboard\)/settings/ src/components/settings/
git commit -m "feat: settings page with exchange config and strategy parameters"
```

---

## Task 11: Opportunities Page (Real-Time Rate Table)

**Files:**
- Create: `src/app/(dashboard)/opportunities/page.tsx`, `src/components/opportunities/rate-table.tsx`, `src/components/opportunities/opportunity-card.tsx`

- [ ] **Step 1: Create `src/components/opportunities/rate-table.tsx`**

```tsx
"use client";

import { trpc } from "@/lib/trpc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatRate } from "@/lib/utils";

export function RateTable() {
  const { data: rates, isLoading } = trpc.opportunity.latestRates.useQuery(
    undefined,
    { refetchInterval: 30_000 },
  );

  if (isLoading) return <p className="text-muted-foreground">Loading rates...</p>;
  if (!rates?.length) return <p className="text-muted-foreground">No rate data yet. Configure exchanges in Settings first.</p>;

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Symbol</TableHead>
            <TableHead className="text-right">Long Exchange</TableHead>
            <TableHead className="text-right">Long Rate</TableHead>
            <TableHead className="text-right">Short Exchange</TableHead>
            <TableHead className="text-right">Short Rate</TableHead>
            <TableHead className="text-right">Spread</TableHead>
            <TableHead className="text-right">Annual Yield</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rates.map((r: any, i: number) => (
            <TableRow key={i}>
              <TableCell className="font-medium">{r.symbol}</TableCell>
              <TableCell className="text-right">{r.longExchange}</TableCell>
              <TableCell className="text-right font-mono text-[hsl(var(--positive))]">
                {formatRate(r.longRate)}
              </TableCell>
              <TableCell className="text-right">{r.shortExchange}</TableCell>
              <TableCell className="text-right font-mono text-[hsl(var(--negative))]">
                {formatRate(r.shortRate)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatRate(r.rateSpread)}
              </TableCell>
              <TableCell className="text-right font-mono font-medium">
                {(r.annualizedYield * 100).toFixed(1)}%
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 2: Create `src/components/opportunities/opportunity-card.tsx`**

```tsx
"use client";

import { trpc } from "@/lib/trpc";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatRate } from "@/lib/utils";

export function OpportunityList() {
  const { data: opportunities, isLoading } = trpc.opportunity.list.useQuery(
    { status: "DETECTED", limit: 20 },
    { refetchInterval: 30_000 },
  );

  if (isLoading) return <p className="text-muted-foreground">Loading...</p>;
  if (!opportunities?.length)
    return <p className="text-muted-foreground">No opportunities detected yet.</p>;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {opportunities.map((opp) => (
        <Card key={opp.id} className="p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="font-semibold">{opp.symbol}</span>
            <Badge className="bg-[hsl(var(--positive))]/10 text-[hsl(var(--positive))]">
              {(Number(opp.annualizedYield) * 100).toFixed(1)}% APY
            </Badge>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-muted-foreground">Long</span>
              <div className="font-medium">{opp.longExchange.name}</div>
              <div className="font-mono text-[hsl(var(--positive))]">
                {formatRate(Number(opp.longRate))}
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">Short</span>
              <div className="font-medium">{opp.shortExchange.name}</div>
              <div className="font-mono text-[hsl(var(--negative))]">
                {formatRate(Number(opp.shortRate))}
              </div>
            </div>
          </div>
          <div className="mt-3 text-sm text-muted-foreground">
            Spread: <span className="font-mono">{formatRate(Number(opp.rateSpread))}</span>
          </div>
          <Button className="w-full mt-4" variant="default" disabled>
            Open Position (Plan 2)
          </Button>
        </Card>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Create `src/app/(dashboard)/opportunities/page.tsx`**

```tsx
import { RateTable } from "@/components/opportunities/rate-table";
import { OpportunityList } from "@/components/opportunities/opportunity-card";

export default function OpportunitiesPage() {
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Opportunities</h1>
      <section>
        <h2 className="text-lg font-medium mb-4">Detected Opportunities</h2>
        <OpportunityList />
      </section>
      <section>
        <h2 className="text-lg font-medium mb-4">Latest Funding Rates</h2>
        <RateTable />
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Start dev server and verify**

```bash
pnpm dev
```

Navigate to http://localhost:3000/opportunities. Expected:
- "No opportunities detected yet" (until exchanges are configured and jobs run)
- "No rate data yet" for the rate table
- Layout, typography, and colors match DESIGN.md
- Dark/light theme both render correctly

- [ ] **Step 5: Commit**

```bash
git add src/app/\(dashboard\)/opportunities/ src/components/opportunities/
git commit -m "feat: opportunities page with rate table and opportunity cards"
```

---

## Task 12: End-to-End Smoke Test

- [ ] **Step 1: Start all services**

```bash
docker compose up -d postgres redis
pnpm dev
```

- [ ] **Step 2: Seed database**

```bash
pnpm tsx src/server/db/seed.ts
```

- [ ] **Step 3: Walk through the app**

1. Open http://localhost:3000 → redirects to Dashboard
2. Navigate to Settings → add a test exchange (can use invalid keys for now)
3. Navigate to Opportunities → shows empty state
4. Switch theme dark ↔ light → both render correctly
5. Navigate to Positions, Backtest → placeholder pages render

- [ ] **Step 4: Verify BullMQ worker starts**

Check server logs for:
```
BullMQ worker started
Job schedulers configured
```

If exchanges have valid API keys, after ~3 minutes you should see:
```
[job] Collecting funding rates...
[job] Collected N rates
[job] Detected N opportunities
```

- [ ] **Step 5: Run all tests**

```bash
pnpm vitest run
```

Expected: All unit tests pass (utils, encryption, detector).

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: Plan 1 complete — foundation, data collection, UI shell"
```

---

## Spec Coverage Checklist

| Spec Section | Covered By |
|---|---|
| 二、技术栈 | Task 1 (scaffold), Task 2 (Prisma/PG/Redis) |
| 三、架构 (单体 + Docker) | Task 1 |
| 四、数据模型 (all tables) | Task 2 |
| 五.1 目录结构 | All tasks |
| 五.2 ExchangeAdapter 接口 | Task 5 |
| 五.3 数据流 (采集→检测) | Task 6, 7 |
| 六、页面 (Settings) | Task 10 |
| 六、页面 (Opportunities) | Task 11 |
| 六、页面 (placeholders) | Task 9 |
| 八、Docker (dev compose) | Task 1 |
| 八.2 热加载 | Task 1 (Dockerfile.dev) |
| 十一、配置参数 | Task 2 (seed) |
| 十二、交易所 (4 adapters) | Task 5 |
| 十四.2 API 密钥加密 | Task 4 |
| DESIGN.md 暗色+亮色 | Task 9 |

**Not in Plan 1 scope (deferred to Plan 2 & 3):**
- Trade execution, positions, settlements (Plan 2)
- Health check, volatility pause, Telegram (Plan 2)
- Backtest, history backfill, archive (Plan 3)
- CI/CD, production Docker, GitHub Actions (Plan 3)
