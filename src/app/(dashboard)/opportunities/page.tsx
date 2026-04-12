import { RateTable } from "@/components/opportunities/rate-table";
import { OpportunityList } from "@/components/opportunities/opportunity-card";
import { SectionCard } from "@/components/ui/section-card";
import { StatCard } from "@/components/ui/stat-card";
import { ToneBadge } from "@/components/ui/tone-badge";
import { TrendingUp } from "lucide-react";

export default function OpportunitiesPage() {
  return (
    <div className="flex flex-col gap-6 p-8">
      {/* Sub-header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ToneBadge tone="neutral">
            Updated 30s ago
          </ToneBadge>
          <div className="flex items-center gap-1.5">
            {(["All", "BTC", "ETH", "SOL"] as const).map((chip, i) => (
              <button
                key={chip}
                className={
                  i === 0
                    ? "rounded-md bg-primary/10 text-primary px-3 py-1 text-xs font-medium"
                    : "rounded-md border border-border text-muted-foreground px-3 py-1 text-xs font-medium hover:text-foreground transition-colors"
                }
              >
                {chip}
              </button>
            ))}
          </div>
        </div>
        <button className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
          Open Position
        </button>
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-[1fr_360px] gap-6">
        {/* Left: rate matrix */}
        <RateTable />

        {/* Right column */}
        <div className="flex flex-col gap-4">
          {/* Top Opportunities */}
          <SectionCard
            title="Top Opportunities"
            subtitle="Ranked by annualized yield"
            action={<ToneBadge tone="positive"><TrendingUp className="h-3 w-3" />Live</ToneBadge>}
            bodyClassName="p-4"
          >
            <OpportunityList />
          </SectionCard>

          {/* Market Overview */}
          <SectionCard title="Market Overview" subtitle="Aggregate funding stats">
            <div className="grid grid-cols-2 gap-3">
              <StatCard label="Avg Rate" value="0.0124%" />
              <StatCard label="Active Pairs" value="8" />
              <StatCard label="Best APY" value="48.2%" deltaTone="positive" deltaText="+2.1%" deltaHint="24h" />
              <StatCard label="Opportunities" value="3" deltaTone="positive" deltaText="+1" deltaHint="new" />
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
