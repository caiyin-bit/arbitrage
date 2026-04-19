"use client";
import { useState } from "react";

interface Props {
  from: Date;
  to: Date;
  config: unknown;
}

export function MetadataBar({ from, to, config }: Props) {
  const [open, setOpen] = useState(false);
  const fromStr = new Date(from).toISOString().slice(0, 10);
  const toStr = new Date(to).toISOString().slice(0, 10);
  return (
    <div className="mb-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-foreground">
          <span className="text-muted-foreground">回测区间</span>{" "}
          <span className="font-mono">{fromStr}</span>
          <span className="mx-2 text-muted-foreground">→</span>
          <span className="font-mono">{toStr}</span>
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-xs text-primary hover:underline"
        >
          {open ? "收起参数" : "展开参数"}
        </button>
      </div>
      {open && (
        <pre className="mt-3 p-3 text-xs bg-muted/30 rounded overflow-x-auto">
          {JSON.stringify(config, null, 2)}
        </pre>
      )}
    </div>
  );
}
