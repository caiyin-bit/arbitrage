"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Zap,
  LayoutDashboard,
  Target,
  Layers,
  History,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";

const OVERVIEW_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/opportunities", label: "Opportunities", icon: Target },
  { href: "/positions", label: "Positions", icon: Layers },
];

const TOOLS_ITEMS = [
  { href: "/backtest", label: "Backtest", icon: History },
  { href: "/settings", label: "Settings", icon: Settings },
];

function NavItem({
  href,
  label,
  icon: Icon,
  isActive,
}: {
  href: string;
  label: string;
  icon: React.ElementType;
  isActive: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-3 rounded-lg transition-colors",
        "px-3 py-[10px] text-[13px] font-medium",
        isActive
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4 flex-shrink-0" />
      {label}
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <aside className="flex flex-col w-60 flex-shrink-0 border-r border-border bg-background h-screen">
      {/* Brand row */}
      <div className="flex items-center gap-2.5 px-4 py-[18px]">
        <div className="h-7 w-7 rounded-md bg-primary flex items-center justify-center flex-shrink-0">
          <Zap className="h-4 w-4 text-primary-foreground" />
        </div>
        <span className="text-[15px] font-semibold text-foreground">Arbitrage</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 flex flex-col gap-6 px-3 pt-2">
        {/* Overview group */}
        <div className="flex flex-col gap-0.5">
          <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-[0.8px] text-muted-foreground">
            Overview
          </p>
          {OVERVIEW_ITEMS.map((item) => (
            <NavItem key={item.href} {...item} isActive={isActive(item.href)} />
          ))}
        </div>

        {/* Tools group */}
        <div className="flex flex-col gap-0.5">
          <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-[0.8px] text-muted-foreground">
            Tools
          </p>
          {TOOLS_ITEMS.map((item) => (
            <NavItem key={item.href} {...item} isActive={isActive(item.href)} />
          ))}
        </div>
      </nav>

      {/* Footer worker status */}
      <div className="p-3">
        <div className="bg-card border border-border rounded-lg p-3 flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-positive opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-positive" />
            </span>
            <span className="text-[11px] font-semibold text-foreground">Worker online</span>
          </div>
          <span className="text-[10px] text-muted-foreground pl-4">Last tick 2s ago</span>
        </div>
      </div>
    </aside>
  );
}
