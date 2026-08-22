import React, { useEffect, useState } from "react";
import { Building2, CreditCard, HelpCircle, TrendingUp, UserCheck } from "lucide-react";
import { DashboardStatCard } from "../../../components/billing-shared";
import { getSaasCommercialReporting } from "../../../service/commercialService";

export default function CommercialLens({ commercial }) {
  const accounts = commercial?.accounts?.accounts || [];
  const plans = commercial?.plans?.plans || [];
  const subscriptions = commercial?.subscriptions?.subscriptions || [];
  const activeSubs = subscriptions.filter((s) => s.status === "active");

  const totalCommercialAccounts = commercial?.accounts?.total ?? accounts.length;
  const totalCommercialSubs = commercial?.subscriptions?.total ?? subscriptions.length;
  const totalPlans = plans.length;

  // Phase 3F F10 — MRR comes from the honest server-side read model
  // (priced published catalog versions only). The lens previously
  // fabricated a per-active-subscription dollar figure; that is exactly
  // the fabrication the gap analysis prohibits.
  const [mrr, setMrr] = useState(null);
  useEffect(() => {
    let cancelled = false;
    getSaasCommercialReporting()
      .then((report) => {
        if (!cancelled) setMrr(report.mrr);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function mrrDisplay() {
    if (!mrr) return "—";
    if (mrr.state === "unknown") return "UNKNOWN";
    if (mrr.state === "multi_currency") return `${mrr.currencies.length} currencies`;
    const amount = Number(mrr.amount ?? 0);
    return amount.toLocaleString("en-US", {
      style: "currency",
      currency: mrr.currencies[0]?.currency || "USD",
    });
  }

  return (
    <div className="space-y-6">
      {/* 4 Primary Commercial Modules */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {/* C1: MRR Movement (honest read model) */}
        <DashboardStatCard
          title="C1 · Commercial Run Rate"
          value={mrrDisplay()}
          subtitle={
            mrr?.state === "computed"
              ? "Monthly-normalized published prices"
              : "Priced catalog versions only — see Plane 1 Billing"
          }
          icon={TrendingUp}
          href="/super-admin/commercial/invoices"
        />

        {/* C2: Commercial Accounts */}
        <DashboardStatCard
          title="C2 · Commercial Accounts"
          value={totalCommercialAccounts}
          subtitle={`${totalPlans} plans in catalog`}
          icon={Building2}
          href="/super-admin/organizations"
        />

        {/* C3: Platform Subscriptions */}
        <DashboardStatCard
          title="C3 · Platform Subscriptions"
          value={totalCommercialSubs}
          subtitle={`${activeSubs.length} active in recent sample`}
          icon={UserCheck}
          href="/super-admin/commercial/subscriptions"
        />

        {/* C4: Collections — no Plane 1 payment processor exists; reporting a
            rate here would fabricate data, so this card declares UNKNOWN. */}
        <DashboardStatCard
          title="C4 · Platform Collections"
          value="UNKNOWN"
          subtitle="No Plane 1 payments engine yet (REC-01)"
          icon={CreditCard}
        />
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">Commercial Domain Boundary (Domain A)</h3>
        <p className="mt-2 text-xs text-slate-600 leading-relaxed">
          Plane 1 (Zoiko SaaS commercial billing) is capability-gated. Commercial accounts and plan versions are governed under ZB-COM-BILL-001 with maker-checker approvals required for price book changes.
        </p>
      </div>
    </div>
  );
}
