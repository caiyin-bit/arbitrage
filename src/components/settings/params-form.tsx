"use client";

import { useEffect, useState } from "react";
import { Edit2, Check, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

const PARAM_CONFIG = [
  { key: "min_rate_spread", label: "MIN RATE SPREAD", suffix: "%" },
  { key: "min_annualized_yield", label: "MIN ANNUALIZED YIELD", suffix: "%" },
  { key: "max_leverage", label: "MAX LEVERAGE", suffix: "x" },
  { key: "safety_margin_ratio", label: "SAFETY MARGIN BUFFER", suffix: "%" },
  { key: "volatility_threshold_1h", label: "1H VOLATILITY THRESHOLD", suffix: "%" },
  { key: "volatility_threshold_24h", label: "24H VOLATILITY THRESHOLD", suffix: "%" },
] as const;

type ParamKey = (typeof PARAM_CONFIG)[number]["key"];

export function ParamsForm() {
  const { data: settings, isLoading } = trpc.settings.getAll.useQuery();
  const utils = trpc.useUtils();
  const setMutation = trpc.settings.set.useMutation({
    onSuccess: () => utils.settings.getAll.invalidate(),
  });

  const [values, setValues] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  useEffect(() => {
    if (settings) {
      const v: Record<string, string> = {};
      for (const { key, suffix } of PARAM_CONFIG) {
        const raw = (settings as Record<string, unknown>)[key];
        if (raw !== undefined) {
          const isPercent = suffix === "%";
          v[key] = isPercent ? String(Number(raw) * 100) : String(raw);
        }
      }
      setValues(v);
    }
  }, [settings]);

  const startEdit = (key: string) => {
    setEditing(key);
    setEditValue(values[key] ?? "");
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditValue("");
  };

  const confirmEdit = (key: ParamKey, suffix: string) => {
    const isPercent = suffix === "%";
    const raw = parseFloat(editValue);
    const value = isPercent ? raw / 100 : raw;
    setMutation.mutate({ key, value });
    setValues((prev) => ({ ...prev, [key]: editValue }));
    setEditing(null);
  };

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Strategy Parameters</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Configure thresholds that govern opportunity detection and position sizing.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {PARAM_CONFIG.map(({ key, label, suffix }) => {
          const isEditingThis = editing === key;
          const displayVal = values[key] ?? "—";

          return (
            <div
              key={key}
              className="bg-card border border-border rounded-lg p-4 flex flex-col gap-2"
            >
              {/* Header */}
              <span className="text-[9px] font-semibold uppercase tracking-[0.8px] text-muted-foreground">
                {label}
              </span>

              {/* Value row */}
              <div className="flex items-center justify-between rounded-md bg-muted border border-border px-3 py-2">
                {isEditingThis ? (
                  <input
                    autoFocus
                    className="flex-1 bg-transparent font-mono text-sm text-foreground outline-none min-w-0"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") confirmEdit(key, suffix);
                      if (e.key === "Escape") cancelEdit();
                    }}
                  />
                ) : (
                  <span className="font-mono text-sm text-foreground">{displayVal}</span>
                )}
                <span className="font-mono text-xs text-muted-foreground ml-1.5 flex-shrink-0">
                  {suffix}
                </span>
              </div>

              {/* Helper / actions */}
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">
                  {suffix === "%" ? "Percentage value" : suffix === "x" ? "Multiplier" : "Amount"}
                </span>
                {isEditingThis ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => confirmEdit(key, suffix)}
                      disabled={setMutation.isPending}
                      className={cn(
                        "flex items-center justify-center h-6 w-6 rounded border border-border",
                        "text-positive hover:bg-positive/10 transition-colors",
                      )}
                    >
                      <Check className="h-3 w-3" />
                    </button>
                    <button
                      onClick={cancelEdit}
                      className={cn(
                        "flex items-center justify-center h-6 w-6 rounded border border-border",
                        "text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
                      )}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => startEdit(key)}
                    className="flex items-center justify-center h-6 w-6 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  >
                    <Edit2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-2">
        <p className="text-[11px] text-muted-foreground">
          Changes sync in real-time · last saved 2s ago
        </p>
        <div className="flex items-center gap-2">
          <button className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
            Reset to defaults
          </button>
          <button className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
