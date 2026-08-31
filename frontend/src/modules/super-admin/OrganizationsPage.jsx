import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Building2, ChevronRight, Plus } from "lucide-react";
import {
  createOrganization,
  listOrganizations,
} from "../../service/commercialService";
import { PageHeader, DataTable, SearchInput, Modal, Field, Button } from "../../components/billing-ui";
import { Pagination, StatusBadge, ErrorState, Spinner, SuccessMessage } from "../../components/billing-shared";
import {
  PAGE_SIZE,
  LIFECYCLE_STATE_BADGES,
  formatDateTime,
  displayValue,
  CommercialSourceBadge,
  CommercialClassificationBadge,
  LifecycleStateBadge,
  formatTrialRemaining,
} from "./constants";

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
            <span>
              <span className="block font-semibold text-slate-800">{row.organization_name}</span>
              <span className="block text-xs text-slate-500">{row.organization_code}</span>
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
        key: "trial_remaining",
        label: "Free Trial Remaining",
        render: (row) => {
          const trial = formatTrialRemaining(row.trial_ends_at, row.subscription_status, row.recovery_ends_at);
          if (!trial) return <span className="text-xs text-slate-400">—</span>;
          const toneClass =
            trial.tone === "risk" ? "text-red-600" : trial.tone === "attention" ? "text-amber-600" : "text-slate-600";
          return <span className={`text-xs font-semibold ${toneClass}`}>{trial.label}</span>;
        },
      },
      {
        key: "users",
        label: "Users",
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
        key: "open_incident_count",
        label: "Open Incidents",
        render: (row) =>
          row.open_incident_count > 0 ? (
            <span className="inline-flex min-w-[1.75rem] justify-center rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">
              {row.open_incident_count}
            </span>
          ) : (
            <span className="text-xs text-slate-400">0</span>
          ),
      },
      {
        key: "last_activity_at",
        label: "Last Activity",
        render: (row) => (
          <span className="text-xs text-slate-500" title={row.last_activity_at ? undefined : "No recorded evidence"}>
            {row.last_activity_at ? formatDateTime(row.last_activity_at) : "Unknown"}
          </span>
        ),
      },
      {
        key: "created_at",
        label: "Created",
        render: (row) => <span className="text-xs text-slate-500">{formatDateTime(row.created_at)}</span>,
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

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Organizations"
        description="Tenant directory — identity, lifecycle state, selected plan, free-trial time remaining, operational counts and incident load. Financial records stay behind privileged access."
        icon={Building2}
        meta={`${displayValue(total)} organization(s)`}
        actions={
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
          >
            <Plus size={15} />
            New Organization
          </button>
        }
      />

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
            minWidth={1200}
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
