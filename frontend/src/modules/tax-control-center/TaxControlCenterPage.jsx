import { NavLink, Navigate, useParams } from "react-router-dom";
import {
  Activity, BookOpenCheck, Copy, FileSearch, FileStack, Globe2, Inbox, LayoutDashboard, Landmark, ListTree, Map, Percent,
} from "lucide-react";

import { getStoredUser } from "../../api/client";
import { PageHeader } from "../../components/billing-ui";
import { canReadTaxRegistry } from "./access";
import { NoAccess } from "./shared";
import ApprovalsInboxScreen from "./ApprovalsInboxScreen";
import SourceRegisterScreen from "./SourceRegisterScreen";
import RatesScreen from "./RatesScreen";
import MarketAvailabilityScreen from "./MarketAvailabilityScreen";
import RulePacksScreen from "./RulePacksScreen";
import ProviderOperationsScreen, { FindingsScreen } from "./ProviderOperationsScreen";
import { ExplorerScreen, OverviewScreen, TaxCodeCatalogueScreen } from "./ReadOnlyScreens";
import ShadowSelectionScreen from "./ShadowSelectionScreen";

/* Tax Control Center (ZB-TAX-ARCH-001 Phase 5a): the platform tax-ops
 * console's sign-off screens. Zoiko tax staff only (TAX_REVIEWER,
 * TAX_PUBLISHER); every other platform role, platform administrators
 * included, sees the no-access page. Platform data only. */

export const TAX_SECTIONS = [
  { key: "overview", label: "Overview", icon: LayoutDashboard, element: OverviewScreen },
  { key: "inbox", label: "Approvals inbox", icon: Inbox, element: ApprovalsInboxScreen },
  { key: "sources", label: "Source register", icon: Landmark, element: SourceRegisterScreen },
  { key: "rates", label: "Rates & change review", icon: Percent, element: RatesScreen },
  { key: "availability", label: "Market availability", icon: Map, element: MarketAvailabilityScreen },
  { key: "rule-packs", label: "Rule packs", icon: BookOpenCheck, element: RulePacksScreen },
  { key: "explorer", label: "Jurisdictions & rates", icon: Globe2, element: ExplorerScreen },
  { key: "tax-codes", label: "Tax codes", icon: ListTree, element: TaxCodeCatalogueScreen },
  { key: "providers", label: "Provider operations", icon: Activity, element: ProviderOperationsScreen },
  { key: "findings", label: "Findings", icon: FileSearch, element: FindingsScreen },
  { key: "shadow", label: "Shadow compare", icon: Copy, element: ShadowSelectionScreen },
];

export default function TaxControlCenterPage() {
  const { section } = useParams();
  const user = getStoredUser();
  if (!canReadTaxRegistry(user?.platform_role)) return <NoAccess />;
  const current = TAX_SECTIONS.find((s) => s.key === section);
  if (!current) return <Navigate to="/super-admin/tax/inbox" replace />;
  const Screen = current.element;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Tax Control Center"
        description="Sign-off console for the platform tax registry: sources, rates, market availability and rule packs. Every change needs a maker and a different checker; approving and publishing need MFA."
        icon={FileStack}
        crumbs={[{ label: "Super Admin", href: "/super-admin/dashboard" }, { label: "Tax Control Center" }]}
      />
      <nav aria-label="Tax Control Center sections" className="flex max-w-full gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-slate-50/60 p-1 dark:border-slate-700 dark:bg-slate-900">
        {TAX_SECTIONS.map(({ key, label, icon: Icon }) => (
          <NavLink
            key={key}
            to={`/super-admin/tax/${key}`}
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
