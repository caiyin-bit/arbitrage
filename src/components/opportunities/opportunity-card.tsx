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
            <Badge style={{ backgroundColor: "hsl(var(--positive) / 0.1)", color: "hsl(var(--positive))" }}>
              {(Number(opp.annualizedYield) * 100).toFixed(1)}% APY
            </Badge>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-muted-foreground">Long</span>
              <div className="font-medium">{opp.longExchange.name}</div>
              <div className="font-mono" style={{ color: "hsl(var(--positive))" }}>
                {formatRate(Number(opp.longRate))}
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">Short</span>
              <div className="font-medium">{opp.shortExchange.name}</div>
              <div className="font-mono" style={{ color: "hsl(var(--negative))" }}>
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
