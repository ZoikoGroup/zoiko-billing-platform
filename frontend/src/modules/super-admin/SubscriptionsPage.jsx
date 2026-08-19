import React, { useCallback, useEffect, useMemo, useState } from "react";
import { UserCheck, Plus, Repeat, Building2 } from "lucide-react";
import {
  listCommercialSubscriptions,
  createCommercialSubscription,
  setCommercialSubscriptionStatus,
  listCommercialAccounts,
  listCommercialPlans,
} from "../../service/commercialService";
import { PageHeader, DataTable, Button, Modal, Field, Select, SearchInput } from "../../components/billing-ui";
import { Pagination, StatusBadge, ErrorState, Spinner, SuccessMessage, useConfirmationDialog } from "../../components/billing-shared";
import {
  PAGE_SIZE,
  SUBSCRIPTION_STATUS_OPTIONS,
  SUBSCRIPTION_TRANSITIONS,
  formatDateOnly,
  formatDateTime,
  displayValue,
} from "./constants";

const EMPTY_FORM = { organization_id: "", plan_id: "", status: "pending" };

const TRANSITION_LABELS = {
  active: "Activate",
  past_due: "Mark Past Due",
  restricted: "Restrict",
  suspended: "Suspend",
  cancelled: "Cancel",
  expired: "Expire",
};

export default function SubscriptionsPage() {
  const [subscriptions, setSubscriptions] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [orgs, setOrgs] = useState([]);
  const [plans, setPlans] = useState([]);
  const [transitionTargets, setTransitionTargets] = useState({});
  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  const load = useCallback(async (pageNum, term) => {
    setLoading(true);
    setError(null);
    try {
      const data = await listCommercialSubscriptions({
        skip: (pageNum - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
        search: term,
      });
      setSubscriptions(data.subscriptions || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err?.message || "Failed to load commercial subscriptions.");
      setSubscriptions([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(page, search);
  }, [load, page, search]);

  const onSearch = useCallback((value) => {
    setSearch(value);
    setPage(1);
  }, []);

  const openCreate = useCallback(async () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setCreateOpen(true);
    try {
      const [o, p] = await Promise.all([
        listCommercialAccounts({ limit: 200 }),
        listCommercialPlans({ limit: 200 }),
      ]);
      setOrgs(o.accounts || []);
      setPlans(p.plans || []);
    } catch (err) {
      setFormError(err?.message || "Failed to load organizations/plans for the form.");
    }
  }, []);

  const handleCreate = async () => {
    if (!form.organization_id || !form.plan_id) {
      setFormError("Organization and plan are required.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const created = await createCommercialSubscription({
        organization_id: Number(form.organization_id),
        plan_id: Number(form.plan_id),
        status: form.status,
      });
      setSuccess(`Subscription created for ${created.organization_code} (${created.plan_code}, ${created.status}).`);
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      await load(page, search);
    } catch (err) {
      setFormError(err?.message || "Failed to create subscription.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleTransition = async (subscription, newStatus) => {
    const ok = await confirm({
      title: `${TRANSITION_LABELS[newStatus] || newStatus} subscription ${subscription.plan_code}?`,
      message:
        newStatus === "cancelled" || newStatus === "expired"
          ? `${TRANSITION_LABELS[newStatus]} is terminal and preserved as history. This cannot be undone via the UI.`
          : `This moves subscription ${subscription.id} from ${subscription.status} to ${newStatus} through the backend state machine.`,
      confirmLabel: TRANSITION_LABELS[newStatus] || "Confirm",
      tone: newStatus === "cancelled" || newStatus === "expired" ? "danger" : "primary",
    });
    if (!ok) return;
    try {
      const updated = await setCommercialSubscriptionStatus(subscription.id, newStatus);
      setSuccess(`Subscription for ${updated.organization_code} is now ${newStatus}.`);
      await load(page, search);
    } catch (err) {
      setError(err?.message || "Failed to update subscription status.");
    }
  };

  const columns = useMemo(
    () => [
      {
        key: "organization",
        label: "Organization",
        render: (row) => (
          <span className="flex items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
              <Building2 size={14} />
            </span>
            <span>
              <span className="block font-semibold text-slate-800">{row.organization_name}</span>
              <span className="block text-xs text-slate-400">{row.organization_code}</span>
            </span>
          </span>
        ),
      },
      {
        key: "plan",
        label: "Plan",
        render: (row) => (
          <span>
            <span className="block font-medium text-slate-700">{row.plan_name}</span>
            <span className="block text-xs text-slate-400">{row.plan_code}</span>
          </span>
        ),
      },
      {
        key: "status",
        label: "Status",
        render: (row) => <StatusBadge status={row.status} options={SUBSCRIPTION_STATUS_OPTIONS} />,
      },
      {
        key: "period",
        label: "Period",
        render: (row) => (
          <span className="text-xs text-slate-600">
            {formatDateOnly(row.start_at)} — {formatDateOnly(row.end_at)}
          </span>
        ),
      },
      {
        key: "current_period",
        label: "Current Period",
        render: (row) => (
          <span className="text-xs text-slate-600">
            {formatDateOnly(row.current_period_start)} — {formatDateOnly(row.current_period_end)}
          </span>
        ),
      },
      {
        key: "created_at",
        label: "Created",
        render: (row) => <span className="text-xs text-slate-500">{formatDateTime(row.created_at)}</span>,
      },
      {
        key: "actions",
        label: "Actions",
        width: 220,
        render: (row) => {
          const allowed = SUBSCRIPTION_TRANSITIONS[row.status] || [];
          if (allowed.length === 0) return <span className="text-xs text-slate-400">Terminal</span>;
          const target = transitionTargets[row.id] || allowed[0];
          return (
            <div className="flex items-center gap-1.5">
              <select
                value={target}
                onChange={(e) => setTransitionTargets((prev) => ({ ...prev, [row.id]: e.target.value }))}
                aria-label={`Transition ${row.id}`}
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-700 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
              >
                {allowed.map((s) => (
                  <option key={s} value={s}>{TRANSITION_LABELS[s] || s}</option>
                ))}
              </select>
              <Button size="sm" variant="secondary" icon={Repeat} onClick={() => handleTransition(row, target)}>
                Apply
              </Button>
            </div>
          );
        },
      },
    ],
    [transitionTargets]
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Commercial Subscriptions"
        description="Subscription lifecycle across all organizations. Lifecycle changes go through the backend state machine only."
        icon={UserCheck}
        actions={
          <Button variant="primary" icon={Plus} onClick={openCreate}>
            Create subscription
          </Button>
        }
        meta={`${displayValue(total)} subscription(s)`}
      />

      <div className="mt-6 space-y-4">
        {success && <SuccessMessage message={success} onDismiss={() => setSuccess(null)} />}
        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
            {error}
            <button type="button" onClick={() => load(page, search)} className="ml-3 font-semibold underline">Retry</button>
            <button type="button" onClick={() => setError(null)} className="ml-3 font-semibold underline">Dismiss</button>
          </div>
        )}

        <SearchInput value={search} onChange={onSearch} placeholder="Search by organization name/code or plan code…" className="w-full max-w-sm" />

        {loading && subscriptions.length === 0 ? (
          <Spinner />
        ) : (
          <DataTable
            columns={columns}
            data={subscriptions}
            loading={loading}
            emptyTitle="No commercial subscriptions yet"
            emptyMessage="Create the first subscription to assign a plan to an organization."
            emptyAction={<Button variant="primary" icon={Plus} onClick={openCreate}>Create subscription</Button>}
            minWidth={960}
          />
        )}

        <Pagination page={page} totalPages={totalPages} onPageChange={setPage}>
          {displayValue(total)} subscription(s)
        </Pagination>
      </div>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create commercial subscription"
        description="New subscriptions may only start as PENDING or ACTIVE. The backend rejects illegal combinations (e.g. ACTIVE on an archived plan)."
        icon={UserCheck}
        size="md"
      >
        <div className="space-y-4">
          <Field label="Organization" htmlFor="cs-org" required>
            <select
              id="cs-org"
              value={form.organization_id}
              onChange={(e) => setForm((prev) => ({ ...prev, organization_id: e.target.value }))}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
            >
              <option value="">Select organization…</option>
              {orgs.map((org) => (
                <option key={org.organization_id} value={org.organization_id}>
                  {org.organization_name} ({org.organization_code})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Plan" htmlFor="cs-plan" required>
            <select
              id="cs-plan"
              value={form.plan_id}
              onChange={(e) => setForm((prev) => ({ ...prev, plan_id: e.target.value }))}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
            >
              <option value="">Select plan…</option>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id} disabled={plan.status === "archived"}>
                  {plan.plan_name} ({plan.plan_code}) — {plan.status}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Initial status" htmlFor="cs-status" hint="Only PENDING or ACTIVE is allowed for a new subscription.">
            <Select
              id="cs-status"
              value={form.status}
              onChange={(v) => setForm((prev) => ({ ...prev, status: v }))}
              options={[
                { value: "pending", label: "Pending" },
                { value: "active", label: "Active" },
              ]}
            />
          </Field>
          {formError && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {formError}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate} loading={submitting}>Create subscription</Button>
          </div>
        </div>
      </Modal>

      {ConfirmationDialog}
    </div>
  );
}
