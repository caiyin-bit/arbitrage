import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/layout/user-menu";
import { cn } from "@/lib/utils";

interface HeaderProps {
  title?: string;
}

const TIME_RANGES = ["24h", "7d", "30d", "All"] as const;

export function Header({ title = "Dashboard" }: HeaderProps) {
  return (
    <header className="flex items-center justify-between h-14 px-8 border-b border-border flex-shrink-0">
      {/* Left: page title */}
      <span className="text-base font-semibold text-foreground">{title}</span>

      {/* Right: live badge + time range + export */}
      <div className="flex items-center gap-3">
        {/* LIVE badge */}
        <div className="flex items-center gap-1.5 rounded-md bg-positive/10 px-2 py-1">
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-positive opacity-75" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-positive" />
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-wide text-positive">Live</span>
        </div>

        {/* Time range segmented control */}
        <div className="flex items-center rounded-md border border-border bg-card p-0.5 gap-0.5">
          {TIME_RANGES.map((range, i) => (
            <button
              key={range}
              className={cn(
                "px-3 py-1 rounded text-xs font-medium transition-colors",
                i === 0
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {range}
            </button>
          ))}
        </div>

        {/* Export button */}
        <button className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
          Export
        </button>

        {/* Theme toggle */}
        <ThemeToggle />

        {/* User menu */}
        <UserMenu />
      </div>
    </header>
  );
}
