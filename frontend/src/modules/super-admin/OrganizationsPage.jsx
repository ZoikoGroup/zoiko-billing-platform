import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Activity, Building2, ChevronRight, Layers, Plus, ShieldAlert } from "lucide-react";
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import {
  createOrganization,
  listOrganizations,
} from "../../service/commercialService";
import { PageHeader, DataTable, SearchInput, Modal, Field, Button } from "../../components/billing-ui";
import { Pagination, StatusBadge, ErrorState, Spinner, SuccessMessage, DashboardChartCard, DashboardChartErrorBoundary } from "../../components/billing-shared";
import {
  PAGE_SIZE,
  LIFECYCLE_STATE_BADGES,
  formatDateTime,
  displayValue,
  CommercialSourceBadge,
  CommercialClassificationBadge,
  LifecycleStateBadge,
  formatTrialRemaining,
  TrialProgressBar,
} from "./constants";
import LifecycleOnboardingPage from "./LifecycleOnboardingPage";
import TenantHealthPage from "./TenantHealthPage";
import SupportAccessPage from "./SupportAccessPage";

const EMPTY_ORG_FORM = {
  organization_name: "",
  industry: "",
  email: "",
  address: "",
  phone: "",
  tax_no: "",
  registration_number: "",
};

// Lifecycle filter options mirror the backend enum — labels only.
const LIFECYCLE_FILTER_OPTIONS = Object.entries(LIFECYCLE_STATE_BADGES).map(
  ([value, meta]) => ({ value, label: meta.label })
);

// Platform sidebar consolidation — Lifecycle & Onboarding, Tenant Health and
// Support Access no longer have their own sidebar links; they're reachable
// here as tabs (their standalone routes still work unchanged for deep links).
const VALID_TABS = ["organizations", "lifecycle", "health", "support"];
const TABS = [
  { key: "organizations", label: "Organizations", icon: Building2 },
  { key: "lifecycle", label: "Lifecycle & Onboarding", icon: Layers },
  { key: "health", label: "Tenant Health", icon: Activity },
  { key: "support", label: "Support Access", icon: ShieldAlert },
];

function CreateOrganizationModal({ open, onClose, onCreated }) {
  const [form, setForm] = useState(EMPTY_ORG_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Reset to a blank form each time the modal is (re-)opened, so a prior
  // create/cancel never leaks into the next one.
  useEffect(() => {
    if (open) {
      setForm(EMPTY_ORG_FORM);
      setError(null);
    }
  }, [open]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const org = await createOrganization(form);
      onCreated(org);
    } catch (err) {
      setError(err?.message || "Failed to create organization.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New Organization" icon={Building2} size="lg">
      <form id="create-organization-form" onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="new-org-name" required className="sm:col-span-2">
          <input
            id="new-org-name"
            required
            value={form.organization_name}
            onChange={set("organization_name")}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        <Field label="Industry" htmlFor="new-org-industry">
          <input
            id="new-org-industry"
            value={form.industry}
            onChange={set("industry")}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        <Field label="Email" htmlFor="new-org-email">
          <input
            id="new-org-email"
            type="email"
            value={form.email}
            onChange={set("email")}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        <Field label="Address" htmlFor="new-org-address" className="sm:col-span-2">
          <input
            id="new-org-address"
            value={form.address}
            onChange={set("address")}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        <Field label="Phone" htmlFor="new-org-phone">
          <input
            id="new-org-phone"
            value={form.phone}
            onChange={set("phone")}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        <Field label="Tax No" htmlFor="new-org-tax">
          <input
            id="new-org-tax"
            value={form.tax_no}
            onChange={set("tax_no")}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        <Field label="Registration Number" htmlFor="new-org-registration" className="sm:col-span-2">
          <input
            id="new-org-registration"
            value={form.registration_number}
            onChange={set("registration_number")}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 sm:col-span-2">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 sm:col-span-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default function OrganizationsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = VALID_TABS.includes(searchParams.get("tab")) ? searchParams.get("tab") : "organizations";
  const [activeTab, setActiveTabState] = useState(initialTab);
  const setActiveTab = (tab) => {
    setActiveTabState(tab);
    setSearchParams({ tab }, { replace: true });
  };
  const [orgs, setOrgs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [lifecycleFilter, setLifecycleFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState(location.state?.notice || null);

  const load = useCallback(async (pageNum, term, state) => {
    setLoading(true);
    setError(null);
    try {
      const data = await listOrganizations({
        skip: (pageNum - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
        search: term,
        lifecycle_state: state || undefined,
      });
      setOrgs(data.organizations || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err?.message || "Failed to load organizations.");
      setOrgs([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(page, search, lifecycleFilter);
  }, [load, page, search, lifecycleFilter]);

  useEffect(() => {
    if (location.state?.notice) {
      // Clear the router state so a page refresh doesn't re-show the banner.
      navigate(location.pathname, { replace: true, state: {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSearch = useCallback((value) => {
    setSearch(value);
    setPage(1);
  }, []);

  const columns = useMemo(
    () => [
      {
        key: "organization",
        label: "Organization",
        render: (row) => (
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
              <Building2 size={16} />
            </span>
            <span className="min-w-0">
              <span className="block font-semibold text-slate-800">{row.organization_name}</span>
              <span className="block truncate text-xs text-slate-500" title={row.organization_code}>{row.organization_code}</span>
            </span>
          </div>
        ),
      },
      {
        key: "lifecycle_state",
        label: "Lifecycle",
        render: (row) => <LifecycleStateBadge value={row.lifecycle_state} />,
      },
      {
        key: "billing_source",
        label: "Source / Class",
        hideBelow: "lg",
        render: (row) => (
          <div className="flex flex-col items-start gap-1">
            <CommercialSourceBadge value={row.billing_source} />
            <CommercialClassificationBadge value={row.billing_classification} />
          </div>
        ),
      },
      {
        key: "subscription_plan",
        label: "Plan",
        hideBelow: "md",
        render: (row) =>
          row.subscription_plan_code ? (
            <span>
              <span className="block font-medium text-slate-700">
                {row.subscription_plan_name || row.subscription_plan_code}
              </span>
              <span className="block text-xs text-slate-500">
                {displayValue(row.subscription_status)}
              </span>
            </span>
          ) : (
            <span className="text-xs text-slate-400">No plan assigned</span>
          ),
      },
      {
        key: "users",
        label: "Users",
        hideBelow: "lg",
        render: (row) => (
          <span className="text-xs text-slate-600">
            {displayValue(row.active_users)}/{displayValue(row.total_users)} active
            {row.org_admins > 0 && (
              <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                {row.org_admins} admin{row.org_admins === 1 ? "" : "s"}
              </span>
            )}
          </span>
        ),
      },
      {
        key: "activity_created",
        label: "Activity / Created",
        hideBelow: "xl",
        render: (row) => (
          <span className="block text-xs text-slate-500 leading-5">
            <span className="block" title="Last activity">
              {row.last_activity_at ? formatDateTime(row.last_activity_at) : "No activity"}
            </span>
            <span className="block text-slate-400" title="Created">
              {formatDateTime(row.created_at)}
            </span>
          </span>
        ),
      },
      {
        key: "open",
        label: "",
        width: 40,
        render: () => <ChevronRight size={15} className="text-slate-300" />,
      },
    ],
    []
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Trial Period Overview — remaining trial days per org on the current
  // page (trial_ends_at lives on the org's commercial subscription). Most
  // urgent first; all bars rendered blue.
  const trialChartData = useMemo(() => {
    const data = [];
    for (const row of orgs) {
      if (!row.organization_name || !row.trial_ends_at) continue;
      if (row.subscription_status !== "trialing" && row.subscription_status !== "pending") continue;
      const end = new Date(row.trial_ends_at);
      if (Number.isNaN(end.getTime())) continue;
      const days = Math.max(0, Math.ceil((end.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
      data.push({ org: row.organization_name, days, color: "#3B82F6" });
    }
    return data.sort((a, b) => a.days - b.days);
  }, [orgs]);

  return (
    <div className="min-w-0 max-w-full space-y-6 overflow-x-hidden">
      <PageHeader
        title="Organizations"
        description="Tenant directory — identity, lifecycle state, selected plan, free-trial time remaining, operational counts and incident load. Financial records stay behind privileged access."
        icon={Building2}
        meta={activeTab === "organizations" ? `${displayValue(total)} organization(s)` : undefined}
        actions={
          activeTab === "organizations" ? (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
            >
              <Plus size={15} />
              New Organization
            </button>
          ) : undefined
        }
      />

      <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Organizations sections">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex items-center gap-1.5 rounded-xl border px-3.5 py-2 text-sm font-semibold transition-colors ${
                active
                  ? "border-brand-500 bg-brand-50 text-brand-700"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              <Icon size={15} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === "lifecycle" ? (
        <div className="mt-6">
          <LifecycleOnboardingPage />
        </div>
      ) : activeTab === "health" ? (
        <div className="mt-6">
          <TenantHealthPage />
        </div>
      ) : activeTab === "support" ? (
        <div className="mt-6">
          <SupportAccessPage />
        </div>
      ) : (
        <>
          {notice && <div className="mt-4"><SuccessMessage message={notice} onDismiss={() => setNotice(null)} /></div>}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <SearchInput value={search} onChange={onSearch} placeholder="Search by name, code or legal name…" className="w-full max-w-sm" />
            <label htmlFor="lifecycle-filter" className="sr-only">Filter by lifecycle state</label>
            <select
              id="lifecycle-filter"
              value={lifecycleFilter}
              onChange={(e) => {
                setLifecycleFilter(e.target.value);
                setPage(1);
              }}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
            >
              <option value="">All lifecycle states</option>
              {LIFECYCLE_FILTER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {trialChartData.length > 0 && (
            <div className="mt-6">
              <DashboardChartCard
                title="Trial Period Overview"
                action={<span className="text-xs text-slate-400">{trialChartData.length} org(s) on trial</span>}
              >
                <div className="h-64 w-full" aria-label="Remaining trial days per organization">
                  <DashboardChartErrorBoundary>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={trialChartData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                        <XAxis dataKey="org" tick={{ fontSize: 11, fill: "#64748B" }} interval={0} angle={-25} textAnchor="end" height={56} />
                        <YAxis tick={{ fontSize: 11, fill: "#64748B" }} allowDecimals={false} />
                        <Tooltip formatter={(value) => [`${value} day(s)`, "Trial remaining"]} />
                        <Bar dataKey="days" radius={[6, 6, 0, 0]}>
                          {trialChartData.map((d, i) => (
                            <Cell key={i} fill={d.color} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </DashboardChartErrorBoundary>
                </div>
              </DashboardChartCard>
            </div>
          )}

          <div className="mt-4">
            {error ? (
              <div className="rounded-3xl border border-slate-200 bg-white">
                <ErrorState message={error} onRetry={() => load(page, search, lifecycleFilter)} title="Unable to load organizations" />
              </div>
            ) : loading && orgs.length === 0 ? (
              <Spinner />
            ) : (
              <DataTable
                columns={columns}
                data={orgs}
                loading={loading}
                onRowClick={(row) => navigate(`/super-admin/organizations/${row.id}`)}
                emptyTitle="No organizations found"
                emptyMessage={search || lifecycleFilter ? "No organizations match your filters." : "Organizations will appear here once they are provisioned."}
                minWidth={0}
                tableClassName="table-fixed"
              />
            )}
          </div>

          {!error && (
            <div className="mt-4">
              <Pagination page={page} totalPages={totalPages} onPageChange={setPage}>
                {displayValue(total)} organization(s)
              </Pagination>
            </div>
          )}
        </>
      )}

      <CreateOrganizationModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(org) => {
          setCreating(false);
          setNotice(`Organization "${org.organization_name}" created.`);
          setPage(1);
          load(1, search, lifecycleFilter);
        }}
      />
    </div>
  );
}
