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
      "Tenant billing across the platform — billings and collections, payment recovery, ledger integrity and revenue leakage, plus live collections signals, overdue aging and recent activity. Auto-refreshes every minute.",
  },
  {
    key: "invoice-engine",
    label: "Invoice Engine",
    icon: Receipt,
    title: "Invoice Engine",
    description:
      "Every tenant invoice by lifecycle status, and how invoice emails to customers are being delivered.",
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
      "Invoices with more payment allocated than their total, and credit notes applied against invoices, across every tenant.",
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
      "Checks every tenant's ledger — invoice balances and payment allocations — daily or on demand, optionally comparing payments with Stripe.",
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

  // The header Refresh button bumps this. Tabs built on useLiveRefresh take it
  // as `refreshSignal` and re-fetch in place — keeping their data, filters
  // and any open modal on screen. Overview (BillingCommandCenterPage) has no
  // such prop, so for it the nonce is part of the key and remounts it.
  // Switching tabs always remounts (the key includes the tab), so a tab
  // re-fetches when activated and its live-refresh timer stops when it is
  // left.
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
            <strong>Tenant revenue, platform admins only.</strong> These are aggregate figures across
            every tenant's own billing — never shown to tenant users, with small counts hidden to protect
            individual customers. Amounts are always shown per currency. Zoiko's own subscription billing
            to tenants lives separately under <strong>Finance → Products &amp; Pricing</strong>.
          </span>
        </div>
      )}

      <div className="mt-6" key={isOverview ? `overview:${refreshNonce}` : activeTab}>
        {isOverview ? (
          <BillingCommandCenterPage embedded />
        ) : activeTab === "invoice-engine" ? (
          <InvoiceEnginePage embedded refreshSignal={refreshNonce} />
        ) : activeTab === "payments-recovery" ? (
          <PaymentsDisputesPage embedded refreshSignal={refreshNonce} />
        ) : activeTab === "balances-allocations" ? (
          <BalancesAllocationsPage embedded refreshSignal={refreshNonce} />
        ) : activeTab === "credits-refunds" ? (
          <CreditsRefundsPage embedded refreshSignal={refreshNonce} />
        ) : activeTab === "tax" ? (
          <TaxEInvoicingPage embedded refreshSignal={refreshNonce} />
        ) : activeTab === "tenant-ledger-reconciliation" ? (
          <ReconciliationPage embedded refreshSignal={refreshNonce} />
        ) : null}
      </div>
    </div>
  );
}
