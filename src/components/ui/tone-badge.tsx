import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "positive" | "negative" | "warning" | "info" | "neutral";

interface ToneBadgeProps {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}

const TONE: Record<Tone, string> = {
  positive: "bg-positive/10 text-positive",
  negative: "bg-negative/10 text-negative",
  warning: "bg-warning/10 text-warning",
  info: "bg-primary/10 text-primary",
  neutral: "bg-muted text-muted-foreground",
};

export function ToneBadge({ tone = "neutral", children, className }: ToneBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
