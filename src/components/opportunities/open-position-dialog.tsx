"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { formatRate } from "@/lib/utils";

interface Props {
  opportunity: {
    id: string;
    symbol: string;
    longExchange: { id: string; name: string };
    shortExchange: { id: string; name: string };
    longRate: number;
    shortRate: number;
    rateSpread: number;
    annualizedYield: number;
  };
  onClose: () => void;
}

export function OpenPositionDialog({ opportunity, onClose }: Props) {
  const [size, setSize] = useState("0.1");
  const [leverage, setLeverage] = useState(2);
  const [error, setError] = useState<string | null>(null);
  // Generate idempotency key ONCE per dialog mount — rage-clicks reuse it
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const utils = trpc.useUtils();
  const openMut = trpc.position.open.useMutation({
    onSuccess: (result) => {
      console.log("Position opened:", result);
      utils.position.list.invalidate();
      utils.opportunity.list.invalidate();
      onClose();
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-card border border-border rounded-xl p-6 w-[460px] flex flex-col gap-5 shadow-2xl">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold text-foreground">
            Open hedged position
          </h3>
          <p className="text-xs text-muted-foreground">
            Review the hedge before confirming
          </p>
        </div>

        {/* Opportunity summary */}
        <div className="grid grid-cols-2 gap-3 p-4 rounded-lg bg-muted border border-border">
          <div className="flex flex-col gap-1">
            <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              Symbol
            </span>
            <span className="text-sm font-semibold text-foreground">
              {opportunity.symbol}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              APY
            </span>
            <span className="text-sm font-mono font-semibold text-positive">
              {(opportunity.annualizedYield * 100).toFixed(2)}%
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[9px] font-semibold uppercase tracking-wider text-positive">
              Long
            </span>
            <span className="text-xs font-semibold text-foreground">
              {opportunity.longExchange.name}
            </span>
            <span className="text-[10px] font-mono text-muted-foreground">
              {formatRate(opportunity.longRate)}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[9px] font-semibold uppercase tracking-wider text-negative">
              Short
            </span>
            <span className="text-xs font-semibold text-foreground">
              {opportunity.shortExchange.name}
            </span>
            <span className="text-[10px] font-mono text-muted-foreground">
              {formatRate(opportunity.shortRate)}
            </span>
          </div>
        </div>

        {/* Inputs */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Size
            </label>
            <div className="flex items-center gap-2">
              <input
                className="flex-1 bg-muted border border-border rounded-md px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                value={size}
                onChange={(e) => setSize(e.target.value)}
                placeholder="0.1"
              />
              <span className="text-xs text-muted-foreground min-w-[40px]">
                base
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Leverage
            </label>
            <select
              className="bg-muted border border-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              value={leverage}
              onChange={(e) => setLeverage(Number(e.target.value))}
            >
              <option value={1}>1x</option>
              <option value={2}>2x</option>
              <option value={3}>3x</option>
            </select>
          </div>
        </div>

        {error && (
          <div className="text-xs text-negative bg-negative/10 border border-negative/20 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={openMut.isPending}>
            Cancel
          </Button>
          <Button
            variant="default"
            disabled={openMut.isPending || !size}
            onClick={() => {
              const parsed = parseFloat(size);
              if (!parsed || parsed <= 0) {
                setError("Size must be greater than 0");
                return;
              }
              setError(null);
              openMut.mutate({
                idempotencyKey,
                opportunityId: opportunity.id,
                symbol: opportunity.symbol,
                longExchange: opportunity.longExchange.name as any,
                shortExchange: opportunity.shortExchange.name as any,
                size: parsed,
                leverage,
              });
            }}
          >
            {openMut.isPending ? "Opening..." : "Confirm"}
          </Button>
        </div>
      </div>
    </div>
  );
}
