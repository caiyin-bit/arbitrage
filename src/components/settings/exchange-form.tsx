"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ExchangeRow } from "./exchange-row";
import {
  EXCHANGE_NAMES,
  isMockExchange,
  type ExchangeName,
} from "@/lib/constants";

// Hide synthetic dev exchanges from the Add dropdown — they are seeded
// directly in the database for local testing only.
const CREATABLE_EXCHANGE_NAMES = EXCHANGE_NAMES.filter(
  (n) => !isMockExchange(n),
);

type FormMode = { kind: "create" } | { kind: "edit"; id: string };

const emptyForm = {
  name: "binance" as ExchangeName,
  apiKey: "",
  apiSecret: "",
  passphrase: "",
};

export function ExchangeForm() {
  const utils = trpc.useUtils();
  const { data: exchanges, isLoading } = trpc.exchange.list.useQuery();

  const [mode, setMode] = useState<FormMode | null>(null);
  const [form, setForm] = useState(emptyForm);

  const closeForm = () => {
    setMode(null);
    setForm(emptyForm);
  };

  const createMutation = trpc.exchange.create.useMutation({
    onSuccess: () => {
      utils.exchange.list.invalidate();
      closeForm();
    },
    onError: (err) => alert(`✗ Create failed:\n\n${err.message}`),
  });
  const updateMutation = trpc.exchange.update.useMutation({
    onSuccess: () => {
      utils.exchange.list.invalidate();
      closeForm();
    },
    onError: (err) => alert(`✗ Update failed:\n\n${err.message}`),
  });
  const testMutation = trpc.exchange.testConnection.useMutation({
    onSuccess: (result) => {
      if (result.success) {
        alert("✓ Connection OK");
      } else {
        alert(`✗ Connection failed:\n\n${result.error ?? "Unknown error"}`);
      }
    },
    onError: (err) => alert(`✗ Request error:\n\n${err.message}`),
  });
  const deleteMutation = trpc.exchange.delete.useMutation({
    onSuccess: () => utils.exchange.list.invalidate(),
    onError: (err) => alert(`✗ Delete failed:\n\n${err.message}`),
  });

  const handleEdit = (id: string) => {
    const ex = exchanges?.find((e) => e.id === id);
    if (!ex) return;
    // Keys/secrets can't be decrypted client-side — start blank; submit will
    // only PATCH the fields the user actually fills in.
    setForm({
      name: ex.name as ExchangeName,
      apiKey: "",
      apiSecret: "",
      passphrase: "",
    });
    setMode({ kind: "edit", id });
  };

  const handleDelete = (id: string) => {
    const ex = exchanges?.find((e) => e.id === id);
    const label = ex ? ex.name.toUpperCase() : "this exchange";
    if (!confirm(`Delete ${label} connection? This cannot be undone.`)) return;
    deleteMutation.mutate({ id });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!mode) return;
    if (mode.kind === "create") {
      createMutation.mutate({
        name: form.name,
        apiKey: form.apiKey,
        apiSecret: form.apiSecret,
        passphrase: form.passphrase || undefined,
      });
    } else {
      // PATCH semantics: only send non-empty fields so blank means "keep".
      updateMutation.mutate({
        id: mode.id,
        ...(form.apiKey && { apiKey: form.apiKey }),
        ...(form.apiSecret && { apiSecret: form.apiSecret }),
        ...(form.passphrase && { passphrase: form.passphrase }),
      });
    }
  };

  const isEditing = mode?.kind === "edit";
  const isPending = createMutation.isPending || updateMutation.isPending;

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
              createdAt={ex.createdAt}
              status={ex.isEnabled ? "connected" : "offline"}
              onTest={(id) => testMutation.mutate({ id })}
              onEdit={handleEdit}
              onDelete={handleDelete}
              testPending={testMutation.isPending}
            />
          ))
        ) : null}
      </div>

      {/* Add / Edit form */}
      {mode ? (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-3">
            {isEditing ? "Edit Exchange Connection" : "Add Exchange Connection"}
          </h3>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div>
              <Label className="text-xs">Exchange</Label>
              <select
                className="w-full mt-1 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground disabled:opacity-60"
                value={form.name}
                disabled={isEditing}
                onChange={(e) =>
                  setForm({ ...form, name: e.target.value as ExchangeName })
                }
              >
                {CREATABLE_EXCHANGE_NAMES.map((n) => (
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
                placeholder={isEditing ? "Leave blank to keep existing" : ""}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">API Secret</Label>
              <Input
                type="password"
                value={form.apiSecret}
                placeholder={isEditing ? "Leave blank to keep existing" : ""}
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
                  placeholder={isEditing ? "Leave blank to keep existing" : ""}
                  onChange={(e) =>
                    setForm({ ...form, passphrase: e.target.value })
                  }
                  className="mt-1"
                />
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <Button type="submit" size="sm" disabled={isPending}>
                {isPending
                  ? isEditing
                    ? "Saving..."
                    : "Adding..."
                  : isEditing
                    ? "Save Changes"
                    : "Add Exchange"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={closeForm}
              >
                Cancel
              </Button>
            </div>
          </form>
        </div>
      ) : (
        <button
          onClick={() => setMode({ kind: "create" })}
          className="flex items-center justify-center gap-2 w-full rounded-lg border border-dashed border-border py-3 text-sm text-muted-foreground hover:text-foreground hover:border-border/80 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add exchange connection
        </button>
      )}
    </div>
  );
}
