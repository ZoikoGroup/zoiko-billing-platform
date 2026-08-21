import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Building2, ChevronRight, Plus } from "lucide-react";
import { listCommercialAccounts, createOrganization } from "../../service/commercialService";
import { PageHeader, DataTable, SearchInput, Modal, Field, Button } from "../../components/billing-ui";
import { Pagination, StatusBadge, ErrorState, Spinner, SuccessMessage } from "../../components/billing-shared";
import {
  PAGE_SIZE,
  ACCOUNT_STATUS_OPTIONS,
  SUBSCRIPTION_STATUS_OPTIONS,
  formatDateTime,
  displayValue,
  CommercialSourceBadge,
  CommercialClassificationBadge,
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
  const [accounts, setAccounts] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState(location.state?.notice || null);

  const load = useCallback(async (pageNum, term) => {
    setLoading(true);
    setError(null);
    try {
      const data = await listCommercialAccounts({
        skip: (pageNum - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
        search: term,
      });
      setAccounts(data.accounts || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err?.message || "Failed to load commercial accounts.");
      setAccounts([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(page, search);
  }, [load, page, search]);

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
        key: "status",
        label: "Account Status",
        render: (row) => <StatusBadge status={row.status} options={ACCOUNT_STATUS_OPTIONS} />,
      },
      {
        key: "billing_source",
        label: "Billing Source",
        render: (row) => <CommercialSourceBadge value={row.billing_source} />,
      },
      {
        key: "billing_classification",
        label: "Classification",
        render: (row) => <CommercialClassificationBadge value={row.billing_classification} />,
      },
      {
        key: "can_charge",
        label: "Chargeable",
        render: (row) =>
          row.can_charge ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700">
              Can charge
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
              Disabled
            </span>
          ),
      },
      {
        key: "current_subscription",
        label: "Current Subscription",
        render: (row) => {
          const sub = row.current_subscription;
          if (!sub) return <span className="text-xs text-slate-500">—</span>;
          return (
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-slate-600">{sub.plan_code}</span>
              <StatusBadge status={sub.status} options={SUBSCRIPTION_STATUS_OPTIONS} />
            </div>
          );
        },
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
        description="Commercial accounts across all organizations — billing source, classification, charging readiness, and current subscription."
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

      <div className="mt-6 flex items-center justify-between gap-3">
        <SearchInput value={search} onChange={onSearch} placeholder="Search by organization name or code…" className="w-full max-w-sm" />
      </div>

      <div className="mt-4">
        {error ? (
          <div className="rounded-3xl border border-slate-200 bg-white">
            <ErrorState message={error} onRetry={() => load(page, search)} title="Unable to load organizations" />
          </div>
        ) : loading && accounts.length === 0 ? (
          <Spinner />
        ) : (
          <DataTable
            columns={columns}
            data={accounts}
            loading={loading}
            onRowClick={(row) => navigate(`/super-admin/organizations/${row.organization_id}`)}
            emptyTitle="No organizations found"
            emptyMessage={search ? "No organizations match your search." : "Organizations will appear here once they are provisioned."}
            minWidth={900}
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
          load(1, search);
        }}
      />
    </div>
  );
}
