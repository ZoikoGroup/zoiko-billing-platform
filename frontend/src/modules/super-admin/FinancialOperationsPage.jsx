import React, { useCallback, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import {
  RefreshCw,
  CreditCard,
  ShieldCheck,
  Receipt,
  Wallet,
  Undo2,
  Percent,
  GitMerge,
  BarChart3,
} from "lucide-react";
import { PageHeader, Button, HubTabs } from "../../components/billing-ui";
import BillingCommandCenterPage from "./BillingCommandCenterPage";
import InvoiceEnginePage from "./InvoiceEnginePage";
import PaymentsDisputesPage from "./PaymentsDisputesPage";
import BalancesAllocationsPage from "./BalancesAllocationsPage";
import CreditsRefundsPage from "./CreditsRefundsPage";
import TaxEInvoicingPage from "./TaxEInvoicingPage";
import ReconciliationPage from "./ReconciliationPage";

// The "section" query param (not "tab") is used deliberately. This hub no
// longer embeds Plane1BillingPage — that was Domain A sitting inside a Domain B
// hub that stated Domain A was architecturally isolated — but Plane 1 still
// owns its own `?tab=` for its quotes/invoices/payments/reconciliation/
// evaluation sub-tabs, so keying this hub off `tab` would still collide with
// those links landing here.
const VALID_TABS = [
  "overview",
  "invoice-engine",
  "payments-recovery",
  "balances-allocations",
  "credits-refunds",
  "tax",
  "tenant-ledger-reconciliation",
];

// Section keys this hub used to expose. Each maps to its replacement so an old
// bookmark lands on the right content instead of silently falling back to
// Overview, which is what an unrecognised value used to do.
const LEGACY_SECTION_ALIASES = {
  // "Billing Command Center" was merged into Overview (Section 0).
  "billing-command-center": "overview",
  "payments-disputes": "payments-recovery",
  "reconciliation": "tenant-ledger-reconciliation",
};

// The removed "Quotes & Invoices" tab embedded Plane1BillingPage (Domain A).
// Its internal sub-tabs were reachable as bare `?tab=` values on this hub, so
// any of these arriving here now belong to Plane 1 and are sent to Plane 1's
// own route rather than dropped on Overview.
const PLANE1_LEGACY_TABS = ["quotes", "invoices", "payments", "reconciliation", "evaluation"];
const PLANE1_ROUTE = "/super-admin/commercial/invoices";

// Each tab carries its own title/description. The header used to be hardcoded
// to "Financial Operations" no matter which tab was open, so the tab list and
// the header above it described different things.
const TABS = [
  {
    key: "overview",
    label: "Overview",
    icon: BarChart3,
    title: "Financial Operations Overview",
    description:
      "Plane 2 tenant revenue operations — the F1–F4 integrity and recovery summary, live collections signals, overdue aging and recent activity. Auto-refreshes every minute.",
  },
  {
    key: "invoice-engine",
    label: "Invoice Engine",
    icon: Receipt,
    title: "Invoice Engine",
    description:
      "Platform-wide invoice lifecycle: status distribution across every tenant and outbound delivery health.",
  },
  {
    key: "payments-recovery",
    label: "Payments & Recovery",
    icon: CreditCard,
    title: "Payments & Recovery",
    description:
      "Failed payment recovery queue and dunning engine state across every tenant.",
  },
  {
    key: "balances-allocations",
    label: "Balances & Allocations",
    icon: Wallet,
    title: "Balances & Allocations",
    description:
      "Payment-allocation integrity exceptions and the credit-note application ledger, across every tenant.",
  },
  {
    key: "credits-refunds",
    label: "Credits, Refunds & Write-offs",
    icon: Undo2,
    title: "Credits, Refunds & Write-offs",
    description:
      "Credit notes, cash refunds and bad-debt write-offs across every tenant (read-only oversight).",
  },
  {
    key: "tax",
    label: "Tax",
    icon: Percent,
    title: "Tax",
    description:
      "Applied-tax amounts recorded per invoice and credit note, grouped by currency, jurisdiction and tax type.",
  },
  {
    key: "tenant-ledger-reconciliation",
    label: "Tenant Ledger Reconciliation",
    icon: GitMerge,
    title: "Tenant Ledger Reconciliation",
    description:
      "REC-01 internal ledger reconciliation — invoice balance and payment-allocation invariants, on a daily schedule or on demand.",
  },
];

function resolveInitialSection(searchParams) {
  const section = searchParams.get("section");
  if (VALID_TABS.includes(section)) return { section };

  if (LEGACY_SECTION_ALIASES[section]) {
    return { section: LEGACY_SECTION_ALIASES[section], replace: true };
  }
  if (section === "quotes-invoices") {
    return { plane1Tab: searchParams.get("tab") || "quotes", replace: true };
  }

  const tab = searchParams.get("tab");
  if (PLANE1_LEGACY_TABS.includes(tab)) {
    return { plane1Tab: tab, replace: true };
  }

  return { section: "overview" };
}

export default function FinancialOperationsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // The active tab is derived from the URL on every render rather than copied
  // into state once, so an in-hub link (e.g. an Overview action card pointing
  // at ?section=invoice-engine) actually switches tabs.
  const resolved = resolveInitialSection(searchParams);
  const activeTab = resolved.section || "overview";

  // Bumping the nonce remounts the active tab, which re-runs its fetches. This
  // is what makes one Refresh control work for all seven tabs and guarantees a
  // tab re-fetches when it is activated instead of showing whatever it last
  // cached while it was hidden.
  const [refreshNonce, setRefreshNonce] = useState(0);

  const setActiveTab = useCallback(
    (tab) => {
      setRefreshNonce(0);
      setSearchParams({ section: tab }, { replace: true });
    },
    [setSearchParams]
  );

  if (resolved.plane1Tab) {
    return <Navigate to={`${PLANE1_ROUTE}?tab=${resolved.plane1Tab}`} replace />;
  }
  if (resolved.replace) {
    return <Navigate to={`/super-admin/financial-operations?section=${resolved.section}`} replace />;
  }

  const activeMeta = TABS.find((t) => t.key === activeTab) || TABS[0];
  const isOverview = activeTab === "overview";

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title={activeMeta.title}
        description={activeMeta.description}
        icon={activeMeta.icon}
        accent="brand"
        actions={
          <Button
            variant="secondary"
            icon={RefreshCw}
            onClick={() => setRefreshNonce((n) => n + 1)}
          >
            Refresh
          </Button>
        }
      />

      <HubTabs tabs={TABS} active={activeTab} onChange={setActiveTab} label="Financial Operations sections" accent="brand" />

      {isOverview && (
        <div className="mt-4 flex items-start gap-3 rounded-2xl border border-blue-100 bg-blue-50 p-4 text-xs text-blue-800">
          <ShieldCheck size={15} className="mt-0.5 shrink-0 text-blue-600" />
          <span>
            <strong>Domain B — Tenant Revenue Operations.</strong> Access to this view requires
            platform-level authentication. Monetary amounts are tenant aggregate counts and are NOT exposed
            to tenant users. Domain A (Platform Commercial / Plane 1) is architecturally isolated — it has
            its own section under <strong>Finance → Products &amp; Pricing</strong>, not a tab here.
          </span>
        </div>
      )}

      <div className="mt-6" key={`${activeTab}:${refreshNonce}`}>
        {isOverview ? (
          <BillingCommandCenterPage embedded />
        ) : activeTab === "invoice-engine" ? (
          <InvoiceEnginePage embedded />
        ) : activeTab === "payments-recovery" ? (
          <PaymentsDisputesPage embedded />
        ) : activeTab === "balances-allocations" ? (
          <BalancesAllocationsPage embedded />
        ) : activeTab === "credits-refunds" ? (
          <CreditsRefundsPage embedded />
        ) : activeTab === "tax" ? (
          <TaxEInvoicingPage embedded />
        ) : activeTab === "tenant-ledger-reconciliation" ? (
          <ReconciliationPage embedded />
        ) : null}
      </div>
    </div>
  );
}
