"use client";
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Cell } from "recharts";

interface Props {
  data: { key: string; netPnl: number; count: number }[];
}

export function BySymbol({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-medium text-foreground mb-3">按币种 P&L</h3>
        <p className="text-xs text-muted-foreground">（无数据）</p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium text-foreground mb-3">按币种 P&L</h3>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data}>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
          <XAxis dataKey="key" stroke="hsl(var(--muted-foreground))" fontSize={11} />
          <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
          <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
          <Bar dataKey="netPnl">
            {data.map((d, i) => (
              <Cell key={i} fill={d.netPnl >= 0 ? "hsl(var(--positive))" : "hsl(var(--destructive))"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
