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
              <TableCell className="text-right font-mono" style={{ color: "hsl(var(--positive))" }}>
                {formatRate(r.longRate)}
              </TableCell>
              <TableCell className="text-right">{r.shortExchange}</TableCell>
              <TableCell className="text-right font-mono" style={{ color: "hsl(var(--negative))" }}>
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
