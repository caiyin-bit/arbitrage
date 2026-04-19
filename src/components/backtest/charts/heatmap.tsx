"use client";
import { Group } from "@visx/group";
import { scaleLinear } from "@visx/scale";
import { HeatmapRect } from "@visx/heatmap";

interface GroupStat {
  key: string;
  count: number;
  netPnl: number;
}

interface Props {
  byDayOfWeek: GroupStat[];
  byHourOfDay: GroupStat[];
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS = Array.from({ length: 24 }, (_, i) => String(i));

export function Heatmap({ byDayOfWeek, byHourOfDay }: Props) {
  const byDay = new Map(byDayOfWeek.map((g) => [g.key, g.count]));
  const byHour = new Map(byHourOfDay.map((g) => [g.key, g.count]));

  const bins = DAYS.map((_, dayIdx) => ({
    bin: dayIdx,
    bins: HOURS.map((_, hourIdx) => ({
      bin: hourIdx,
      count: (byDay.get(String(dayIdx)) ?? 0) * (byHour.get(String(hourIdx)) ?? 0),
    })),
  }));

  const maxCount = Math.max(1, ...bins.flatMap((d) => d.bins.map((b) => b.count)));

  const width = 720;
  const height = 180;
  const margin = { top: 8, left: 40, right: 8, bottom: 24 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const binWidth = innerW / 24;
  const binHeight = innerH / 7;

  const xScale = scaleLinear<number>({ domain: [0, 24], range: [0, innerW] });
  const yScale = scaleLinear<number>({ domain: [0, 7], range: [0, innerH] });
  const colorScale = scaleLinear<string>({
    range: ["hsl(var(--muted))", "hsl(var(--primary))"],
    domain: [0, maxCount],
  });

  if (maxCount === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-medium text-foreground mb-3">机会热力图（星期 × 小时, UTC）</h3>
        <p className="text-xs text-muted-foreground">（无数据）</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium text-foreground mb-3">机会热力图（星期 × 小时, UTC）</h3>
      <svg width={width} height={height}>
        <Group top={margin.top} left={margin.left}>
          <HeatmapRect
            data={bins}
            xScale={(v) => xScale(v) ?? 0}
            yScale={(v) => yScale(v) ?? 0}
            colorScale={colorScale}
            binWidth={binWidth}
            binHeight={binHeight}
            gap={1}
          >
            {(heatmap) =>
              heatmap.map((heatmapBins) =>
                heatmapBins.map((bin) => (
                  <rect
                    key={`${bin.row}-${bin.column}`}
                    width={bin.width}
                    height={bin.height}
                    x={bin.x}
                    y={bin.y}
                    fill={bin.color}
                    stroke="hsl(var(--border))"
                  />
                )),
              )
            }
          </HeatmapRect>
          {DAYS.map((d, i) => (
            <text
              key={d}
              x={-6}
              y={yScale(i + 0.5) ?? 0}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={10}
              fill="hsl(var(--muted-foreground))"
            >
              {d}
            </text>
          ))}
          {HOURS.filter((_, i) => i % 3 === 0).map((h, idx) => {
            const i = idx * 3;
            return (
              <text
                key={h}
                x={xScale(i + 0.5) ?? 0}
                y={innerH + 14}
                textAnchor="middle"
                fontSize={10}
                fill="hsl(var(--muted-foreground))"
              >
                {h}
              </text>
            );
          })}
        </Group>
      </svg>
    </div>
  );
}
