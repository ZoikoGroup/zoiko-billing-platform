import React from "react";
import { TrendingUp, HelpCircle } from "lucide-react";
import { PageHeader } from "../../components/billing-ui";

export default function UsageMeteringPage() {
  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Usage & Metering"
        description="Metered consumption ingestion, usage-rating pipeline health, and unbilled usage leakage detection."
        icon={TrendingUp}
      />

      <div className="mt-6 rounded-3xl border border-dashed border-slate-200 bg-slate-50 p-8">
        <div className="flex flex-col items-center text-center">
          <HelpCircle className="mb-3 h-10 w-10 text-slate-300" />
          <p className="text-sm font-semibold text-slate-700">Not available on this platform</p>
          <p className="mt-2 max-w-lg text-xs text-slate-500">
            Zoiko Billing has no usage-metering event model — there is no table recording raw consumption
            events (API calls, storage units, active seats) anywhere in this codebase, and therefore no
            rating pipeline to monitor and no unbilled-usage query to run. Invoices can carry a{" "}
            <code className="rounded bg-slate-200 px-1 py-0.5 text-[11px]">usage</code> type
            (<code className="rounded bg-slate-200 px-1 py-0.5 text-[11px]">InvoiceType.USAGE</code>), but
            nothing generates that line-item data from ingested events today.
          </p>
          <p className="mt-3 max-w-lg text-xs text-slate-500">
            Building this section requires a new metered-usage data model and ingestion pipeline — it is a
            product feature to design, not a missing dashboard panel. This page reports that honestly rather
            than showing fabricated zeroes.
          </p>
        </div>
      </div>
    </div>
  );
}
