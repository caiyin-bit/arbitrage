"use client";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from "recharts";

interface Props {
  totalFees: number;
  netPnl: number;
}

export function FeePie({ totalFees, netPnl }: Props) {
  const data = [
    { name: "总手续费", value: Math.max(0, totalFees) },
    { name: "净收益", value: Math.max(0, netPnl) },
  ];
  const allZero = data.every((d) => d.value === 0);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium text-foreground mb-3">手续费 vs 净收益</h3>
      {allZero ? (
        <p className="text-xs text-muted-foreground">（无数据）</p>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" outerRadius={90} label>
              <Cell fill="hsl(var(--destructive))" />
              <Cell fill="hsl(var(--positive))" />
            </Pie>
            <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
