import { Lock } from "lucide-react";
import { NavLink, Navigate, useParams } from "react-router-dom";
import {
  BadgeCheck, Building2, ClipboardList, FileCheck2, LayoutDashboard, Package, ShieldCheck, UserSquare2,
} from "lucide-react";

import { getStoredUser } from "../../api/client";
import { PageHeader } from "../../components/billing-ui";
import { MUTED, PANEL, STRONG } from "../tax-control-center/shared";
import { canReadTenantTax } from "./common";
import { EntitiesScreen, OverviewScreen, RegimeScreen } from "./EntityScreens";
import { ActivationsScreen, ObligationsScreen } from "./ObligationScreens";
import { ClassificationScreen, CustomerEvidenceScreen, ReviewItemsScreen } from "./EvidenceScreens";

/* Tenant Settings → Taxes (ZB-TAX-ARCH-001 Phase 5b): T1–T8. Tenant data
 * only, through the tenant tax API. The existing Tax Rates and Tax
 * Configuration pages are untouched: a legacy-manual tenant keeps working
 * exactly as before until a regime switch is approved. */

export const GOVERNANCE_SECTIONS = [
  { key: "overview", label: "Overview", icon: LayoutDashboard, element: OverviewScreen },
  { key: "entities", label: "Legal entities", icon: Building2, element: EntitiesScreen },
  { key: "registrations", label: "Registrations", icon: FileCheck2, element: ObligationsScreen },
  { key: "activations", label: "Activations", icon: BadgeCheck, element: ActivationsScreen },
  { key: "regime", label: "Regime", icon: ShieldCheck, element: RegimeScreen },
  { key: "classification", label: "Product classification", icon: Package, element: ClassificationScreen },
  { key: "customers", label: "Customer tax evidence", icon: UserSquare2, element: CustomerEvidenceScreen },
  { key: "review", label: "Review items", icon: ClipboardList, element: ReviewItemsScreen },
];

function NoTenantAccess() {
  return (
    <div className={`${PANEL} mx-auto max-w-xl text-center`} role="alert">
      <Lock className="mx-auto mb-3 h-8 w-8 text-slate-500" aria-hidden="true" />
      <h1 className={`text-lg font-bold ${STRONG}`}>No access to tax governance</h1>
      <p className={`mt-2 text-sm ${MUTED}`}>
        These settings are for your organization's admins, billing admins, finance approvers and auditors. Ask an
        organization admin if you need access.
      </p>
    </div>
  );
}

export default function TaxGovernancePage() {
  const { section } = useParams();
  const user = getStoredUser();
  if (!canReadTenantTax(user?.role)) return <NoTenantAccess />;
  const current = GOVERNANCE_SECTIONS.find((s) => s.key === section);
  if (!current) return <Navigate to="/billing/tax/governance/overview" replace />;
  const Screen = current.element;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Tax governance"
        description="Entities, registrations, activations and evidence for governed tax. Every proposal needs a different finance approver."
        icon={ShieldCheck}
        crumbs={[{ label: "Tax", href: "/billing/tax" }, { label: "Tax governance" }]}
      />
      <nav aria-label="Tax governance sections" className="flex max-w-full gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-slate-50/60 p-1 dark:border-slate-700 dark:bg-slate-900">
        {GOVERNANCE_SECTIONS.map(({ key, label, icon: Icon }) => (
          <NavLink
            key={key}
            to={`/billing/tax/governance/${key}`}
            className={({ isActive }) => `inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl border px-3.5 py-2 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 md:min-h-0 ${
              isActive
                ? "border-slate-200 bg-white text-slate-900 shadow-sm dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                : "border-transparent text-slate-600 hover:bg-white hover:text-slate-800 dark:text-slate-300 dark:hover:bg-slate-800"
            }`}
          >
            <Icon size={15} aria-hidden="true" />
            {label}
          </NavLink>
        ))}
      </nav>
      <Screen user={user} />
    </div>
  );
}
