import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Package,
  Plus,
  Pencil,
  Star,
  StarOff,
  Power,
  Archive,
  Crown,
  GitBranch,
  KeyRound,
  KeySquare,
  Clock,
  UserCheck,
  ShieldAlert,
  Gauge,
  GitPullRequestArrow,
} from "lucide-react";
import {
  listCommercialPlans,
  createCommercialPlan,
  updateCommercialPlan,
  setCommercialPlanStatus,
  setCommercialPlanDefault,
} from "../../service/commercialService";
import { PageHeader, DataTable, Button, Modal, Field, Select, HubTabs } from "../../components/billing-ui";
import { Pagination, StatusBadge, Spinner, SuccessMessage, useConfirmationDialog } from "../../components/billing-shared";
import {
  PAGE_SIZE,
  PLAN_STATUS_OPTIONS,
  BILLING_INTERVAL_OPTIONS,
  formatDateOnly,
  displayValue,
} from "./constants";
import EntitlementsPage from "./EntitlementsPage";
import PlanEntitlementsPage from "./PlanEntitlementsPage";
import EvaluationProgramsPage from "./EvaluationProgramsPage";
import SubscriptionsPage from "./SubscriptionsPage";
import OverridesPage from "./OverridesPage";
import UsageDiagnosticsPage from "./UsageDiagnosticsPage";
import PlanChangesPage from "./PlanChangesPage";

// The hub's own name, matching its sidebar label (BillingShell.jsx). The old
// header read "Commercial Plans" unconditionally — wrong for the sidebar
// entry it sits under, and wrong for 7 of 8 tabs once you clicked away from
// Plans.
const HUB_NAME = "Products & Pricing";

// Each tab's own title/description, shown in the hub's header when that tab
// is active — the same tab-aware-header fix already applied to the Audit &
// Evidence, System Health and Financial Operations hubs. Descriptions are the
// same copy each embedded page renders itself when not embedded, so there's
// one description per tab, not two that can drift apart.
const TABS = [
  {
    key: "plans",
    label: "Plans",
    icon: Package,
    description:
      "PLANE 1 · Reusable plan templates shared across organizations. The catalogue intentionally stays empty — pricing is never invented.",
  },
  {
    key: "entitlements",
    label: "Entitlement Catalog",
    icon: KeyRound,
    description:
      "ZB-COM-ENT-001 · Part 3 · typed entitlement key registry (§12–§13), enforced for 5 of 19 keys (Part 2), with real management surfaces for overrides, draft-version entitlement editing, usage diagnostics, and the plan-change queue (Part 3) — see docs/ENTITLEMENT_ENFORCEMENT_CHECKLIST.md for the full wired/unwired breakdown.",
  },
  {
    key: "plan-entitlements",
    label: "Plan Entitlements",
    icon: KeySquare,
    description:
      "ZB-COM-ENT-001 · Part 1 · read-only per-plan-version entitlement matrix (§13). Pick a plan and version to inspect its typed entitlement snapshot.",
  },
  {
    key: "evaluation-programs",
    label: "Evaluation Programs",
    icon: Clock,
    description:
      "ZB-COM-ENT-001 · §B3 · bounded trial configurations. A program exists only when deliberately created, and grants trials only once activated. Per-§5 the trial grants the granted_plan's entitlement bundle.",
  },
  {
    key: "subscriptions",
    label: "Platform Subscriptions",
    icon: UserCheck,
    description:
      "PLANE 1 · Zoiko→Tenant SaaS subscriptions. Lifecycle changes go through the backend state machine only; plan changes supersede the subscription and preserve history.",
  },
  {
    key: "overrides",
    label: "Entitlement Overrides",
    icon: ShieldAlert,
    description:
      "ZB-COM-ENT-001 · Part 2 §16.1 · per-org entitlement overrides with maker-checker approval. An override beats the org's plan entitlement (resolver precedence L3) until it expires or is revoked.",
  },
  {
    key: "usage-diagnostics",
    label: "Usage Diagnostics",
    icon: Gauge,
    description:
      "ZB-COM-ENT-001 · Part 3 §16 · UsageCounter values per organization, for keys enforced with a numeric limit. Threshold percentages require the org's resolved limit — click a key below to open it in the Entitlement Catalog.",
  },
  {
    key: "plan-changes",
    label: "Plan Change History",
    icon: GitPullRequestArrow,
    description:
      "ZB-COM-ENT-001 · Part 3 §7-§8, §16 · every upgrade/downgrade attempt, including BLOCKED ones — for investigating failed or inconsistent transitions.",
  },
];

const VALID_TABS = TABS.map((tab) => tab.key);

const EMPTY_FORM = {
  plan_code: "",
  plan_name: "",
  description: "",
  billing_interval: "",
  currency: "",
  price_amount: "",
  effective_from: "",
  effective_to: "",
  max_users: "",
  max_storage_gb: "",
  is_default: false,
  features: "",
};

function toForm(plan) {
  return {
    plan_code: plan.plan_code,
    plan_name: plan.plan_name || "",
    description: plan.description || "",
    billing_interval: plan.billing_interval || "",
    currency: plan.currency || "",
    price_amount: plan.price_amount === null || plan.price_amount === undefined ? "" : String(plan.price_amount),
    effective_from: plan.effective_from || "",
    effective_to: plan.effective_to || "",
    max_users: plan.max_users === null || plan.max_users === undefined ? "" : String(plan.max_users),
    max_storage_gb: plan.max_storage_gb === null || plan.max_storage_gb === undefined ? "" : String(plan.max_storage_gb),
    is_default: Boolean(plan.is_default),
    features: plan.features ? JSON.stringify(plan.features, null, 2) : "",
  };
}

function buildPayload(form) {
  const numOrNull = (v) => {
    if (v === "" || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const payload = {
    plan_code: form.plan_code.trim(),
    plan_name: form.plan_name.trim(),
    description: form.description.trim() || null,
    billing_interval: form.billing_interval || null,
    currency: form.currency.trim().toUpperCase() || null,
    price_amount: numOrNull(form.price_amount),
    effective_from: form.effective_from || null,
    effective_to: form.effective_to || null,
    max_users: numOrNull(form.max_users),
    max_storage_gb: numOrNull(form.max_storage_gb),
    is_default: Boolean(form.is_default),
  };
  const features = form.features.trim();
  payload.features = features ? JSON.parse(features) : null;
  return payload;
}

function PlanForm({ form, setForm, submitting, error, onCancel, onSubmit, editing }) {
  const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));
  const setCheck = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.checked }));
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Plan code" htmlFor="pp-code" required>
        <input
          id="pp-code"
          value={form.plan_code}
          onChange={set("plan_code")}
          disabled={editing}
          placeholder="e.g. standard"
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
      </Field>
      <Field label="Plan name" htmlFor="pp-name" required>
        <input
          id="pp-name"
          value={form.plan_name}
          onChange={set("plan_name")}
          placeholder="e.g. Standard"
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
      </Field>
      <Field label="Description" htmlFor="pp-desc" className="sm:col-span-2">
        <textarea
          id="pp-desc"
          value={form.description}
          onChange={set("description")}
          rows={2}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
      </Field>
      <Field label="Billing interval" htmlFor="pp-interval">
        <Select
          id="pp-interval"
          value={form.billing_interval}
          onChange={(v) => setForm((prev) => ({ ...prev, billing_interval: v }))}
          options={BILLING_INTERVAL_OPTIONS}
          placeholder="Not set"
        />
      </Field>
      <Field label="Currency" htmlFor="pp-currency" hint="ISO-4217 code, e.g. USD">
        <input
          id="pp-currency"
          value={form.currency}
          onChange={set("currency")}
          maxLength={3}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
      </Field>
      <Field label="Price amount" htmlFor="pp-price" hint="Optional — only set once an approved catalogue supplies a price.">
        <input
          id="pp-price"
          type="number"
          min="0"
          step="0.01"
          value={form.price_amount}
          onChange={set("price_amount")}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
      </Field>
      <Field label="Max users" htmlFor="pp-users">
        <input
          id="pp-users"
          type="number"
          min="0"
          step="1"
          value={form.max_users}
          onChange={set("max_users")}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
      </Field>
      <Field label="Max storage (GB)" htmlFor="pp-storage">
        <input
          id="pp-storage"
          type="number"
          min="0"
          step="1"
          value={form.max_storage_gb}
          onChange={set("max_storage_gb")}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
      </Field>
      <Field label="Effective from" htmlFor="pp-from">
        <input
          id="pp-from"
          type="date"
          value={form.effective_from}
          onChange={set("effective_from")}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
      </Field>
      <Field label="Effective to" htmlFor="pp-to">
        <input
          id="pp-to"
          type="date"
          value={form.effective_to}
          onChange={set("effective_to")}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
      </Field>
      <Field label="Features (JSON)" htmlFor="pp-features" hint={'Optional feature flags, e.g. {"api_access": true}'} className="sm:col-span-2">
        <textarea
          id="pp-features"
          value={form.features}
          onChange={set("features")}
          rows={4}
          placeholder='{"api_access": true}'
          className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
      </Field>
      <label className="flex items-center gap-2 text-sm font-medium text-slate-600 sm:col-span-2">
        <input
          type="checkbox"
          checked={form.is_default}
          onChange={setCheck("is_default")}
          className="h-4 w-4 rounded border-slate-300 accent-brand"
        />
        Set as default plan (must be ACTIVE)
      </label>
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 sm:col-span-2">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2 sm:col-span-2">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={onSubmit} loading={submitting}>
          {editing ? "Save changes" : "Create plan"}
        </Button>
      </div>
    </div>
  );
}

export default function PlansPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Derived from the URL on every render (not copied into state once), so an
  // in-hub link — e.g. Usage Diagnostics' "open in Entitlement Catalog"
  // deep-link — can switch tabs by changing the URL.
  const activeTab = VALID_TABS.includes(searchParams.get("tab")) ? searchParams.get("tab") : "plans";
  // Carries the entitlement key the operator jumped in on, so the
  // Entitlement Catalog tab opens pre-filtered instead of requiring a manual
  // re-search.
  const focusKey = searchParams.get("key") || "";
  const activeMeta = TABS.find((t) => t.key === activeTab) || TABS[0];
  const setActiveTab = useCallback(
    (tab) => setSearchParams({ tab }, { replace: true }),
    [setSearchParams]
  );
  const openEntitlementKey = useCallback(
    (key) => setSearchParams({ tab: "entitlements", key }),
    [setSearchParams]
  );
  const [plans, setPlans] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);
  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  const load = useCallback(async (pageNum) => {
    setLoading(true);
    setError(null);
    try {
      const data = await listCommercialPlans({ skip: (pageNum - 1) * PAGE_SIZE, limit: PAGE_SIZE });
      setPlans(data.plans || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err?.message || "Failed to load commercial plans.");
      setPlans([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(page);
  }, [load, page]);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setCreateOpen(true);
  };

  const openEdit = (plan) => {
    setForm(toForm(plan));
    setFormError(null);
    setEditing(plan);
  };

  const closeModals = () => {
    setCreateOpen(false);
    setEditing(null);
    setSubmitting(false);
  };

  const handleSubmit = async () => {
    let payload;
    try {
      payload = buildPayload(form);
    } catch (err) {
      setFormError(`Features must be valid JSON: ${err.message}`);
      return;
    }
    if (!payload.plan_code || !payload.plan_name) {
      setFormError("Plan code and plan name are required.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      if (editing) {
        const { plan_code, ...update } = payload;
        await updateCommercialPlan(editing.id, update);
        setSuccess(`Plan ${editing.plan_code} updated.`);
      } else {
        const created = await createCommercialPlan(payload);
        setSuccess(`Plan ${created.plan_code} created.`);
      }
      closeModals();
      await load(page);
    } catch (err) {
      setFormError(err?.message || "Failed to save plan.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleStatusChange = async (plan, newStatus) => {
    const ok = await confirm({
      title: `Set plan ${plan.plan_code} to ${newStatus}?`,
      message:
        newStatus === "archived"
          ? "Archived plans are permanently unavailable for new subscriptions but are retained for audit and history. This cannot be undone via the UI."
          : newStatus === "inactive"
            ? "Inactive plans are not sold anymore; existing subscriptions stay valid."
            : `Activate ${plan.plan_code} so it can be assigned to new subscriptions.`,
      confirmLabel: newStatus === "archived" ? "Archive" : "Confirm",
      tone: newStatus === "archived" ? "danger" : "primary",
    });
    if (!ok) return;
    try {
      await setCommercialPlanStatus(plan.id, newStatus);
      setSuccess(`Plan ${plan.plan_code} is now ${newStatus}.`);
      await load(page);
    } catch (err) {
      setError(err?.message || "Failed to change plan status.");
    }
  };

  const handleDefaultChange = async (plan) => {
    const ok = await confirm({
      title: plan.is_default ? `Clear default on ${plan.plan_code}?` : `Make ${plan.plan_code} the default plan?`,
      message: plan.is_default
        ? "Clearing the default leaves the catalogue with no default plan (registration provisions nothing)."
        : "Only ACTIVE plans can become the default. Selecting a new default clears the flag on every other plan.",
      confirmLabel: plan.is_default ? "Clear default" : "Make default",
      tone: "primary",
    });
    if (!ok) return;
    try {
      await setCommercialPlanDefault(plan.id, !plan.is_default);
      setSuccess(plan.is_default ? `Default cleared on ${plan.plan_code}.` : `${plan.plan_code} is now the default plan.`);
      await load(page);
    } catch (err) {
      setError(err?.message || "Failed to change default plan.");
    }
  };

  const columns = useMemo(
    () => [
      {
        key: "plan",
        label: "Plan",
        render: (row) => (
          <span className="flex items-center gap-2">
            <span>
              <span className="flex items-center gap-1.5 font-semibold text-slate-800">
                {row.plan_name}
                {row.is_default && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700">
                    <Crown size={10} /> Default
                  </span>
                )}
              </span>
              <span className="block text-xs text-slate-500">{row.plan_code}</span>
            </span>
          </span>
        ),
      },
      {
        key: "status",
        label: "Status",
        render: (row) => <StatusBadge status={row.status} options={PLAN_STATUS_OPTIONS} />,
      },
      {
        key: "billing_interval",
        label: "Interval",
        render: (row) => <span className="text-xs text-slate-600 capitalize">{row.billing_interval || "—"}</span>,
      },
      {
        key: "price",
        label: "Price",
        render: (row) =>
          row.price_amount === null || row.price_amount === undefined ? (
            <span className="text-xs text-slate-500">—</span>
          ) : (
            <span className="text-xs font-semibold text-slate-700">
              {(row.currency)} {Number(row.price_amount).toLocaleString()}
            </span>
          ),
      },
      {
        key: "max_users",
        label: "Max Users",
        render: (row) => <span className="text-xs text-slate-600">{displayValue(row.max_users)}</span>,
      },
      {
        key: "max_storage_gb",
        label: "Max Storage (GB)",
        render: (row) => <span className="text-xs text-slate-600">{displayValue(row.max_storage_gb)}</span>,
      },
      {
        key: "effective",
        label: "Effective",
        render: (row) => (
          <span className="text-xs text-slate-600">
            {row.effective_from ? `${formatDateOnly(row.effective_from)} — ${formatDateOnly(row.effective_to)}` : "—"}
          </span>
        ),
      },
      {
        key: "actions",
        label: "Actions",
        width: 280,
        render: (row) => (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="secondary"
              icon={GitBranch}
              onClick={() => navigate(`/super-admin/commercial/plans/${row.id}/versions`)}
              aria-label={`View catalog versions for ${row.plan_code}`}
            >
              Versions
            </Button>
            <Button size="sm" variant="secondary" icon={Pencil} onClick={() => openEdit(row)} aria-label={`Edit ${row.plan_code}`}>
              Edit
            </Button>
            <Button
              size="sm"
              variant={row.status === "archived" ? "ghost" : "secondary"}
              icon={Power}
              disabled={row.status === "archived"}
              onClick={() => handleStatusChange(row, row.status === "active" ? "inactive" : "active")}
              aria-label={`Toggle active state for ${row.plan_code}`}
            >
              {row.status === "active" ? "Deactivate" : row.status === "inactive" ? "Activate" : "Archived"}
            </Button>
            {row.status === "active" && (
              <Button
                size="sm"
                variant="ghost"
                icon={row.is_default ? StarOff : Star}
                onClick={() => handleDefaultChange(row)}
                aria-label={row.is_default ? `Clear default on ${row.plan_code}` : `Make ${row.plan_code} default`}
              >
                {row.is_default ? "Clear default" : "Set default"}
              </Button>
            )}
            {row.status !== "archived" && (
              <Button
                size="sm"
                variant="danger"
                icon={Archive}
                onClick={() => handleStatusChange(row, "archived")}
                aria-label={`Archive ${row.plan_code}`}
              >
                Archive
              </Button>
            )}
          </div>
        ),
      },
    ],
    []
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        crumbs={[{ label: HUB_NAME }, { label: activeMeta.label }]}
        title={activeMeta.label}
        description={activeMeta.description}
        icon={activeMeta.icon}
        accent="violet"
        actions={
          activeTab === "plans" ? (
            <Button variant="primary" icon={Plus} onClick={openCreate}>
              Create plan
            </Button>
          ) : undefined
        }
        meta={activeTab === "plans" ? `${displayValue(total)} plan(s)` : undefined}
      />

      <HubTabs tabs={TABS} active={activeTab} onChange={setActiveTab} label={`${HUB_NAME} sections`} accent="violet" />

      {activeTab === "plans" ? (
        <>
          {/* This hub also has a real "Evaluation Programs" tab (§B3, bounded
              trial configurations) — the "no trial/offer model exists" claim
              this banner used to make was true when it was written (COM-02)
              but stopped being true once that tab shipped, and it then
              contradicted its own neighbour. Removed rather than reworded:
              there's nothing left here that Evaluation Programs doesn't
              already say more precisely. */}

          <div className="mt-6 space-y-4">
            {success && <SuccessMessage message={success} onDismiss={() => setSuccess(null)} />}
            {error && (
              <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
                {error}
                <button type="button" onClick={() => load(page)} className="ml-3 font-semibold underline">Retry</button>
                <button type="button" onClick={() => setError(null)} className="ml-3 font-semibold underline">Dismiss</button>
              </div>
            )}

            {/* A failed fetch also clears `plans` to [], so rendering the
                table unconditionally showed "No commercial plans yet" right
                under the error banner above — a fetch failure read as an
                empty catalogue. */}
            {loading && plans.length === 0 ? (
              <Spinner />
            ) : !(error && plans.length === 0) && (
              <DataTable
                columns={columns}
                data={plans}
                loading={loading}
                emptyTitle="No commercial plans yet"
                emptyMessage="Create the first plan template to start building the catalogue."
                emptyAction={<Button variant="primary" icon={Plus} onClick={openCreate}>Create plan</Button>}
                minWidth={960}
              />
            )}

            {!(error && plans.length === 0) && (
              <Pagination page={page} totalPages={totalPages} onPageChange={setPage}>
                {displayValue(total)} plan(s)
              </Pagination>
            )}
          </div>
        </>
      ) : (
        <div className="mt-6">
          {activeTab === "entitlements" && (
            <EntitlementsPage embedded key={focusKey} initialSearch={focusKey} />
          )}
          {activeTab === "plan-entitlements" && <PlanEntitlementsPage embedded />}
          {activeTab === "evaluation-programs" && <EvaluationProgramsPage embedded />}
          {activeTab === "subscriptions" && <SubscriptionsPage embedded />}
          {activeTab === "overrides" && <OverridesPage embedded />}
          {activeTab === "usage-diagnostics" && (
            <UsageDiagnosticsPage embedded onOpenKey={openEntitlementKey} />
          )}
          {activeTab === "plan-changes" && <PlanChangesPage embedded />}
        </div>
      )}

      <Modal
        open={createOpen}
        onClose={closeModals}
        title="Create commercial plan"
        description="Structure only — leave pricing and limit fields empty until an approved catalogue supplies values."
        icon={Package}
        size="lg"
      >
        <PlanForm
          form={form}
          setForm={setForm}
          submitting={submitting}
          error={formError}
          editing={false}
          onCancel={closeModals}
          onSubmit={handleSubmit}
        />
      </Modal>

      <Modal
        open={Boolean(editing)}
        onClose={closeModals}
        title={`Edit plan ${editing?.plan_code || ""}`}
        description="Plan code is immutable. Editing a template never rewrites existing subscriptions."
        icon={Pencil}
        size="lg"
      >
        <PlanForm
          form={form}
          setForm={setForm}
          submitting={submitting}
          error={formError}
          editing
          onCancel={closeModals}
          onSubmit={handleSubmit}
        />
      </Modal>

      {ConfirmationDialog}
    </div>
  );
}
