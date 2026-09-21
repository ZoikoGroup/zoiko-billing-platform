import { useState, lazy, Suspense } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
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
  Power,
  Bell,
  Activity,
  HelpCircle,
  Gauge,
  AlertTriangle,
  ChevronsLeft,
  ChevronsRight,
  LogOut,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { ROLE_LABELS } from "../config/roles";
import useCockpitStatus from "../hooks/useCockpitStatus";
import TopBar from "./TopBar";
import ZoikoMark from "./ZoikoMark";
import PrivilegedSessionBanner from "./PrivilegedSessionBanner";
import TriageStrip from "./TriageStrip";
import CommandPalette from "./CommandPalette";
import TrialBanner from "./TrialBanner";

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
      { label: "Plans", href: "/billing/subscriptions/plans", icon: Package },
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
];

// Flat, non-collapsible super_admin sidebar (replaces the accordion
// treatment above, which org_admin/billing_admin still use unchanged).
// Consolidated from 34 accordion entries down to 8 direct links per the
// reviewed Section 0 plan — everything else moved into in-page tabs of
// the hub page it conceptually belongs to (routes were never deleted from
// App.jsx, only demoted from a direct sidebar link to a tab).
const SUPER_ADMIN_NAV_SECTIONS = [
  {
    label: "Command Center",
    items: [
      { label: "Command Center Hub", href: "/super-admin/command-center", icon: Gauge },
    ],
  },
  {
    label: "Platform",
    items: [
      { label: "Organizations", href: "/super-admin/organizations", icon: Building2 },
      { label: "Users", href: "/super-admin/users", icon: UserCog },
    ],
  },
  {
    label: "Finance",
    items: [
      { label: "Financial Operations Hub", href: "/super-admin/financial-operations", icon: CircleDollarSign },
      { label: "Products & Pricing", href: "/super-admin/commercial/plans", icon: Package },
    ],
  },
  {
    label: "Reporting",
    items: [
      { label: "Audit & Evidence", href: "/super-admin/audit-logs", icon: ScrollText },
      { label: "System Health", href: "/super-admin/reliability", icon: Activity },
    ],
  },
];

const TOP_NAV_ITEMS = [
  { label: "Dashboard", href: "/organization-admin/dashboard", icon: LayoutDashboard, orgAdminOnly: true },
  { label: "My Organization", href: "/organization-admin/organization", icon: Building2, orgAdminOnly: true },
  { label: "Zoiko Subscription", href: "/billing/workspace/zoiko-subscription", icon: CreditCard, orgAdminOnly: true },
];

const WORKSPACE_NAV_ITEMS = [
  { label: "Overview", href: "/billing/workspace/dashboard", icon: LayoutDashboard },
  { label: "Organization Profile", href: "/billing/workspace/organization", icon: Building2 },
  { label: "Billing Subscription", href: "/billing/workspace/subscription", icon: CreditCard },
  { label: "Zoiko Subscription", href: "/billing/workspace/zoiko-subscription", icon: CreditCard },
  { label: "Usage", href: "/billing/workspace/usage", icon: Gauge },
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
              ? "border-brand/40 bg-gradient-to-r from-brand-700 via-brand-600 to-brand-500 text-white shadow-[0_18px_40px_rgba(37,99,235,0.35)]"
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
          ? "border-brand/40 bg-gradient-to-r from-brand-700 via-brand-600 to-brand-500 text-white shadow-[0_18px_40px_rgba(37,99,235,0.35)]"
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

// Quiet active-state treatment for the flat super_admin sidebar — a subtle
// fill + left accent border, not the bold gradient pill MenuItem uses
// elsewhere in this file (org_admin/billing_admin keep that treatment
// unchanged; this redesign is scoped to super_admin only, see Section 3).
function FlatSectionLabel({ label }) {
  return (
    <p className="mb-1.5 mt-4 px-3 text-[10px] font-bold uppercase tracking-[0.22em] text-[#64748B] first:mt-0">
      {label}
    </p>
  );
}

function FlatNavItem({ href, icon: Icon, label, pathname, search, onNavigate, collapsed }) {
  const active = isActive(href, pathname, search);
  return (
    <NavLink
      to={href}
      end
      onClick={onNavigate}
      title={collapsed ? label : undefined}
      className={`group flex items-center gap-3 rounded-xl border-l-2 py-2.5 text-sm transition-colors duration-150 ${
        collapsed ? "justify-center px-2" : "px-3"
      } ${
        active
          ? "border-brand-500 bg-white/10 text-white"
          : "border-transparent text-[#94A3B8] hover:bg-white/5 hover:text-[#CBD5E1]"
      }`}
    >
      <Icon className={`h-[18px] w-[18px] shrink-0 ${active ? "text-brand-400" : "text-[#94A3B8] group-hover:text-[#CBD5E1]"}`} />
      {collapsed ? null : (
        <span className={`truncate ${active ? "font-semibold text-white" : ""}`}>{label}</span>
      )}
    </NavLink>
  );
}

function CockpitBadge({ variant, value }) {
  // No value yet (still loading) or nothing to report — an empty cockpit
  // item is a clean cockpit item, so render nothing rather than a "0".
  if (value === null || value === undefined) return null;
  if (variant === "dot") {
    return (
      <span
        className={`h-2 w-2 rounded-full ${value ? "bg-emerald-400" : "bg-red-500"}`}
        aria-hidden="true"
      />
    );
  }
  if (!value) return null;
  return (
    <span className="inline-flex min-w-[20px] items-center justify-center rounded-full bg-white/15 px-1.5 py-0.5 text-[11px] font-bold text-white">
      {value}
    </span>
  );
}

function CockpitLink({ to, icon: Icon, label, badge, badgeVariant, pathname, search, onNavigate, collapsed }) {
  const active = isActive(to, pathname, search);
  return (
    <NavLink
      to={to}
      end
      onClick={onNavigate}
      title={collapsed ? label : undefined}
      className={`group flex items-center gap-3 rounded-xl border-l-2 py-2.5 text-sm transition-colors duration-150 ${
        collapsed ? "justify-center px-2" : "justify-between px-3"
      } ${
        active
          ? "border-brand-500 bg-white/10 text-white"
          : "border-transparent text-[#94A3B8] hover:bg-white/5 hover:text-[#CBD5E1]"
      }`}
    >
      <span className={`inline-flex items-center gap-3 ${collapsed ? "" : "min-w-0"}`}>
        <Icon className={`h-[18px] w-[18px] shrink-0 ${active ? "text-brand-400" : "text-[#94A3B8] group-hover:text-[#CBD5E1]"}`} />
        {collapsed ? null : <span className={`truncate ${active ? "font-semibold text-white" : ""}`}>{label}</span>}
      </span>
      {!collapsed && badgeVariant ? <CockpitBadge variant={badgeVariant} value={badge} /> : null}
    </NavLink>
  );
}

// Accordion sidebar for org_admin / billing_admin — unchanged by the
// super_admin flat-sidebar redesign (see SuperAdminSidebarContent below,
// which super_admin renders instead of this component entirely).
function SidebarContent({ onNavigate, role }) {
  const { pathname, search } = useLocation();

  // NAV_SECTIONS no longer carries any superAdminOnly entries — those moved
  // to SUPER_ADMIN_NAV_SECTIONS entirely, so every remaining section here
  // applies to org_admin/billing_admin.
  const visibleSections = NAV_SECTIONS;

  const visibleTop = TOP_NAV_ITEMS.filter((item) => !item.orgAdminOnly || role !== "billing_admin");

  const showWorkspace = role === "billing_admin";
  const showOrgNav = role === "org_admin";

  const visibleFooter = role === "org_admin" ? FOOTER_NAV_ITEMS : [];

  // Each section tracks its own open/closed state independently (a Set of
  // labels the user has explicitly opened), rather than one shared value —
  // expanding "Governance & Security" must not silently collapse whatever
  // else was already open. A section not yet touched by the user still
  // defaults open if the current route matches one of its children.
  const [openSections, setOpenSections] = useState(() => new Set());

  function isSectionExpanded(section) {
    if (openSections.has(section.label)) return true;
    if (openSections.has(`!${section.label}`)) return false;
    return section.children?.some((c) => isActive(c.href, pathname, search)) ?? false;
  }

  function toggleSection(section) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      const currentlyExpanded = isSectionExpanded(section);
      if (currentlyExpanded) {
        next.delete(section.label);
        next.add(`!${section.label}`);
      } else {
        next.delete(`!${section.label}`);
        next.add(section.label);
      }
      return next;
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-6 flex shrink-0 items-center justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Link
            to={role === "org_admin" ? "/organization-admin/dashboard" : showWorkspace ? "/billing/workspace/dashboard" : "/billing"}
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

        <p className="mb-1 px-4 pt-2 text-[10px] font-bold uppercase tracking-[0.32em] text-[#64748B]">
          {showWorkspace ? "Billing" : "Navigation"}
        </p>

        {visibleSections.map((section) => (
          <MenuItem
            key={section.label}
            item={section}
            pathname={pathname}
            search={search}
            onNavigate={onNavigate}
            expanded={isSectionExpanded(section)}
            onToggle={() => toggleSection(section)}
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

function initialsOf(user) {
  if (!user) return "SA";
  if (user.name) {
    const parts = user.name.trim().split(/\s+/);
    return parts.slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  }
  if (user.first_name || user.last_name) {
    return `${user.first_name?.[0] || ""}${user.last_name?.[0] || ""}`.toUpperCase() || "SA";
  }
  if (user.email) return user.email.slice(0, 2).toUpperCase();
  return "SA";
}

// Flat, non-collapsible sidebar for super_admin only — no accordions, no
// bold gradient-pill active state (see FlatNavItem/CockpitLink's quiet
// treatment), a collapsible rail, and a real profile/sign-out footer.
// org_admin/billing_admin keep SidebarContent above, completely unchanged.
function SuperAdminSidebarContent({ onNavigate, cockpit, collapsed, onToggleCollapsed }) {
  const { pathname, search } = useLocation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = () => {
    onNavigate();
    logout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`mb-4 flex shrink-0 items-center gap-3 ${collapsed ? "justify-center" : "justify-between"}`}>
        {collapsed ? null : (
          <div className="flex flex-col gap-2">
            <Link
              to="/super-admin/dashboard"
              onClick={onNavigate}
              className="inline-flex w-fit items-center rounded-xl bg-white px-4 py-2.5 shadow-sm"
            >
              <img src="/zoiko-billing-logo.png" alt="Zoiko Billing" className="h-10 w-auto" />
            </Link>
            <p className="text-xs font-bold uppercase tracking-[0.3em] text-[#94A3B8]">
              {ROLE_LABELS.super_admin || "Super Admin"}
            </p>
          </div>
        )}
        <button
          type="button"
          onClick={onToggleCollapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-[#94A3B8] transition hover:border-white/20 hover:bg-white/10 hover:text-white lg:inline-flex"
        >
          {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={onNavigate}
          className="inline-flex h-9 w-9 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-white transition hover:border-white/20 hover:bg-white/10 lg:hidden"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="sidebar-nav flex-1 min-h-0 space-y-1 overflow-y-auto overscroll-contain pr-1">
        <div className="cockpit-strip mb-3 space-y-1 border-b border-white/10 pb-4">
          <CockpitLink
            to="/super-admin/dashboard"
            icon={LayoutDashboard}
            label="Platform Overview"
            pathname={pathname}
            search={search}
            onNavigate={onNavigate}
            collapsed={collapsed}
          />
        </div>

        {SUPER_ADMIN_NAV_SECTIONS.map((section) => (
          <div key={section.label}>
            {collapsed ? null : <FlatSectionLabel label={section.label} />}
            <div className="space-y-1">
              {section.items.map((item) => (
                <FlatNavItem
                  key={item.href}
                  href={item.href}
                  icon={item.icon}
                  label={item.label}
                  pathname={pathname}
                  search={search}
                  onNavigate={onNavigate}
                  collapsed={collapsed}
                />
              ))}
            </div>
          </div>
        ))}

        <div className="mt-4 border-t border-white/10 pt-3">
          {collapsed ? null : <FlatSectionLabel label="Operations" />}
          <div className="space-y-1">
            <CockpitLink
              to="/super-admin/triage"
              icon={AlertTriangle}
              label="Triage & Attention"
              badge={cockpit.openIncidents}
              badgeVariant="count"
              pathname={pathname}
              search={search}
              onNavigate={onNavigate}
              collapsed={collapsed}
            />
            <CockpitLink
              to="/super-admin/kill-switch"
              icon={Power}
              label="Kill Switch"
              badge={cockpit.killSwitchEnabled}
              badgeVariant="dot"
              pathname={pathname}
              search={search}
              onNavigate={onNavigate}
              collapsed={collapsed}
            />
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-white/10 pt-4">
        <div className={`flex items-center gap-3 rounded-xl px-1 py-1.5 ${collapsed ? "justify-center" : ""}`}>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-500/20 text-sm font-bold text-brand-300">
            {initialsOf(user)}
          </div>
          {collapsed ? null : (
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-white">
                {user?.name || user?.email || "Super Admin"}
              </p>
              <p className="truncate text-[11px] font-medium text-[#94A3B8]">
                {ROLE_LABELS.super_admin || "Super Admin"}
              </p>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={handleSignOut}
          title={collapsed ? "Sign out" : undefined}
          className={`mt-2 flex w-full items-center gap-3 rounded-xl bg-white/5 py-2.5 text-sm text-[#CBD5E1] transition-colors hover:bg-white/10 hover:text-white ${
            collapsed ? "justify-center px-2" : "px-3"
          }`}
        >
          <LogOut className="h-[18px] w-[18px] shrink-0" />
          {collapsed ? null : <span>Sign out</span>}
        </button>

        {collapsed ? null : (
          <p className="mt-4 text-center text-[10px] font-medium uppercase tracking-[0.2em] text-[#64748B]">
            Powered by
            <br />
            <span className="text-xs font-bold tracking-normal text-[#94A3B8]">Zoiko Billing</span>
          </p>
        )}
      </div>
    </div>
  );
}

const AssistantPanel = lazy(() => import("../modules/ai-assistant/AssistantPanel"));

const SIDEBAR_COLLAPSED_STORAGE_KEY = "superAdminSidebarCollapsed";

function readStoredCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export default function BillingShell({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const { role } = useAuth();
  const cockpit = useCockpitStatus(role === "super_admin");
  const [collapsed, setCollapsed] = useState(readStoredCollapsed);

  const isSuperAdmin = role === "super_admin";
  const sidebarCollapsed = isSuperAdmin && collapsed;

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // localStorage unavailable (private mode, blocked storage) — the
        // toggle still works for this session, it just won't persist.
      }
      return next;
    });
  }

  return (
    <div className="h-screen overflow-hidden bg-[#F8F7F4]">
      <div
        className={`fixed inset-0 z-30 bg-slate-950/40 transition-opacity lg:hidden ${
          sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setSidebarOpen(false)}
      />

      <TopBar menuOpen={sidebarOpen} onMenuClick={() => setSidebarOpen((open) => !open)} sidebarCollapsed={sidebarCollapsed} />

      {/* Content row: sidebar | main workspace | chatbot panel (when open) */}
      <div className="flex h-screen">
        {/* Sidebar — full height, overlaps TopBar */}
        <aside
          className={`fixed top-0 bottom-0 left-0 z-40 overflow-hidden border-r border-white/10 bg-gradient-to-b from-[#0B1220] via-[#101B33] to-[#0A0F1F] px-4 py-6 shadow-[0_24px_80px_rgba(2,6,23,0.45)] transition-[width,transform] lg:translate-x-0 ${
            sidebarCollapsed ? "w-[76px]" : "w-72"
          } ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}
        >
          <div className="max-lg:pt-[65px] h-full">
            {isSuperAdmin ? (
              <SuperAdminSidebarContent
                onNavigate={() => setSidebarOpen(false)}
                cockpit={cockpit}
                collapsed={sidebarCollapsed}
                onToggleCollapsed={toggleCollapsed}
              />
            ) : (
              <SidebarContent onNavigate={() => setSidebarOpen(false)} role={role} />
            )}
          </div>
        </aside>

        {/* Main billing workspace — flex-1, scrolls independently */}
        <main className={`flex-1 min-w-0 pt-[65px] overflow-y-auto ${sidebarCollapsed ? "lg:pl-[76px]" : "lg:pl-72"}`}>
          {role === "super_admin" && (
            <>
              <PrivilegedSessionBanner />
              <TriageStrip />
            </>
          )}
          <TrialBanner />
          {/* Single source of truth for the sidebar-to-content gutter and page
              margins — every page renders here as {children} with no need to
              (and no longer any reason to) set its own horizontal padding. */}
          <div className="min-w-0 max-w-full overflow-x-hidden px-4 py-6 sm:px-6 lg:px-8">
            {children}
          </div>
        </main>

        {/* AI Assistant panel — flex child on desktop, full-screen sheet on mobile */}
        <Suspense fallback={null}>
          <AssistantPanel
            isOpen={assistantOpen}
            onClose={() => setAssistantOpen(false)}
          />
        </Suspense>
      </div>

      {/* AI Assistant launcher — hidden when panel is open on desktop */}
      <button
        onClick={() => setAssistantOpen(true)}
        className={`fixed bottom-6 right-6 z-40 rounded-lg shadow-lg hover:shadow-xl transition-all hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 ${
          assistantOpen ? "hidden" : ""
        }`}
        aria-label="Open AI Billing Assistant"
        title="AI Billing Assistant"
      >
        <ZoikoMark size={56} rounded="rounded-lg" showAccentDot className="transition-transform" />
      </button>

      {role === "super_admin" && <CommandPalette />}
    </div>
  );
}
