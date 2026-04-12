"use client";

import { useState } from "react";
import { ArrowRight, Bookmark } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { ToneBadge } from "@/components/ui/tone-badge";
import { cn } from "@/lib/utils";
import { formatRate } from "@/lib/utils";
import { OpenPositionDialog } from "./open-position-dialog";

// Placeholder cards rendered only when the query returns no opportunities.
// Remove once backend begins detecting real opportunities.
const NO_DATA_PLACEHOLDER = [
  {
    id: "ph1",
    symbol: "BTC/USDT",
    annualizedYield: 0.482,
    longExchange: { id: "", name: "okx" },
    shortExchange: { id: "", name: "binance" },
    longRate: -0.0002,
    shortRate: 0.0001,
    rateSpread: 0.0003,
    isNew: true,
  },
  {
    id: "ph2",
    symbol: "ETH/USDT",
    annualizedYield: 0.319,
    longExchange: { id: "", name: "bybit" },
    shortExchange: { id: "", name: "okx" },
    longRate: -0.0001,
    shortRate: 0.0003,
    rateSpread: 0.0004,
    isNew: false,
  },
  {
    id: "ph3",
    symbol: "SOL/USDT",
    annualizedYield: 0.251,
    longExchange: { id: "", name: "gateio" },
    shortExchange: { id: "", name: "binance" },
    longRate: -0.0003,
    shortRate: 0.00025,
    rateSpread: 0.00055,
    isNew: false,
  },
];

interface OppCardProps {
  id: string;
  symbol: string;
  annualizedYield: number;
  longExchange: { id: string; name: string };
  shortExchange: { id: string; name: string };
  longRate: number;
  shortRate: number;
  rateSpread: number;
  isNew?: boolean;
  isFirst?: boolean;
  isPlaceholder?: boolean;
}

function OpportunityCard({
  id,
  symbol,
  annualizedYield,
  longExchange,
  shortExchange,
  longRate,
  shortRate,
  rateSpread,
  isNew,
  isFirst,
  isPlaceholder,
}: OppCardProps) {
  const [showDialog, setShowDialog] = useState(false);

  return (
    <>
      <div
        className={cn(
          "bg-muted border border-border rounded-lg p-3.5 flex flex-col gap-3",
          isFirst && "border-primary/30",
          isPlaceholder && "opacity-50",
        )}
      >
        {/* Header row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{symbol}</span>
            {isNew && <ToneBadge tone="neutral">NEW</ToneBadge>}
          </div>
          <span className="bg-positive/10 text-positive rounded-md px-2.5 py-1 font-mono text-[11px] font-bold">
            {(annualizedYield * 100).toFixed(1)}% APY
          </span>
        </div>

        {/* Flow row */}
        <div className="flex items-center justify-between gap-2">
          {/* Long leg */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[9px] font-bold tracking-wide text-positive">LONG</span>
            <span className="text-xs font-semibold text-foreground capitalize">
              {longExchange.name}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {formatRate(longRate)}
            </span>
          </div>

          {/* Arrow */}
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />

          {/* Short leg */}
          <div className="flex flex-col gap-0.5 text-right">
            <span className="text-[9px] font-bold tracking-wide text-negative">SHORT</span>
            <span className="text-xs font-semibold text-foreground capitalize">
              {shortExchange.name}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {formatRate(shortRate)}
            </span>
          </div>
        </div>

        {/* Footer row */}
        <div className="flex items-center gap-2">
          <button
            className="flex-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none"
            disabled={isPlaceholder}
            onClick={() => setShowDialog(true)}
          >
            Open Position
          </button>
          <button className="flex items-center justify-center h-[34px] w-[34px] rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-card transition-colors flex-shrink-0">
            <Bookmark className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {showDialog && (
        <OpenPositionDialog
          opportunity={{ id, symbol, longExchange, shortExchange, longRate, shortRate, rateSpread, annualizedYield }}
          onClose={() => setShowDialog(false)}
        />
      )}
    </>
  );
}

export function OpportunityList() {
  const { data: opportunities, isLoading } = trpc.opportunity.list.useQuery(
    { status: "DETECTED", limit: 4 },
    { refetchInterval: 30_000 },
  );

  const isPlaceholder = !opportunities || opportunities.length === 0;
  const items = isPlaceholder
    ? NO_DATA_PLACEHOLDER
    : opportunities.slice(0, 4).map((o) => ({
        id: o.id,
        symbol: o.symbol,
        annualizedYield: Number(o.annualizedYield),
        longExchange: o.longExchange,
        shortExchange: o.shortExchange,
        longRate: Number(o.longRate),
        shortRate: Number(o.shortRate),
        rateSpread: Number(o.rateSpread),
        isNew: false,
      }));

  if (isLoading) {
    return <p className="text-sm text-muted-foreground p-4">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-2.5">
      {items.map((opp, i) => (
        <OpportunityCard
          key={opp.id}
          {...opp}
          isFirst={i === 0}
          isPlaceholder={isPlaceholder}
        />
      ))}
    </div>
  );
}
