"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EXCHANGE_NAMES, type ExchangeName } from "@/lib/constants";

export function ExchangeForm() {
  const utils = trpc.useUtils();
  const { data: exchanges, isLoading } = trpc.exchange.list.useQuery();
  const createMutation = trpc.exchange.create.useMutation({
    onSuccess: () => utils.exchange.list.invalidate(),
  });
  const testMutation = trpc.exchange.testConnection.useMutation();
  const deleteMutation = trpc.exchange.delete.useMutation({
    onSuccess: () => utils.exchange.list.invalidate(),
  });

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
    setForm({ name: "binance", apiKey: "", apiSecret: "", passphrase: "" });
  };

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <h3 className="text-lg font-semibold mb-4">Add Exchange</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <Label>Exchange</Label>
            <select
              className="w-full mt-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
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
            <Label>API Key</Label>
            <Input
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            />
          </div>
          <div>
            <Label>API Secret</Label>
            <Input
              type="password"
              value={form.apiSecret}
              onChange={(e) => setForm({ ...form, apiSecret: e.target.value })}
            />
          </div>
          {form.name === "okx" && (
            <div>
              <Label>Passphrase</Label>
              <Input
                type="password"
                value={form.passphrase}
                onChange={(e) =>
                  setForm({ ...form, passphrase: e.target.value })
                }
              />
            </div>
          )}
          <Button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? "Adding..." : "Add Exchange"}
          </Button>
        </form>
      </Card>

      <Card className="p-6">
        <h3 className="text-lg font-semibold mb-4">Configured Exchanges</h3>
        {isLoading ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : !exchanges?.length ? (
          <p className="text-muted-foreground">No exchanges configured.</p>
        ) : (
          <div className="space-y-3">
            {exchanges.map((ex) => (
              <div
                key={ex.id}
                className="flex items-center justify-between p-3 rounded-lg border border-border"
              >
                <div>
                  <span className="font-medium">{ex.name}</span>
                  <span className="ml-3 text-sm text-muted-foreground font-mono">
                    {ex.apiKey}
                  </span>
                  <Badge
                    variant={ex.isEnabled ? "default" : "secondary"}
                    className="ml-3"
                  >
                    {ex.isEnabled ? "Enabled" : "Disabled"}
                  </Badge>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => testMutation.mutate({ id: ex.id })}
                    disabled={testMutation.isPending}
                  >
                    {testMutation.isPending ? "Testing..." : "Test"}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => deleteMutation.mutate({ id: ex.id })}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
