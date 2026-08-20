import { useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import {
  X,
  ChevronDown,
  LayoutDashboard,
  FileText,
  TrendingUp,
  SlidersHorizontal,
  Users,
  History,
  Package,
  Tags,
  CreditCard,
  Layers,
  ListFilter,
  Percent,
  DollarSign,
  Landmark,
  FileSignature,
  CircleDollarSign,
  UserCheck,
  Plus,
  Calendar,
  ClipboardCheck,
  Receipt,
  WalletCards,
  Undo2,
  ScrollText,
  ClipboardList,
  HandCoins,
  Settings,
  Building2,
  UserCog,
  ShieldCheck,
  KeyRound,
  CheckSquare,
  Power,
  Bell,
  Activity,
  HelpCircle,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { ROLE_LABELS } from "../config/roles";
import TopBar from "./TopBar";

const NAV_SECTIONS = [
  {
    label: "Overview",
    icon: LayoutDashboard,
    children: [
      { label: "Dashboard", href: "/billing", icon: LayoutDashboard },
      { label: "Reports", href: "/billing/reports", icon: FileText },
      { label: "Forecast", href: "/billing/reports/forecast", icon: TrendingUp },
      { label: "Settings", href: "/billing/settings", icon: SlidersHorizontal },
    ],
  },
  {
    label: "Customers",
    icon: Users,
    children: [
      { label: "Dashboard", href: "/billing/customers/dashboard", icon: LayoutDashboard },
      { label: "Customer List", href: "/billing/customers", icon: Users },
      { label: "Billing History", href: "/billing/customers/billing-history", icon: History },
      { label: "Reports", href: "/billing/customers/reports", icon: FileText },
      { label: "Profitability", href: "/billing/customers/profitability", icon: TrendingUp },
      { label: "Settings", href: "/billing/customers/settings", icon: SlidersHorizontal },
    ],
  },
  {
    label: "Products",
    icon: Package,
    children: [
      { label: "Dashboard", href: "/billing/products/dashboard", icon: LayoutDashboard },
      { label: "Product List", href: "/billing/products", icon: Package },
      { label: "Categories", href: "/billing/products/categories", icon: Tags },
      { label: "Usage Billing", href: "/billing/usage-billing", icon: TrendingUp },
      { label: "Pricing Plans", href: "/billing/products/pricing-plans", icon: CreditCard },
      { label: "Reports", href: "/billing/products/reports", icon: FileText },
      { label: "Settings", href: "/billing/products/settings", icon: SlidersHorizontal },
    ],
  },
  {
    label: "Pricing",
    icon: Tags,
    children: [
      { label: "Dashboard", href: "/billing/pricing/dashboard", icon: LayoutDashboard },
      { label: "Price Lists", href: "/billing/pricing/price-lists", icon: Tags },
      { label: "Pricing Plans", href: "/billing/pricing", icon: CreditCard },
      { label: "Tier Management", href: "/billing/pricing/tier-management", icon: Layers },
      { label: "Pricing Rules", href: "/billing/pricing/pricing-rules", icon: ListFilter },
      { label: "Discount Engine", href: "/billing/pricing/discounts", icon: Percent },
      { label: "Currency Pricing", href: "/billing/pricing/currency-pricing", icon: DollarSign },
      { label: "Tax Pricing", href: "/billing/pricing/tax-pricing", icon: Landmark },
      { label: "Reports", href: "/billing/pricing/reports", icon: FileText },
      { label: "Settings", href: "/billing/pricing/settings", icon: SlidersHorizontal },
    ],
  },
  {
    label: "Quotations",
    icon: FileText,
    children: [
      { label: "Dashboard", href: "/billing/quotations/dashboard", icon: LayoutDashboard },
      { label: "Quotation List", href: "/billing/quotations", icon: FileText },
      { label: "Reports", href: "/billing/quotations/reports", icon: FileText },
      { label: "Settings", href: "/billing/quotations/settings", icon: SlidersHorizontal },
    ],
  },
  {
    label: "Contracts",
    icon: FileSignature,
    children: [
      { label: "Dashboard", href: "/billing/contracts/dashboard", icon: LayoutDashboard },
      { label: "Contract List", href: "/billing/contracts", icon: FileSignature },
      { label: "Retainers", href: "/billing/retainers", icon: CircleDollarSign },
      { label: "Reports", href: "/billing/contracts/reports", icon: FileText },
      { label: "Settings", href: "/billing/contracts/settings", icon: SlidersHorizontal },
    ],
  },
  {
    label: "Subscriptions",
    icon: UserCheck,
    children: [
      { label: "Dashboard", href: "/billing/subscriptions/dashboard", icon: LayoutDashboard },
      { label: "Subscription List", href: "/billing/subscriptions", icon: UserCheck },
      { label: "Create Subscription", href: "/billing/subscriptions/create", icon: Plus },
      { label: "Reports", href: "/billing/subscriptions/reports", icon: FileText },
      { label: "Settings", href: "/billing/subscriptions/settings", icon: SlidersHorizontal },
    ],
  },
  {
    label: "Invoicing",
    icon: CreditCard,
    children: [
      { label: "Invoice Dashboard", href: "/billing/invoices/dashboard", icon: LayoutDashboard },
      { label: "Create Invoice", href: "/billing/invoices/create", icon: Plus },
      { label: "Invoice List", href: "/billing/invoices", icon: CreditCard },
      { label: "Invoice Schedule", href: "/billing/invoice-schedules", icon: Calendar },
      { label: "Credit Notes", href: "/billing/credit-notes", icon: ClipboardCheck },
      { label: "Credit Note Dashboard", href: "/billing/credit-notes/dashboard", icon: LayoutDashboard },
      { label: "Reports", href: "/billing/invoicing/reports", icon: FileText },
      { label: "Settings", href: "/billing/invoices/settings", icon: SlidersHorizontal },
    ],
  },
  {
    label: "Payments",
    icon: Receipt,
    children: [
      { label: "Payment List", href: "/billing/payments", icon: Receipt },
      { label: "Payment Dashboard", href: "/billing/payments/dashboard", icon: LayoutDashboard },
      { label: "Receivables & Collections", href: "/billing/collections-receivables", icon: WalletCards },
      { label: "Credits", href: "/billing/credits", icon: CircleDollarSign },
      { label: "Refunds", href: "/billing/refunds", icon: Undo2 },
      { label: "Refund Dashboard", href: "/billing/refunds/dashboard", icon: LayoutDashboard },
      { label: "Write-offs", href: "/billing/write-offs", icon: ScrollText },
      { label: "Write-off Dashboard", href: "/billing/write-offs/dashboard", icon: LayoutDashboard },
      { label: "Dunning", href: "/billing/dunning", icon: ClipboardList },
      { label: "Dunning Levels", href: "/billing/dunning/levels", icon: Layers },
      { label: "Promise to Pay", href: "/billing/promise-to-pay", icon: HandCoins },
      { label: "Collections Dashboard", href: "/billing/collections/dashboard", icon: LayoutDashboard },
      { label: "Reports", href: "/billing/payments/reports", icon: FileText },
      { label: "Settings", href: "/billing/payments/settings", icon: SlidersHorizontal },
    ],
  },
  {
    label: "Tax",
    icon: CircleDollarSign,
    children: [
      { label: "Dashboard", href: "/billing/tax/dashboard", icon: LayoutDashboard },
      { label: "Tax Rates", href: "/billing/tax", icon: CircleDollarSign },
      { label: "Tax Configuration", href: "/billing/tax/configuration", icon: Settings },
      { label: "Reports", href: "/billing/tax/reports", icon: FileText },
      { label: "Settings", href: "/billing/tax/settings", icon: SlidersHorizontal },
    ],
  },
  {
    label: "Overview",
    icon: LayoutDashboard,
    superAdminOnly: true,
    children: [
      { label: "Dashboard", href: "/super-admin/dashboard", icon: LayoutDashboard },
    ],
  },
  {
    label: "Platform",
    icon: Building2,
    superAdminOnly: true,
    children: [
      { label: "Organizations", href: "/super-admin/organizations", icon: Building2 },
      { label: "Users", href: "/super-admin/users", icon: UserCog },
      { label: "Settings", href: "/super-admin/settings", icon: Settings },
    ],
  },
  {
    label: "Commercial",
    icon: Package,
    superAdminOnly: true,
    children: [
      { label: "Plans", href: "/super-admin/commercial/plans", icon: Package },
      { label: "Subscriptions", href: "/super-admin/commercial/subscriptions", icon: UserCheck },
      { label: "Entitlements", href: "/super-admin/commercial/entitlements", icon: KeyRound },
    ],
  },
  {
    label: "Governance",
    icon: ShieldCheck,
    superAdminOnly: true,
    children: [
      { label: "Audit Logs", href: "/super-admin/audit-logs", icon: ScrollText },
      { label: "Approval Queue", href: "/super-admin/approval-queue", icon: CheckSquare },
      { label: "Production Readiness", href: "/super-admin/production-readiness", icon: ClipboardCheck },
    ],
  },
  {
    label: "Operations",
    icon: Power,
    superAdminOnly: true,
    children: [
      { label: "Kill Switch", href: "/super-admin/kill-switch", icon: Power },
    ],
  },
];

const TOP_NAV_ITEMS = [
  { label: "Dashboard", href: "/organization-admin/dashboard", icon: LayoutDashboard, orgAdminOnly: true },
  { label: "My Organization", href: "/organization-admin/organization", icon: Building2, orgAdminOnly: true },
];

const WORKSPACE_NAV_ITEMS = [
  { label: "Overview", href: "/billing/workspace/dashboard", icon: LayoutDashboard },
  { label: "Organization Profile", href: "/billing/workspace/organization", icon: Building2 },
  { label: "Billing Subscription", href: "/billing/workspace/subscription", icon: CreditCard },
  { label: "Activity Timeline", href: "/billing/workspace/activity", icon: Activity },
  { label: "Notifications", href: "/billing/workspace/notifications", icon: Bell },
  { label: "Help & Documentation", href: "/billing/workspace/help", icon: HelpCircle },
];

const FOOTER_NAV_ITEMS = [
  { label: "User Management", href: "/organization-admin/users", icon: UserCog },
];

function isActive(href, pathname, search = "") {
  if (!href) return false;
  const cleanHref = href.split(/[?#]/)[0];
  const hrefSearch = href.includes("?") ? `?${href.split("?")[1].split("#")[0]}` : "";
  if (cleanHref === "/billing") return pathname === "/billing" && (!hrefSearch || search === hrefSearch);
  if (hrefSearch) return pathname === cleanHref && search === hrefSearch;
  return pathname === cleanHref || pathname.startsWith(`${cleanHref}/`);
}

function MenuItem({ item, pathname, search, onNavigate, expanded, onToggle, sectionStyle = false }) {
  const hasActiveChild = item.children
    ? item.children.some((child) => isActive(child.href, pathname, search))
    : false;

  const active = isActive(item.href, pathname, search) || hasActiveChild;

  if (item.children) {
    return (
      <div>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className={`group flex w-full items-center justify-between gap-3 rounded-[14px] border px-4 py-3 text-left text-sm transition duration-200 ${
            active
              ? "border-[#2563EB]/40 bg-gradient-to-r from-[#1D4ED8] via-[#2563EB] to-[#3B82F6] text-white shadow-[0_18px_40px_rgba(37,99,235,0.35)]"
              : "border-white/10 bg-white/5 text-[#CBD5E1] hover:border-white/20 hover:bg-white/10"
          }`}
        >
          <span className="inline-flex items-center gap-3">
            <item.icon className={`h-4 w-4 transition duration-200 ${active ? "text-white" : "text-[#94A3B8]"}`} />
            <span>{item.label}</span>
          </span>
          <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${expanded ? "rotate-180 text-white" : "text-[#94A3B8]"}`} />
        </button>
        {expanded ? (
          <div className="mt-1.5 space-y-1 border-l border-white/10 pl-3 ml-[22px]">
            {item.children.map((child) => (
              <MenuItem key={child.label} item={child} pathname={pathname} search={search} onNavigate={onNavigate} />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <NavLink
      to={item.href ?? "/billing"}
      end
      onClick={onNavigate}
      className={`group flex items-center gap-3 text-sm transition duration-200 ${
        sectionStyle ? "rounded-[14px] border px-4 py-3" : "rounded-[12px] border px-4 py-2"
      } ${
        isActive(item.href, pathname, search)
          ? "border-[#2563EB]/40 bg-gradient-to-r from-[#1D4ED8] via-[#2563EB] to-[#3B82F6] text-white shadow-[0_18px_40px_rgba(37,99,235,0.35)]"
          : sectionStyle
            ? "border-white/10 bg-white/5 text-[#CBD5E1] hover:border-white/20 hover:bg-white/10"
            : "border-transparent text-[#94A3B8] hover:border-white/10 hover:bg-white/5 hover:text-white"
      }`}
    >
      <item.icon className="h-4 w-4 shrink-0" />
      <span className="flex-1 truncate">{item.label}</span>
    </NavLink>
  );
}

function SidebarContent({ onNavigate, role }) {
  const { pathname, search } = useLocation();

  const visibleSections = NAV_SECTIONS.filter((section) => {
    if (role === "super_admin") return !!section.superAdminOnly;
    if (section.superAdminOnly) return false;
    return true;
  });

  const visibleTop =
    role === "super_admin" ? [] : TOP_NAV_ITEMS.filter((item) => !item.orgAdminOnly || role !== "billing_admin");

  const showWorkspace = role === "billing_admin";
  const showOrgNav = role === "org_admin";

  const visibleFooter = role === "super_admin" || role === "org_admin" ? FOOTER_NAV_ITEMS : [];

  const [openSection, setOpenSection] = useState(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-6 flex shrink-0 items-center justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Link
            to={role === "super_admin" ? "/super-admin/dashboard" : role === "org_admin" ? "/organization-admin/dashboard" : showWorkspace ? "/billing/workspace/dashboard" : "/billing"}
            onClick={onNavigate}
            className="inline-flex w-fit items-center rounded-xl bg-white px-4 py-2.5 shadow-sm"
          >
            <img src="/zoiko-billing-logo.png" alt="Zoiko Billing" className="h-10 w-auto" />
          </Link>
          {ROLE_LABELS[role] ? (
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-[#94A3B8]">
              {ROLE_LABELS[role]}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onNavigate}
          className="inline-flex h-9 w-9 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-white transition hover:border-white/20 hover:bg-white/10 lg:hidden"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="sidebar-nav flex-1 min-h-0 space-y-3 overflow-y-auto overscroll-contain pb-6 pr-1">
        {showOrgNav && visibleTop.length > 0 ? (
          <div className="mb-6 space-y-3 border-b border-white/10 pb-6">
            {visibleTop.map((item) => (
              <MenuItem
                key={item.label}
                item={item}
                pathname={pathname}
                search={search}
                onNavigate={onNavigate}
                sectionStyle
              />
            ))}
          </div>
        ) : null}

        {showWorkspace ? (
          <div className="mb-6">
            <p className="mb-3 px-4 text-[10px] font-bold uppercase tracking-[0.32em] text-[#64748B]">
              My Organization
            </p>
            <div className="space-y-1.5">
              {WORKSPACE_NAV_ITEMS.map((item) => (
                <MenuItem
                  key={item.label}
                  item={item}
                  pathname={pathname}
                  search={search}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </div>
        ) : null}

        {role === "super_admin" ? null : (
          <p className="mb-1 px-4 pt-2 text-[10px] font-bold uppercase tracking-[0.32em] text-[#64748B]">
            {showWorkspace ? "Billing" : "Navigation"}
          </p>
        )}

        {visibleSections.map((section) => (
          <MenuItem
            key={section.label}
            item={section}
            pathname={pathname}
            search={search}
            onNavigate={onNavigate}
            expanded={openSection === section.label}
            onToggle={() => setOpenSection(openSection === section.label ? null : section.label)}
          />
        ))}

        {visibleFooter.length > 0 ? (
          <div className="mt-10 border-t border-white/10 pt-6">
            {visibleFooter.map((item) => (
              <MenuItem
                key={item.label}
                item={item}
                pathname={pathname}
                search={search}
                onNavigate={onNavigate}
                sectionStyle
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function BillingShell({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { role } = useAuth();

  return (
    <div className="min-h-screen bg-[#F8F7F4]">
      <div
        className={`fixed inset-0 z-30 bg-slate-950/40 transition-opacity lg:hidden ${
          sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setSidebarOpen(false)}
      />

      <aside
        className={`fixed top-[65px] bottom-0 left-0 z-40 w-72 overflow-hidden border-r border-white/10 bg-gradient-to-b from-[#0B1220] via-[#101B33] to-[#0A0F1F] px-4 py-6 shadow-[0_24px_80px_rgba(2,6,23,0.45)] transition-transform lg:top-0 lg:bottom-0 lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <SidebarContent onNavigate={() => setSidebarOpen(false)} role={role} />
      </aside>

      <TopBar menuOpen={sidebarOpen} onMenuClick={() => setSidebarOpen(!sidebarOpen)} />

      <div className="lg:pl-72">
        <main className="w-full pt-[65px]">{children}</main>
      </div>
    </div>
  );
}
