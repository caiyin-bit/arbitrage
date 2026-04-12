import { RateTable } from "@/components/opportunities/rate-table";
import { OpportunityList } from "@/components/opportunities/opportunity-card";

export default function OpportunitiesPage() {
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Opportunities</h1>
      <section>
        <h2 className="text-lg font-medium mb-4">Detected Opportunities</h2>
        <OpportunityList />
      </section>
      <section>
        <h2 className="text-lg font-medium mb-4">Latest Funding Rates</h2>
        <RateTable />
      </section>
    </div>
  );
}
