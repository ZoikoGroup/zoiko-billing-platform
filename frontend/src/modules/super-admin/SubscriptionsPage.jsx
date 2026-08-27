import React, { useCallback, useEffect, useMemo, useState } from "react";
import { UserCheck, Plus, Repeat, Building2, ArrowLeftRight } from "lucide-react";
import {
  listCommercialSubscriptions,
  createCommercialSubscription,
  setCommercialSubscriptionStatus,
  changeCommercialSubscriptionPlan,
  listCommercialAccounts,
  listCommercialPlans,
} from "../../service/commercialService";
import { PageHeader, DataTable, Button, Modal, Field, Select, SearchInput } from "../../components/billing-ui";
import { Pagination, StatusBadge, ErrorState, Spinner, SuccessMessage, useConfirmationDialog } from "../../components/billing-shared";
import {
  PAGE_SIZE,
  SUBSCRIPTION_STATUS_OPTIONS,
  SUBSCRIPTION_TRANSITIONS,
  TRANSITION_LABELS,
  formatDateOnly,
  formatDateTime,
  formatTrialRemaining,
  displayValue,
} from "./constants";

const EMPTY_FORM = { organization_id: "", plan_id: "", status: "pending" };

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

  // Phase 3F F5 — plan change state (supersede-with-history).
  const [planChangeSub, setPlanChangeSub] = useState(null);
  const [planChangeForm, setPlanChangeForm] = useState({ new_plan_id: "", reason: "" });
  const [planChangeError, setPlanChangeError] = useState(null);
  const [planChangeSubmitting, setPlanChangeSubmitting] = useState(false);

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

  const openPlanChange = useCallback(
    async (subscription) => {
      setPlanChangeSub(subscription);
      setPlanChangeForm({ new_plan_id: "", reason: "" });
      setPlanChangeError(null);
      if (plans.length === 0) {
        try {
          const p = await listCommercialPlans({ limit: 200 });
          setPlans(p.plans || []);
        } catch (err) {
          setPlanChangeError(err?.message || "Failed to load the plan catalog for this form.");
        }
      }
    },
    [plans]
  );

  const handlePlanChange = async () => {
    if (!planChangeForm.new_plan_id || planChangeForm.reason.trim().length < 3) {
      setPlanChangeError("Pick a target plan and give a reason (min. 3 characters).");
      return;
    }
    if (Number(planChangeForm.new_plan_id) === planChangeSub.commercial_plan_id) {
      setPlanChangeError("That is already the subscription's current plan.");
      return;
    }
    setPlanChangeSubmitting(true);
    setPlanChangeError(null);
    try {
      const replacement = await changeCommercialSubscriptionPlan(planChangeSub.id, {
        new_plan_id: Number(planChangeForm.new_plan_id),
        reason: planChangeForm.reason.trim(),
      });
      setSuccess(
        `Plan changed for ${replacement.organization_code}: now on ${replacement.plan_code} (${replacement.status}); the previous subscription is preserved as history.`
      );
      setPlanChangeSub(null);
      await load(page, search);
    } catch (err) {
      setPlanChangeError(err?.message || "Failed to change the subscription's plan.");
    } finally {
      setPlanChangeSubmitting(false);
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
              <span className="block text-xs text-slate-500">{row.organization_code}</span>
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
            <span className="block text-xs text-slate-500">{row.plan_code}</span>
          </span>
        ),
      },
      {
        key: "status",
        label: "Status",
        render: (row) => <StatusBadge status={row.status} options={SUBSCRIPTION_STATUS_OPTIONS} />,
      },
      {
        key: "trial",
        label: "Trial / Recovery",
        render: (row) => {
          if (row.status !== "suspended" && row.status !== "pending" && row.status !== "trialing") {
            return <span className="text-xs text-slate-400">—</span>;
          }
          const trial = formatTrialRemaining(row.trial_ends_at, row.status, row.recovery_ends_at);
          if (!trial) return <span className="text-xs text-slate-400">—</span>;
          const toneClass =
            trial.tone === "risk" ? "text-red-600" : trial.tone === "attention" ? "text-amber-600" : "text-slate-600";
          return <span className={`text-xs font-semibold ${toneClass}`}>{trial.label}</span>;
        },
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
        width: 300,
        render: (row) => {
          const allowed = SUBSCRIPTION_TRANSITIONS[row.status] || [];
          if (allowed.length === 0) return <span className="text-xs text-slate-500">Terminal</span>;
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
              <Button
                size="sm"
                variant="ghost"
                icon={ArrowLeftRight}
                title="Change plan (supersedes this subscription; history preserved)"
                onClick={() => openPlanChange(row)}
              >
                Plan
              </Button>
            </div>
          );
        },
      },
    ],
    [transitionTargets, openPlanChange]
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Commercial Subscriptions"
        description="PLANE 1 · Zoiko→Tenant SaaS subscriptions. Lifecycle changes go through the backend state machine only; plan changes supersede the subscription and preserve history."
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
            minWidth={1120}
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

      <Modal
        open={!!planChangeSub}
        onClose={() => setPlanChangeSub(null)}
        title="Change subscription plan"
        description="Phase 3F: the current open subscription is cancelled (preserved as history) and replaced by one on the target plan. If it was ACTIVE, the replacement activates immediately under the same charging guards. A reason is mandatory and audited."
        icon={ArrowLeftRight}
        size="md"
      >
        {planChangeSub && (
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
              <p><span className="font-semibold text-slate-800">{planChangeSub.organization_name}</span> ({planChangeSub.organization_code})</p>
              <p className="mt-1">Current plan: {planChangeSub.plan_name} ({planChangeSub.plan_code}) · status {planChangeSub.status}</p>
            </div>
            <Field label="Target plan" htmlFor="pc-plan" required>
              <select
                id="pc-plan"
                value={planChangeForm.new_plan_id}
                onChange={(e) => setPlanChangeForm((prev) => ({ ...prev, new_plan_id: e.target.value }))}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
              >
                <option value="">Select plan…</option>
                {plans.map((plan) => (
                  <option
                    key={plan.id}
                    value={plan.id}
                    disabled={plan.status === "archived" || plan.id === planChangeSub.commercial_plan_id}
                  >
                    {plan.plan_name} ({plan.plan_code}) — {plan.status}
                    {plan.id === planChangeSub.commercial_plan_id ? " · current" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reason" htmlFor="pc-reason" required hint="Recorded on both the platform audit trail and the org billing audit trail.">
              <textarea
                id="pc-reason"
                rows={3}
                value={planChangeForm.reason}
                onChange={(e) => setPlanChangeForm((prev) => ({ ...prev, reason: e.target.value }))}
                placeholder="Why is this subscription changing plan?"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
              />
            </Field>
            {planChangeError && (
              <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {planChangeError}
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={() => setPlanChangeSub(null)}>Cancel</Button>
              <Button variant="primary" icon={ArrowLeftRight} onClick={handlePlanChange} loading={planChangeSubmitting}>
                Change plan
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {ConfirmationDialog}
    </div>
  );
}
