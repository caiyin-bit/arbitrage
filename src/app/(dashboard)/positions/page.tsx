"use client";

import { trpc } from "@/lib/trpc";
import { StatCard } from "@/components/ui/stat-card";
import { PositionRow } from "@/components/positions/position-row";
import { Layers, DollarSign, Sparkles, ShieldAlert } from "lucide-react";

export default function PositionsPage() {
  const { data: positions, isLoading } = trpc.position.list.useQuery({
    limit: 50,
  });

  const openPositions = positions?.filter(
    (p) => p.status === "OPEN" || p.status === "RESCUE",
  ) ?? [];

  const totalNotional = openPositions.reduce((acc, p) => {
    const longNotional = Number(p.longSize) * Number(p.longAvgEntryPrice);
    return acc + longNotional;
  }, 0);

  const netPnl = (positions ?? []).reduce((acc, p) => {
    const settlementSum = (p.settlements ?? []).reduce(
      (s, x) => s + Number(x.fundingAmount),
      0,
    );
    return acc + settlementSum;
  }, 0);

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-foreground">Positions</h1>
          <p className="text-sm text-muted-foreground">
            {openPositions.length} open · {positions?.length ?? 0} total
          </p>
        </div>
      </div>

      {/* Summary stat cards */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard
          label="Open Positions"
          value={String(openPositions.length)}
          icon={Layers}
          deltaText={`${positions?.length ?? 0} total`}
          deltaTone="muted"
        />
        <StatCard
          label="Total Notional"
          value={`$${totalNotional.toFixed(2)}`}
          icon={DollarSign}
          deltaTone="primary"
        />
        <StatCard
          label="Net P&L"
          value={`${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(2)}`}
          icon={Sparkles}
          deltaTone={netPnl >= 0 ? "positive" : "negative"}
          deltaText={`${positions?.reduce(
            (acc, p) => acc + (p._count?.settlements ?? 0),
            0,
          ) ?? 0} settlements`}
        />
        <StatCard
          label="Worst Margin"
          value="—"
          icon={ShieldAlert}
          deltaTone="muted"
          deltaText="Plan 3"
        />
      </div>

      {/* List */}
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading positions...</p>
      ) : !positions || positions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
          <div className="h-14 w-14 rounded-2xl bg-muted flex items-center justify-center">
            <Layers className="h-6 w-6 text-muted-foreground" />
          </div>
          <div className="flex flex-col gap-1 max-w-md">
            <h2 className="text-base font-semibold text-foreground">
              No positions yet
            </h2>
            <p className="text-sm text-muted-foreground">
              Open your first hedge from the Opportunities page to start
              collecting funding rate settlements.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {positions.map((pos) => (
            <PositionRow key={pos.id} position={pos} />
          ))}
        </div>
      )}
    </div>
  );
}
