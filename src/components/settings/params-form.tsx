"use client";

import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";

const PARAM_LABELS: Record<string, { label: string; suffix: string }> = {
  min_rate_spread: { label: "Min Rate Spread", suffix: "%" },
  min_annualized_yield: { label: "Min Annualized Yield", suffix: "%" },
  max_leverage: { label: "Max Leverage", suffix: "x" },
  safety_margin_ratio: { label: "Margin Safety Buffer", suffix: "%" },
  max_single_position: { label: "Max Single Position", suffix: "%" },
  max_single_leg_exposure: { label: "Max Single Leg Exposure", suffix: "USDT" },
  volatility_threshold_1h: { label: "1h Volatility Threshold", suffix: "%" },
  volatility_threshold_24h: { label: "24h Volatility Threshold", suffix: "%" },
};

export function ParamsForm() {
  const { data: settings, isLoading } = trpc.settings.getAll.useQuery();
  const utils = trpc.useUtils();
  const setMutation = trpc.settings.set.useMutation({
    onSuccess: () => utils.settings.getAll.invalidate(),
  });

  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (settings) {
      const v: Record<string, string> = {};
      for (const [key, val] of Object.entries(settings)) {
        if (key in PARAM_LABELS) {
          const isPercent = PARAM_LABELS[key].suffix === "%";
          v[key] = isPercent ? String(Number(val) * 100) : String(val);
        }
      }
      setValues(v);
    }
  }, [settings]);

  const handleSave = (key: string) => {
    const isPercent = PARAM_LABELS[key].suffix === "%";
    const raw = parseFloat(values[key]);
    const value = isPercent ? raw / 100 : raw;
    setMutation.mutate({ key, value });
  };

  if (isLoading) return <p className="text-muted-foreground">Loading...</p>;

  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold mb-4">Strategy Parameters</h3>
      <div className="grid gap-4 md:grid-cols-2">
        {Object.entries(PARAM_LABELS).map(([key, { label, suffix }]) => (
          <div key={key}>
            <Label>{label}</Label>
            <div className="flex gap-2 mt-1">
              <Input
                value={values[key] ?? ""}
                onChange={(e) =>
                  setValues({ ...values, [key]: e.target.value })
                }
              />
              <span className="flex items-center text-sm text-muted-foreground min-w-[40px]">
                {suffix}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleSave(key)}
                disabled={setMutation.isPending}
              >
                Save
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
