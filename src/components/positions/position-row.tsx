"use client";

import { useState } from "react";
import { ClosePositionDialog } from "./close-position-dialog";
import { Button } from "@/components/ui/button";
import { ToneBadge } from "@/components/ui/tone-badge";

interface PositionRowProps {
  position: any; // Keep flexible — shape comes from trpc.position.list
}

export function PositionRow({ position }: PositionRowProps) {
  const [showClose, setShowClose] = useState(false);

  const longSize = Number(position.longSize);
  const shortSize = Number(position.shortSize);
  const longEntry = Number(position.longAvgEntryPrice);
  const shortEntry = Number(position.shortAvgEntryPrice);

  // Sum of settlement fundingAmounts as a rough net P&L proxy
  const netPnl = (position.settlements ?? []).reduce(
    (acc: number, s: any) => acc + Number(s.fundingAmount),
    0,
  );

  const statusTone =
    position.status === "OPEN"
      ? "positive"
      : position.status === "RESCUE"
        ? "warning"
        : position.status === "CLOSED"
          ? "neutral"
          : "info";

  return (
    <>
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary/15 flex items-center justify-center">
              <span className="text-sm font-bold text-primary">
                {position.symbol.charAt(0)}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">
                  {position.symbol}
                </span>
                <ToneBadge tone={statusTone}>{position.status}</ToneBadge>
              </div>
              <span className="text-[11px] text-muted-foreground">
                Opened {new Date(position.openedAt).toLocaleString()}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex flex-col items-end gap-0.5">
              <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                Net P&amp;L
              </span>
              <span
                className={`text-base font-mono font-semibold ${
                  netPnl >= 0 ? "text-positive" : "text-negative"
                }`}
              >
                {netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)}
              </span>
            </div>
            {(position.status === "OPEN" || position.status === "RESCUE") && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowClose(true)}
              >
                Close
              </Button>
            )}
          </div>
        </div>

        {/* Body: two legs */}
        <div className="grid grid-cols-2 gap-4 p-5">
          <div className="rounded-lg bg-muted border border-border p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <div className="h-3 w-1 rounded-sm bg-positive" />
              <span className="text-[10px] font-bold tracking-wider text-positive uppercase">
                Long
              </span>
              <span className="text-xs font-semibold text-foreground ml-auto">
                {position.longExchange.name}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Size
                </span>
                <span className="text-xs font-mono font-semibold text-foreground">
                  {longSize.toFixed(4)}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Avg Entry
                </span>
                <span className="text-xs font-mono font-semibold text-foreground">
                  ${longEntry.toFixed(2)}
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-lg bg-muted border border-border p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <div className="h-3 w-1 rounded-sm bg-negative" />
              <span className="text-[10px] font-bold tracking-wider text-negative uppercase">
                Short
              </span>
              <span className="text-xs font-semibold text-foreground ml-auto">
                {position.shortExchange.name}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Size
                </span>
                <span className="text-xs font-mono font-semibold text-foreground">
                  {shortSize.toFixed(4)}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Avg Entry
                </span>
                <span className="text-xs font-mono font-semibold text-foreground">
                  ${shortEntry.toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 bg-muted border-t border-border">
          <div className="flex flex-col gap-0.5">
            <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              Settlements Earned
            </span>
            <span className="text-xs font-mono text-foreground">
              {position._count?.settlements ?? 0}
            </span>
          </div>
          <div className="flex flex-col items-end gap-0.5">
            <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              Trades
            </span>
            <span className="text-xs font-mono text-foreground">
              {position._count?.tradeLogs ?? 0}
            </span>
          </div>
        </div>
      </div>

      {showClose && (
        <ClosePositionDialog
          position={position}
          onClose={() => setShowClose(false)}
        />
      )}
    </>
  );
}
