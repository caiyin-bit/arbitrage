"use client";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import type { EquityCurvePoint } from "@/server/services/backtest/types";

interface Props {
  data: EquityCurvePoint[];
  maxDrawdownDate: Date | null;
}

export function EquityCurve({ data, maxDrawdownDate }: Props) {
  const chartData = data.map((p) => ({
    t: new Date(p.date).getTime(),
    equity: Number(p.equity),
  }));
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium text-foreground mb-3">账户净值曲线</h3>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={chartData}>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
          <XAxis
            dataKey="t"
            tickFormatter={(ms) => new Date(ms).toISOString().slice(5, 10)}
            stroke="hsl(var(--muted-foreground))"
            fontSize={11}
          />
          <YAxis
            tickFormatter={(v) => `$${v.toFixed(0)}`}
            stroke="hsl(var(--muted-foreground))"
            fontSize={11}
            domain={["auto", "auto"]}
          />
          <Tooltip
            labelFormatter={(ms) => new Date(ms as number).toISOString().slice(0, 10)}
            formatter={(v) => typeof v === "number" ? `$${v.toFixed(2)}` : String(v)}
            contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
          />
          <Line type="monotone" dataKey="equity" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
          {maxDrawdownDate && (
            <ReferenceLine
              x={new Date(maxDrawdownDate).getTime()}
              stroke="hsl(var(--destructive))"
              strokeDasharray="3 3"
              label={{ value: "max DD", position: "top", fill: "hsl(var(--destructive))", fontSize: 10 }}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
