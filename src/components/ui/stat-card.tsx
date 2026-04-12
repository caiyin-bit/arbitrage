import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface StatCardProps {
  label: string;
  value: string;
  icon?: LucideIcon;
  deltaIcon?: LucideIcon;
  deltaText?: string;
  deltaTone?: "positive" | "negative" | "warning" | "muted" | "primary";
  deltaHint?: string;
  className?: string;
}

export function StatCard({
  label,
  value,
  icon: Icon,
  deltaIcon: DeltaIcon,
  deltaText,
  deltaTone = "muted",
  deltaHint,
  className,
}: StatCardProps) {
  const toneClass = {
    positive: "text-positive",
    negative: "text-negative",
    warning: "text-warning",
    muted: "text-muted-foreground",
    primary: "text-primary",
  }[deltaTone];

  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card p-5 flex flex-col gap-3",
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium tracking-wider uppercase text-muted-foreground">
          {label}
        </span>
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground/60" />}
      </div>
      <div className="font-mono text-2xl font-semibold text-foreground">{value}</div>
      {(deltaText || deltaHint) && (
        <div className="flex items-center gap-1.5">
          {DeltaIcon && <DeltaIcon className={cn("h-3 w-3", toneClass)} />}
          {deltaText && (
            <span className={cn("font-mono text-xs font-semibold", toneClass)}>
              {deltaText}
            </span>
          )}
          {deltaHint && (
            <span className="text-[11px] text-muted-foreground/60">{deltaHint}</span>
          )}
        </div>
      )}
    </div>
  );
}
