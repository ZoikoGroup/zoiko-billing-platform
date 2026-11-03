import React, { useCallback, useEffect, useMemo, useState } from "react";
import { UserCheck, Plus, Repeat, Building2, ArrowLeftRight, RefreshCw } from "lucide-react";
import {
  listCommercialSubscriptions,
  createCommercialSubscription,
  setCommercialSubscriptionStatus,
  changeCommercialSubscriptionPlan,
  listCommercialAccounts,
  listCommercialPlans,
} from "../../service/commercialService";
import {
  PageHeader,
  SectionCard,
  DataTable,
  Button,
  Modal,
  Field,
  Select,
  SearchInput,
  FORM_CONTROL_CLASS,
} from "../../components/billing-ui";
import { ErrorState, Pagination, StatusBadge, SuccessMessage, useConfirmationDialog } from "../../components/billing-shared";
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

// The backend state machine (CommercialSubscriptionService._TRANSITIONS) also
// has TRIAL_RECOVERY and CONVERTED, which the shared constants lack — rows in
// those states rendered as "Terminal" with no actions although the backend
// accepts transitions out of them. Moving INTO trial_recovery/converted is
// left to the trial sweeps / self-serve conversion (they set the recovery
// window and conversion bookkeeping a bare status write would skip).
const STATUS_OPTIONS = [
  ...SUBSCRIPTION_STATUS_OPTIONS,
  { value: "trial_recovery", label: "Trial Recovery", color: "bg-amber-100 text-amber-700" },
  { value: "converted", label: "Converted", color: "bg-emerald-100 text-emerald-700" },
].filter((opt, idx, all) => all.findIndex((o) => o.value === opt.value) === idx);

const TRANSITIONS = {
  ...SUBSCRIPTION_TRANSITIONS,
  trial_recovery: ["active", "suspended", "cancelled", "expired"],
  converted: ["active", "suspended", "cancelled"],
};

// change_plan only accepts subscriptions in CommercialSubscriptionService.
// _OPEN_STATUSES — cancel_at_period_end, enterprise_pending and converted
// are rejected there.
const PLAN_CHANGE_STATUSES = new Set([
  "pending", "active", "past_due", "restricted", "suspended", "trialing", "trial_recovery", "scheduled_change",
]);

const TERMINAL_TARGETS = new Set(["cancelled", "expired"]);
const TRIAL_COLUMN_STATUSES = new Set(["pending", "trialing", "trial_recovery", "suspended"]);

const EMPTY_FORM = { organization_id: "", plan_id: "", status: "pending" };

const statusLabel = (status) => STATUS_OPTIONS.find((o) => o.value === status)?.label || displayValue(status);

// `embedded` drops this page's own PageHeader when it is mounted as a tab of
// the Products & Pricing hub.
export default function SubscriptionsPage({ embedded = false } = {}) {
  const [subscriptions, setSubscriptions] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  // A failed row action is reported inline; `error` is reserved for a failed
  // LOAD so a rejected transition never masquerades as the list failing.
  const [actionError, setActionError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [orgs, setOrgs] = useState([]);
  const [orgTotal, setOrgTotal] = useState(0);
  const [plans, setPlans] = useState([]);
  const [transitionTargets, setTransitionTargets] = useState({});
  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  // Phase 3F F5 — plan change state (supersede-with-history).
  const [planChangeSub, setPlanChangeSub] = useState(null);
  const [planChangeForm, setPlanChangeForm] = useState({ new_plan_id: "", reason: "" });
  const [planChangeError, setPlanChangeError] = useState(null);
  const [planChangeSubmitting, setPlanChangeSubmitting] = useState(false);

  const load = useCallback(async (pageNum, term, statusValue) => {
    setLoading(true);
    setError(null);
    try {
      const data = await listCommercialSubscriptions({
        skip: (pageNum - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
        search: term,
        ...(statusValue ? { status: statusValue } : {}),
      });
      const rows = data?.subscriptions || [];
      const count = data?.total || 0;
      // The last page can empty out (a cancel under a status filter, a
      // shrinking search result); step back instead of showing "no
      // subscriptions" while some still exist.
      const lastPage = Math.max(1, Math.ceil(count / PAGE_SIZE));
      if (rows.length === 0 && count > 0 && pageNum > lastPage) {
        setPage(lastPage);
        return;
      }
      setSubscriptions(rows);
      setTotal(count);
    } catch (err) {
      setError(err?.message || "Failed to load commercial subscriptions.");
      setSubscriptions([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  const reload = useCallback(() => load(page, search, statusFilter), [load, page, search, statusFilter]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!success) return undefined;
    const t = setTimeout(() => setSuccess(null), 6000);
    return () => clearTimeout(t);
  }, [success]);

  const onSearch = useCallback((value) => {
    setSearch(value);
    setPage(1);
  }, []);

  const onStatusFilter = useCallback((value) => {
    setStatusFilter(value);
    setPage(1);
  }, []);

  const openCreate = useCallback(async () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setCreateOpen(true);
    setOptionsLoading(true);
    try {
      const [o, p] = await Promise.all([
        listCommercialAccounts({ limit: 200 }),
        listCommercialPlans({ limit: 200 }),
      ]);
      setOrgs(o?.accounts || []);
      setOrgTotal(o?.total || 0);
      setPlans(p?.plans || []);
    } catch (err) {
      setFormError(err?.message || "Failed to load organizations/plans for the form.");
    } finally {
      setOptionsLoading(false);
    }
  }, []);

  const closeCreate = () => {
    if (!submitting) setCreateOpen(false);
  };

  const handleCreate = async (event) => {
    event?.preventDefault();
    if (submitting) return;
    if (!form.organization_id || !form.plan_id) {
      setFormError("Choose an organization and a plan.");
      return;
    }
    const plan = plans.find((p) => String(p.id) === String(form.plan_id));
    if (form.status === "active" && plan && plan.status !== "active") {
      setFormError(`${plan.plan_name} is ${plan.status}; only active plans can start an active subscription. Start it as Pending or pick an active plan.`);
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
      setSuccess(`Subscription created for ${created.organization_code} (${created.plan_code}, ${statusLabel(created.status)}).`);
      setActionError(null);
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      await reload();
    } catch (err) {
      setFormError(err?.message || "Failed to create subscription.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleTransition = async (subscription, newStatus) => {
    if (busyId !== null) return;
    const verb = TRANSITION_LABELS[newStatus] || statusLabel(newStatus);
    const terminal = TERMINAL_TARGETS.has(newStatus);
    const ok = await confirm({
      title: `${verb} ${subscription.organization_name || subscription.organization_code}'s subscription?`,
      message: terminal
        ? `This ends the ${subscription.plan_code} subscription. It is kept as history but cannot be reopened — a new subscription would be needed.`
        : `The ${subscription.plan_code} subscription moves from ${statusLabel(subscription.status)} to ${statusLabel(newStatus)}.${
            newStatus === "active" ? " Activating starts real billing and requires the plan to be active and the organization to be chargeable." : ""
          }`,
      confirmLabel: verb,
      tone: terminal ? "danger" : "primary",
    });
    if (!ok) return;
    setBusyId(subscription.id);
    setActionError(null);
    setSuccess(null);
    try {
      const updated = await setCommercialSubscriptionStatus(subscription.id, newStatus);
      setSuccess(`Subscription for ${updated.organization_code} is now ${statusLabel(updated.status)}.`);
      setTransitionTargets((prev) => {
        const next = { ...prev };
        delete next[subscription.id];
        return next;
      });
      await reload();
    } catch (err) {
      setActionError(err?.message || "Failed to update subscription status.");
    } finally {
      setBusyId(null);
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
          setPlans(p?.plans || []);
        } catch (err) {
          setPlanChangeError(err?.message || "Failed to load the plan catalog for this form.");
        }
      }
    },
    [plans]
  );

  const closePlanChange = () => {
    if (!planChangeSubmitting) setPlanChangeSub(null);
  };

  // Why a target plan can't be chosen, mirroring change_plan's guards.
  const planChangeBlock = (plan) => {
    if (!planChangeSub) return null;
    if (plan.id === planChangeSub.commercial_plan_id) return "current";
    if (plan.status === "archived") return "archived";
    if (planChangeSub.status === "active" && plan.status !== "active") return "not active";
    return null;
  };

  const handlePlanChange = async (event) => {
    event?.preventDefault();
    if (planChangeSubmitting) return;
    if (!planChangeForm.new_plan_id || planChangeForm.reason.trim().length < 3) {
      setPlanChangeError("Pick a target plan and give a reason (at least 3 characters).");
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
        `Plan changed for ${replacement.organization_code}: now on ${replacement.plan_code} (${statusLabel(replacement.status)}); the previous subscription is kept as history.`
      );
      setActionError(null);
      setPlanChangeSub(null);
      await reload();
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
            <span className="block font-medium text-slate-700">{row.plan_name || "—"}</span>
            <span className="block text-xs text-slate-500">{row.plan_code}</span>
          </span>
        ),
      },
      {
        key: "status",
        label: "Status",
        render: (row) => <StatusBadge status={row.status} options={STATUS_OPTIONS} />,
      },
      {
        key: "trial",
        label: "Trial / Recovery",
        render: (row) => {
          if (!TRIAL_COLUMN_STATUSES.has(row.status)) {
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
        label: "Billing Period",
        render: (row) => (
          <span className="text-xs text-slate-600">
            <span className="block">
              {formatDateOnly(row.current_period_start)} — {formatDateOnly(row.current_period_end)}
            </span>
            <span className="block text-slate-400">
              Term {formatDateOnly(row.start_at)} — {formatDateOnly(row.end_at)}
            </span>
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
        width: 320,
        render: (row) => {
          const allowed = TRANSITIONS[row.status] || [];
          const canChangePlan = PLAN_CHANGE_STATUSES.has(row.status);
          if (allowed.length === 0 && !canChangePlan) {
            return <span className="text-xs text-slate-500">Ended — kept as history</span>;
          }
          const target = allowed.includes(transitionTargets[row.id]) ? transitionTargets[row.id] : allowed[0];
          const rowBusy = busyId === row.id;
          return (
            <div className="flex flex-wrap items-center gap-1.5">
              {allowed.length > 0 && (
                <>
                  <select
                    value={target}
                    onChange={(e) => setTransitionTargets((prev) => ({ ...prev, [row.id]: e.target.value }))}
                    aria-label={`Status change for subscription ${row.id}`}
                    disabled={busyId !== null}
                    className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-700 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:opacity-50"
                  >
                    {allowed.map((s) => (
                      <option key={s} value={s}>{TRANSITION_LABELS[s] || statusLabel(s)}</option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={Repeat}
                    loading={rowBusy}
                    disabled={busyId !== null}
                    onClick={() => handleTransition(row, target)}
                  >
                    Apply
                  </Button>
                </>
              )}
              {canChangePlan && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={ArrowLeftRight}
                  disabled={busyId !== null}
                  title="Move to another plan (the current subscription is kept as history)"
                  onClick={() => openPlanChange(row)}
                >
                  Change plan
                </Button>
              )}
            </div>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transitionTargets, openPlanChange, busyId]
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstRow = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastRow = Math.min(total, page * PAGE_SIZE);
  const filtered = Boolean(search || statusFilter);
  const selectedCreatePlan = plans.find((p) => String(p.id) === String(form.plan_id));

  return (
    <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
      <PageHeader
        embedded={embedded}
        accent="violet"
        title="Platform Subscriptions"
        description="Which Zoiko plan each organization is subscribed to. Status changes follow the allowed lifecycle; plan changes replace the subscription and keep the old one as history."
        icon={UserCheck}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" icon={RefreshCw} onClick={() => reload()} disabled={loading}>
              Refresh
            </Button>
            <Button variant="primary" icon={Plus} onClick={openCreate}>
              Create subscription
            </Button>
          </div>
        }
        meta={`${displayValue(total)} subscription(s)${filtered ? " matching filters" : ""}`}
      />

      <div className={`space-y-4 ${embedded ? "" : "mt-6"}`}>
        {success && <SuccessMessage message={success} onDismiss={() => setSuccess(null)} />}
        {actionError && (
          <div role="alert" className="flex items-start justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>{actionError}</span>
            <button type="button" onClick={() => setActionError(null)} className="shrink-0 text-xs font-semibold underline">Dismiss</button>
          </div>
        )}

        {/* Filters stay visible in the error state so a bad search/filter
            can be cleared without reloading the page. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <SearchInput value={search} onChange={onSearch} placeholder="Search by organization name/code or plan code…" className="w-full sm:max-w-sm" />
          <Select
            value={statusFilter}
            onChange={onStatusFilter}
            options={STATUS_OPTIONS.map(({ value, label }) => ({ value, label }))}
            placeholder="All statuses"
            aria-label="Filter by status"
            className="w-full sm:w-52"
          />
          {filtered && (
            <Button variant="ghost" size="sm" onClick={() => { onSearch(""); onStatusFilter(""); }}>
              Clear filters
            </Button>
          )}
        </div>

        {/* A failed fetch also clears `subscriptions` to [], so the empty
            state must not render under the error — a failure would read as
            an empty catalogue. */}
        <SectionCard
          variant="hero"
          accent="violet"
          icon={UserCheck}
          title="Subscription Directory"
          description="Newest first. Use Apply to move a subscription to another status, or Change plan to switch its plan."
        >
          {error ? (
            <ErrorState message={error} onRetry={() => reload()} title="Unable to load subscriptions" />
          ) : (
            <DataTable
              columns={columns}
              data={subscriptions}
              loading={loading}
              emptyTitle={filtered ? "No subscriptions match" : "No commercial subscriptions yet"}
              emptyMessage={
                filtered
                  ? "Try a different search or status, or clear the filters."
                  : "Create the first subscription to assign a plan to an organization."
              }
              emptyAction={
                filtered ? (
                  <Button variant="secondary" onClick={() => { onSearch(""); onStatusFilter(""); }}>Clear filters</Button>
                ) : (
                  <Button variant="primary" icon={Plus} onClick={openCreate}>Create subscription</Button>
                )
              }
              minWidth={1120}
            />
          )}
        </SectionCard>

        {!error && (
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage}>
            Showing {firstRow.toLocaleString()}–{lastRow.toLocaleString()} of {displayValue(total)}
          </Pagination>
        )}
      </div>

      <Modal
        open={createOpen}
        onClose={closeCreate}
        title="Create commercial subscription"
        description="Assign a plan to an organization. An organization can have only one open subscription at a time."
        icon={UserCheck}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={closeCreate} disabled={submitting}>Cancel</Button>
            <Button type="submit" form="cs-create-form" variant="primary" loading={submitting} disabled={optionsLoading}>
              Create subscription
            </Button>
          </>
        }
      >
        <form id="cs-create-form" onSubmit={handleCreate} className="space-y-4" noValidate>
          <Field
            label="Organization"
            htmlFor="cs-org"
            required
            hint={
              orgTotal > orgs.length
                ? `Showing the ${orgs.length} most recent of ${orgTotal.toLocaleString()} organizations.`
                : "Organizations that already have an open subscription can't be picked — change or end that one instead."
            }
          >
            <select
              id="cs-org"
              value={form.organization_id}
              disabled={optionsLoading}
              onChange={(e) => setForm((prev) => ({ ...prev, organization_id: e.target.value }))}
              className={FORM_CONTROL_CLASS}
            >
              <option value="">{optionsLoading ? "Loading organizations…" : "Select organization…"}</option>
              {orgs.map((org) => {
                // create_subscription rejects an account that already has an
                // open subscription.
                const open = org.current_subscription;
                return (
                  <option key={org.organization_id} value={org.organization_id} disabled={Boolean(open)}>
                    {org.organization_name} ({org.organization_code})
                    {open ? ` — already on ${open.plan_code} (${statusLabel(open.status)})` : ""}
                  </option>
                );
              })}
            </select>
          </Field>
          <Field label="Plan" htmlFor="cs-plan" required>
            <select
              id="cs-plan"
              value={form.plan_id}
              disabled={optionsLoading}
              onChange={(e) => setForm((prev) => ({ ...prev, plan_id: e.target.value }))}
              className={FORM_CONTROL_CLASS}
            >
              <option value="">{optionsLoading ? "Loading plans…" : "Select plan…"}</option>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id} disabled={plan.status === "archived"}>
                  {plan.plan_name} ({plan.plan_code}) — {plan.status}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Initial status"
            htmlFor="cs-status"
            hint={
              selectedCreatePlan && selectedCreatePlan.status !== "active"
                ? "This plan isn't active, so the subscription can only start as Pending."
                : "Pending waits for activation; Active starts billing now."
            }
          >
            <Select
              id="cs-status"
              value={form.status}
              placeholder=""
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
        </form>
      </Modal>

      <Modal
        open={!!planChangeSub}
        onClose={closePlanChange}
        title="Change subscription plan"
        description="The current subscription is cancelled (kept as history) and replaced by one on the new plan. If it was Active, the replacement is activated straight away."
        icon={ArrowLeftRight}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={closePlanChange} disabled={planChangeSubmitting}>Cancel</Button>
            <Button type="submit" form="pc-form" variant="primary" icon={ArrowLeftRight} loading={planChangeSubmitting}>
              Change plan
            </Button>
          </>
        }
      >
        {planChangeSub && (
          <form id="pc-form" onSubmit={handlePlanChange} className="space-y-4" noValidate>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
              <p><span className="font-semibold text-slate-800">{planChangeSub.organization_name}</span> ({planChangeSub.organization_code})</p>
              <p className="mt-1">Current plan: {planChangeSub.plan_name} ({planChangeSub.plan_code}) · {statusLabel(planChangeSub.status)}</p>
            </div>
            <Field
              label="New plan"
              htmlFor="pc-plan"
              required
              hint={planChangeSub.status === "active" ? "This subscription is Active, so only active plans can be chosen." : undefined}
            >
              <select
                id="pc-plan"
                value={planChangeForm.new_plan_id}
                onChange={(e) => setPlanChangeForm((prev) => ({ ...prev, new_plan_id: e.target.value }))}
                className={FORM_CONTROL_CLASS}
              >
                <option value="">Select plan…</option>
                {plans.map((plan) => {
                  const block = planChangeBlock(plan);
                  return (
                    <option key={plan.id} value={plan.id} disabled={Boolean(block)}>
                      {plan.plan_name} ({plan.plan_code}) — {plan.status}
                      {block === "current" ? " · current" : ""}
                    </option>
                  );
                })}
              </select>
            </Field>
            <Field label="Reason" htmlFor="pc-reason" required hint={`Saved to the audit trail. ${planChangeForm.reason.length}/1000`}>
              <textarea
                id="pc-reason"
                rows={3}
                maxLength={1000}
                value={planChangeForm.reason}
                onChange={(e) => setPlanChangeForm((prev) => ({ ...prev, reason: e.target.value }))}
                placeholder="Why is this subscription changing plan?"
                className={FORM_CONTROL_CLASS}
              />
            </Field>
            {planChangeError && (
              <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {planChangeError}
              </p>
            )}
          </form>
        )}
      </Modal>

      {ConfirmationDialog}
    </div>
  );
}
