import { LayoutDashboard } from "lucide-react";

export default function DashboardPage() {
  return (
    <div className="flex flex-col items-center justify-center h-full p-8 gap-6 text-center">
      <div className="h-14 w-14 rounded-2xl bg-muted flex items-center justify-center">
        <LayoutDashboard className="h-6 w-6 text-muted-foreground" />
      </div>
      <div className="flex flex-col gap-2 max-w-md">
        <h1 className="text-2xl font-semibold text-foreground">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Real-time balance overview, cumulative P&L chart, and live event stream.
          Coming in Plan 2 once trade execution and settlement tracking are wired.
        </p>
        <p className="text-xs text-muted-foreground/60 mt-2">
          Preview the design at{" "}
          <code className="text-primary">docs/design/mockups/01-dashboard.png</code>
        </p>
      </div>
    </div>
  );
}
