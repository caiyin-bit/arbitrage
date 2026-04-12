import { ExchangeForm } from "@/components/settings/exchange-form";
import { ParamsForm } from "@/components/settings/params-form";

export default function SettingsPage() {
  return (
    <div className="space-y-8 max-w-4xl">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <ExchangeForm />
      <ParamsForm />
    </div>
  );
}
