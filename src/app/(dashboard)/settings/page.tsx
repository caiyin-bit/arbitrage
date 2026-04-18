"use client";

import { useState } from "react";
import { Plug, SlidersHorizontal, ShieldAlert, Bell, User, Gift } from "lucide-react";
import { cn } from "@/lib/utils";
import { ExchangeForm } from "@/components/settings/exchange-form";
import { ParamsForm } from "@/components/settings/params-form";
import { InvitesSection } from "@/components/settings/invites-section";

const TABS = [
  { key: "exchanges", label: "Exchanges", icon: Plug },
  { key: "strategy", label: "Strategy", icon: SlidersHorizontal },
  { key: "risk", label: "Risk Control", icon: ShieldAlert },
  { key: "notifications", label: "Notifications", icon: Bell },
  { key: "account", label: "Account", icon: User },
  { key: "invites", label: "Invites", icon: Gift },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("exchanges");

  return (
    <div className="flex gap-8 p-8">
      {/* Left tab nav */}
      <div className="w-[220px] flex-shrink-0 flex flex-col gap-1">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={cn(
              "flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13px] font-medium transition-colors text-left w-full",
              activeTab === key
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon className="h-[14px] w-[14px] flex-shrink-0" />
            {label}
          </button>
        ))}
      </div>

      {/* Right content */}
      <div className="flex-1 flex flex-col gap-5 min-w-0">
        {activeTab === "exchanges" && <ExchangeForm />}
        {activeTab === "strategy" && <ParamsForm />}
        {activeTab === "invites" && <InvitesSection />}
      </div>
    </div>
  );
}
