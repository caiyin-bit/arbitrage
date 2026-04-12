"use client";

import { Zap, Edit2, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type ExchangeStatus = "connected" | "degraded" | "offline";

interface ExchangeRowProps {
  id: string;
  name: string;
  apiKey: string;
  status?: ExchangeStatus;
  createdDaysAgo?: number;
  onTest?: (id: string) => void;
  onDelete?: (id: string) => void;
  testPending?: boolean;
}

const EXCHANGE_COLORS: Record<string, string> = {
  binance: "bg-warning/20 text-warning",
  okx: "bg-primary/20 text-primary",
  bybit: "bg-positive/20 text-positive",
  gateio: "bg-negative/20 text-negative",
};

function StatusDot({ status }: { status: ExchangeStatus }) {
  const colorClass =
    status === "connected"
      ? "bg-positive"
      : status === "degraded"
        ? "bg-warning"
        : "bg-negative";
  return (
    <span className="relative flex h-1.5 w-1.5">
      <span
        className={cn(
          "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
          colorClass,
        )}
      />
      <span
        className={cn("relative inline-flex rounded-full h-1.5 w-1.5", colorClass)}
      />
    </span>
  );
}

export function ExchangeRow({
  id,
  name,
  apiKey,
  status = "connected",
  createdDaysAgo = 0,
  onTest,
  onDelete,
  testPending,
}: ExchangeRowProps) {
  const letter = name.charAt(0).toUpperCase();
  const tileColor = EXCHANGE_COLORS[name] ?? "bg-muted text-muted-foreground";

  const statusLabel =
    status === "connected"
      ? "CONNECTED"
      : status === "degraded"
        ? "DEGRADED"
        : "OFFLINE";

  const statusTextClass =
    status === "connected"
      ? "text-positive"
      : status === "degraded"
        ? "text-warning"
        : "text-negative";

  // Mask the API key: show first 2 + last 2, rest as ***
  const maskedKey =
    apiKey.length > 4
      ? `AK · ****${apiKey.slice(-2)} · Added ${createdDaysAgo}d ago`
      : `AK · **** · Added ${createdDaysAgo}d ago`;

  return (
    <div className="flex items-center gap-4 p-4 rounded-lg border border-border bg-card">
      {/* Exchange tile */}
      <div
        className={cn(
          "h-10 w-10 rounded-lg flex items-center justify-center text-base font-bold flex-shrink-0",
          tileColor,
        )}
      >
        {letter}
      </div>

      {/* Name + status + key */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground capitalize">{name}</span>
          <span className={cn("flex items-center gap-1")}>
            <StatusDot status={status} />
            <span className={cn("text-[9px] font-bold tracking-wide", statusTextClass)}>
              {statusLabel}
            </span>
          </span>
        </div>
        <p className="font-mono text-[11px] text-muted-foreground mt-0.5 truncate">
          {maskedKey}
        </p>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button
          onClick={() => onTest?.(id)}
          disabled={testPending}
          className="flex items-center justify-center h-8 w-8 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
          title="Test connection"
        >
          <Zap className="h-3.5 w-3.5" />
        </button>
        <button
          className="flex items-center justify-center h-8 w-8 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Edit"
        >
          <Edit2 className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => onDelete?.(id)}
          className="flex items-center justify-center h-8 w-8 rounded-md border border-border text-muted-foreground hover:text-negative hover:bg-negative/10 transition-colors"
          title="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
