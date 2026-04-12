"use client";

import { trpc } from "@/lib/trpc";
import { SectionCard } from "@/components/ui/section-card";
import { ToneBadge } from "@/components/ui/tone-badge";
import { cn } from "@/lib/utils";

// Placeholder rows rendered only when the query returns empty data.
// Remove or gate this once the backend supplies real rate matrix data.
const NO_DATA_PLACEHOLDER = [
  { symbol: "BTC/USDT", rates: { binance: 0.0001, okx: -0.0002, bybit: 0.00015, gateio: -0.0001 } },
  { symbol: "ETH/USDT", rates: { binance: 0.00008, okx: 0.0003, bybit: -0.0001, gateio: 0.0002 } },
  { symbol: "SOL/USDT", rates: { binance: 0.0002, okx: -0.0003, bybit: 0.00025, gateio: -0.00015 } },
  { symbol: "BNB/USDT", rates: { binance: 0.00015, okx: 0.0001, bybit: -0.0002, gateio: 0.00018 } },
  { symbol: "XRP/USDT", rates: { binance: -0.0001, okx: 0.00025, bybit: 0.0003, gateio: -0.0002 } },
  { symbol: "DOGE/USDT", rates: { binance: 0.0003, okx: -0.00015, bybit: 0.0001, gateio: 0.00022 } },
  { symbol: "ADA/USDT", rates: { binance: 0.00012, okx: 0.0002, bybit: -0.00025, gateio: 0.0003 } },
  { symbol: "AVAX/USDT", rates: { binance: -0.0002, okx: 0.00018, bybit: 0.0002, gateio: -0.0001 } },
];

const EXCHANGES = ["binance", "okx", "bybit", "gateio"] as const;

interface RateRow {
  symbol: string;
  rates: Partial<Record<string, number>>;
  spread: number;
  apy: number;
}

function buildRows(rawRates: Array<{ symbol: string; exchange: string; rate: number }>): RateRow[] {
  const bySymbol = new Map<string, Partial<Record<string, number>>>();
  for (const r of rawRates) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, {});
    bySymbol.get(r.symbol)![r.exchange] = r.rate;
  }
  return Array.from(bySymbol.entries()).map(([symbol, rates]) => {
    const vals = Object.values(rates).filter((v): v is number => v !== undefined);
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    const spread = max - min;
    const apy = spread * 3 * 365 * 100; // 3 settlements/day estimate
    return { symbol, rates, spread, apy };
  });
}

function buildPlaceholderRows(): RateRow[] {
  return NO_DATA_PLACEHOLDER.map(({ symbol, rates }) => {
    const vals = Object.values(rates);
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    const spread = max - min;
    const apy = spread * 3 * 365 * 100;
    return { symbol, rates, spread, apy };
  });
}

export function RateTable() {
  const { data: rawRates, isLoading } = trpc.opportunity.latestRates.useQuery(
    undefined,
    { refetchInterval: 30_000 },
  );

  const rows: RateRow[] =
    rawRates && rawRates.length > 0
      ? buildRows(rawRates as Array<{ symbol: string; exchange: string; rate: number }>)
      : buildPlaceholderRows();

  const isPlaceholder = !rawRates || rawRates.length === 0;

  return (
    <SectionCard
      title="Funding Rate Matrix"
      subtitle={`Current rates · ${rows.length} symbols · ${EXCHANGES.length} exchanges`}
      action={
        <ToneBadge tone="info">
          {rows.length} symbols · {EXCHANGES.length} exchanges
        </ToneBadge>
      }
      bodyClassName="p-0"
    >
      {isLoading ? (
        <p className="p-6 text-sm text-muted-foreground">Loading rates...</p>
      ) : (
        <div className="-mx-0 overflow-hidden rounded-b-xl">
          {/* Header */}
          <div className="grid bg-muted px-5 py-2.5" style={{ gridTemplateColumns: "96px 1fr 1fr 1fr 1fr 92px 80px" }}>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Symbol
            </span>
            {EXCHANGES.map((ex) => (
              <span
                key={ex}
                className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground text-right"
              >
                {ex.charAt(0).toUpperCase() + ex.slice(1)}
              </span>
            ))}
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground text-right">
              Spread
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground text-right">
              APY
            </span>
          </div>

          {/* Rows */}
          {rows.map((row, i) => {
            const rateValues = EXCHANGES.map((ex) => row.rates[ex] ?? null).filter(
              (v): v is number => v !== null,
            );
            const minRate = rateValues.length ? Math.min(...rateValues) : null;

            return (
              <div
                key={row.symbol}
                className={cn(
                  "grid px-5 py-3 hover:bg-muted/50 transition-colors",
                  i < rows.length - 1 && "border-b border-border/50",
                  isPlaceholder && "opacity-50",
                )}
                style={{ gridTemplateColumns: "96px 1fr 1fr 1fr 1fr 92px 80px" }}
              >
                <span className="text-xs font-semibold text-foreground">{row.symbol}</span>
                {EXCHANGES.map((ex) => {
                  const rate = row.rates[ex] ?? null;
                  const isDim = rate !== null && rate === minRate;
                  return (
                    <span
                      key={ex}
                      className={cn(
                        "font-mono text-xs font-medium text-right",
                        rate === null
                          ? "text-muted-foreground/30"
                          : isDim
                            ? "text-muted-foreground"
                            : "text-foreground",
                      )}
                    >
                      {rate !== null ? `${(rate * 100).toFixed(4)}%` : "—"}
                    </span>
                  );
                })}
                <span className="font-mono text-xs font-semibold text-right text-positive">
                  {`${(row.spread * 100).toFixed(4)}%`}
                </span>
                <div className="flex justify-end">
                  <ToneBadge tone="positive" className="font-mono font-bold text-[11px]">
                    {row.apy.toFixed(1)}%
                  </ToneBadge>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}
