"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ExchangeRow } from "./exchange-row";
import { EXCHANGE_NAMES, type ExchangeName } from "@/lib/constants";

export function ExchangeForm() {
  const utils = trpc.useUtils();
  const { data: exchanges, isLoading } = trpc.exchange.list.useQuery();
  const createMutation = trpc.exchange.create.useMutation({
    onSuccess: () => {
      utils.exchange.list.invalidate();
      setShowForm(false);
      setForm({ name: "binance", apiKey: "", apiSecret: "", passphrase: "" });
    },
  });
  const testMutation = trpc.exchange.testConnection.useMutation();
  const deleteMutation = trpc.exchange.delete.useMutation({
    onSuccess: () => utils.exchange.list.invalidate(),
  });

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "binance" as ExchangeName,
    apiKey: "",
    apiSecret: "",
    passphrase: "",
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate({
      name: form.name,
      apiKey: form.apiKey,
      apiSecret: form.apiSecret,
      passphrase: form.passphrase || undefined,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Exchange Connections</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Connect your exchange accounts to start collecting funding rates.
        </p>
      </div>

      {/* Exchange list */}
      <div className="flex flex-col gap-2">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : exchanges?.length ? (
          exchanges.map((ex) => (
            <ExchangeRow
              key={ex.id}
              id={ex.id}
              name={ex.name}
              apiKey={ex.apiKey}
              status={ex.isEnabled ? "connected" : "offline"}
              onTest={(id) => testMutation.mutate({ id })}
              onDelete={(id) => deleteMutation.mutate({ id })}
              testPending={testMutation.isPending}
            />
          ))
        ) : null}
      </div>

      {/* Add exchange */}
      {showForm ? (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-3">Add Exchange Connection</h3>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div>
              <Label className="text-xs">Exchange</Label>
              <select
                className="w-full mt-1 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground"
                value={form.name}
                onChange={(e) =>
                  setForm({ ...form, name: e.target.value as ExchangeName })
                }
              >
                {EXCHANGE_NAMES.map((n) => (
                  <option key={n} value={n}>
                    {n.charAt(0).toUpperCase() + n.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs">API Key</Label>
              <Input
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">API Secret</Label>
              <Input
                type="password"
                value={form.apiSecret}
                onChange={(e) =>
                  setForm({ ...form, apiSecret: e.target.value })
                }
                className="mt-1"
              />
            </div>
            {form.name === "okx" && (
              <div>
                <Label className="text-xs">Passphrase</Label>
                <Input
                  type="password"
                  value={form.passphrase}
                  onChange={(e) =>
                    setForm({ ...form, passphrase: e.target.value })
                  }
                  className="mt-1"
                />
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <Button type="submit" size="sm" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Adding..." : "Add Exchange"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setShowForm(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        </div>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center justify-center gap-2 w-full rounded-lg border border-dashed border-border py-3 text-sm text-muted-foreground hover:text-foreground hover:border-border/80 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add exchange connection
        </button>
      )}
    </div>
  );
}
