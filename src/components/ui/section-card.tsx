import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SectionCardProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function SectionCard({
  title,
  subtitle,
  action,
  children,
  className,
  bodyClassName,
}: SectionCardProps) {
  return (
    <div className={cn("rounded-xl border border-border bg-card", className)}>
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {subtitle && (
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {action}
      </div>
      <div className={cn("p-6", bodyClassName)}>{children}</div>
    </div>
  );
}
