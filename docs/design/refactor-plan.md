# UI Refactor Plan

> Based on Pencil mockups in `docs/design/mockups/`
> Target: align `src/components/` and `src/app/(dashboard)/` with the new design system

## Scope

Refactor existing Next.js components to match the Pencil mockups. Prioritize high-impact, backend-ready pages (Settings, Opportunities, Sidebar) and leave Dashboard/Positions/Backtest for later Plans since they depend on Plan 2/3 data.

## Pass 1 — Design tokens

**File:** `src/app/globals.css`

Align CSS variables exactly with Pencil tokens:
- `--background` = `#0A0B0D`
- `--card` = `#111214`
- `--muted` = `#1A1B1F`
- `--border` = `#2A2B33`
- `--foreground` = `#F5F5F7`
- `--muted-foreground` = `#8A8F98`
- `--primary` = `#1652F0`
- `--positive` = `#00D180`
- `--negative` = `#FF3B30`
- `--warning` = `#FFC801`

Add monospace font via `next/font/google` → `JetBrains Mono` as `--font-mono`.

## Pass 2 — Layout shell

**Files:** `src/components/layout/sidebar.tsx`, `header.tsx`, `src/app/(dashboard)/layout.tsx`

Match Pencil's sidebar structure:
- Brand: blue square icon (Lucide `Zap`) + "Arbitrage" text, 28px square icon
- Section labels: "OVERVIEW" / "TOOLS", uppercase 10px tracking
- Nav items with Lucide icons: `LayoutDashboard`, `Target`, `Layers`, `History`, `Settings`
- Active state: `bg-primary/10` + `text-primary`, full rounded rect
- Footer: worker status card with pulsing dot + "Worker online" + "Last tick 2s ago"

Header:
- Page title (16px/600)
- Right side: LIVE badge + time range toggle (24h/7d/30d/All) + Export button
- 56px height, bottom border

## Pass 3 — Reusable primitives

**New files under `src/components/ui/`**:
- `stat-card.tsx` — label, value (mono), delta row with icon
- `badge-variants.tsx` — positive / negative / warning / info / neutral color variants
- `section-card.tsx` — card with header (title + subtitle + action) and body slot
- `data-table.tsx` — dense table with mono numeric columns, right-aligned values

## Pass 4 — Settings page

**Files:** `src/app/(dashboard)/settings/page.tsx`, `src/components/settings/*`

Replace current implementation with:
- Left vertical tab nav (Exchanges / Strategy / Risk / Notifications / Account)
- Exchange Connections section: list of 4 exchange rows with logo letter, status badge, balance, latency, icon action buttons (test/edit/delete)
- Strategy Parameters section: grid of 6 parameter cards
- "Add exchange connection" dashed-border button
- Footer save row with timestamp

## Pass 5 — Opportunities page

**Files:** `src/app/(dashboard)/opportunities/page.tsx`, `src/components/opportunities/*`

Replace with:
- Header: refresh timestamp + filter chips + primary action
- Main left: Funding Rate Matrix card (8-symbol table with 4 exchange columns + spread + APY badge)
  - Lowest rate per row rendered dimmed to highlight the best long leg
  - Spread/APY right-aligned mono
- Right sidebar: Top Opportunities card (3-4 ranked cards with LONG/SHORT flow) + Market Overview stats

## Pass 6 — Placeholder pages

Update Dashboard / Positions / Backtest pages to show a coherent "Coming in Plan 2/3" empty state that matches the new design system (card + icon + message + timeline hint).

## Out of scope (deferred)

- Recharts integration for Dashboard P&L curve
- Position card expand/collapse with settlement history
- Backtest parameter form with live preview
- Real-time WebSocket subscriptions
- Theme switch polish

These come after Plan 1 extensions or as part of Plan 2.

## Verification

After each pass:
1. `pnpm tsc --noEmit`
2. `pnpm test`
3. `pnpm build`
4. Spot-check the page in a real browser and compare to the mockup PNG.
