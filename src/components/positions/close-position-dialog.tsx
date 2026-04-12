"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

interface Props {
  position: {
    id: string;
    symbol: string;
    longExchange: { name: string };
    shortExchange: { name: string };
    longSize: string | number;
    shortSize: string | number;
  };
  onClose: () => void;
}

export function ClosePositionDialog({ position, onClose }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const utils = trpc.useUtils();
  const closeMut = trpc.position.close.useMutation({
    onSuccess: () => {
      utils.position.list.invalidate();
      onClose();
    },
    onError: (err) => setError(err.message),
  });

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-card border border-border rounded-xl p-6 w-[420px] flex flex-col gap-5 shadow-2xl">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold text-foreground">
            Close position
          </h3>
          <p className="text-xs text-muted-foreground">
            Both legs will be market-closed simultaneously.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 p-4 rounded-lg bg-muted border border-border">
          <div className="flex flex-col gap-1">
            <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              Symbol
            </span>
            <span className="text-sm font-semibold text-foreground">
              {position.symbol}
            </span>
          </div>
          <div className="flex flex-col gap-1 items-end">
            <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              Size
            </span>
            <span className="text-sm font-mono text-foreground">
              {Number(position.longSize).toFixed(4)} / {Number(position.shortSize).toFixed(4)}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[9px] font-semibold uppercase tracking-wider text-positive">
              Long
            </span>
            <span className="text-xs font-semibold text-foreground">
              {position.longExchange.name}
            </span>
          </div>
          <div className="flex flex-col gap-1 items-end">
            <span className="text-[9px] font-semibold uppercase tracking-wider text-negative">
              Short
            </span>
            <span className="text-xs font-semibold text-foreground">
              {position.shortExchange.name}
            </span>
          </div>
        </div>

        {error && (
          <div className="text-xs text-negative bg-negative/10 border border-negative/20 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={closeMut.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={closeMut.isPending}
            onClick={() =>
              closeMut.mutate({
                idempotencyKey,
                positionId: position.id,
                reason: "manual",
              })
            }
          >
            {closeMut.isPending ? "Closing..." : "Confirm close"}
          </Button>
        </div>
      </div>
    </div>
  );
}
