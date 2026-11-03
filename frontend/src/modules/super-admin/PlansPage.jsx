import React, { useCallback, useEffect, useRef, useState } from "react";
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
import {
  PageHeader,
  SectionCard,
  DataTable,
  Button,
  Modal,
  Field,
  Select,
  SearchInput,
  HubTabs,
  FORM_CONTROL_CLASS,
} from "../../components/billing-ui";
import { ErrorState, Pagination, StatusBadge, SuccessMessage, useConfirmationDialog } from "../../components/billing-shared";
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
      "Reusable plan templates offered to every organization. Prices and limits stay blank until an approved catalogue supplies them — nothing is invented here.",
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
      "Every upgrade and downgrade an organization has attempted — including blocked ones — so you can investigate failed or stuck plan changes and cancel scheduled ones.",
  },
];

const VALID_TABS = TABS.map((tab) => tab.key);

const SUCCESS_DISMISS_MS = 6000;

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

// Human labels for the PATCH-able fields, used in validation messages.
const FIELD_LABELS = {
  plan_name: "Plan name",
  description: "Description",
  billing_interval: "Billing interval",
  currency: "Currency",
  price_amount: "Price",
  effective_from: "Effective from",
  effective_to: "Effective to",
  max_users: "Max users",
  max_storage_gb: "Max storage",
  features: "Features",
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

// Returns { payload } or { error }. Validates what the backend schema would
// otherwise reject with a raw 422 (features must be a JSON object, limits are
// whole numbers) or silently accept (negative prices, inverted date ranges).
function buildPayload(form) {
  const num = (v) => (v === "" || v === null || v === undefined ? null : Number(v));
  const payload = {
    plan_code: form.plan_code.trim(),
    plan_name: form.plan_name.trim(),
    description: form.description.trim() || null,
    billing_interval: form.billing_interval || null,
    currency: form.currency.trim().toUpperCase() || null,
    price_amount: num(form.price_amount),
    effective_from: form.effective_from || null,
    effective_to: form.effective_to || null,
    max_users: num(form.max_users),
    max_storage_gb: num(form.max_storage_gb),
    is_default: Boolean(form.is_default),
  };
  if (!payload.plan_code || !payload.plan_name) return { error: "Plan code and plan name are required." };
  if (payload.currency && !/^[A-Z]{3}$/.test(payload.currency)) {
    return { error: "Currency must be a 3-letter ISO code, e.g. USD." };
  }
  if (payload.price_amount !== null && !(Number.isFinite(payload.price_amount) && payload.price_amount >= 0)) {
    return { error: "Price must be a number of 0 or more." };
  }
  for (const key of ["max_users", "max_storage_gb"]) {
    const v = payload[key];
    if (v !== null && !(Number.isInteger(v) && v >= 0)) return { error: `${FIELD_LABELS[key]} must be a whole number of 0 or more.` };
  }
  if (payload.effective_from && payload.effective_to && payload.effective_to < payload.effective_from) {
    return { error: "“Effective to” must be on or after “Effective from”." };
  }
  const features = form.features.trim();
  if (features) {
    let parsed;
    try {
      parsed = JSON.parse(features);
    } catch (err) {
      return { error: `Features must be valid JSON: ${err.message}` };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: 'Features must be a JSON object, e.g. {"api_access": true}.' };
    }
    payload.features = parsed;
  } else {
    payload.features = null;
  }
  return { payload };
}

// PATCH /commercial-plans/{id} only applies fields that are non-null
// (CommercialPlanService.update_plan skips None), and its schema has no
// is_default. So an edit sends only the fields that actually changed, and a
// field the operator emptied is reported instead of "saved" — before, both
// were silently dropped while the page announced "Plan … updated."
function buildUpdate(plan, form, payload) {
  const original = toForm(plan);
  const update = {};
  const cleared = [];
  for (const key of Object.keys(FIELD_LABELS)) {
    if ((form[key] ?? "") === (original[key] ?? "")) continue;
    if (payload[key] === null) {
      if (original[key] !== "") cleared.push(FIELD_LABELS[key]);
      continue;
    }
    update[key] = payload[key];
  }
  return { update, cleared };
}

function PlanForm({ form, setForm, submitting, error, onCancel, onSubmit, editing }) {
  const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));
  const setCheck = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.checked }));
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="grid gap-4 sm:grid-cols-2"
    >
      <Field label="Plan code" htmlFor="pp-code" required hint={editing ? "Can't be changed — subscription history refers to it." : "Short, permanent identifier, e.g. standard."}>
        <input
          id="pp-code"
          value={form.plan_code}
          onChange={set("plan_code")}
          disabled={editing}
          placeholder="e.g. standard"
          maxLength={50}
          autoFocus={!editing}
          className={FORM_CONTROL_CLASS}
        />
      </Field>
      <Field label="Plan name" htmlFor="pp-name" required>
        <input
          id="pp-name"
          value={form.plan_name}
          onChange={set("plan_name")}
          placeholder="e.g. Standard"
          maxLength={200}
          autoFocus={editing}
          className={FORM_CONTROL_CLASS}
        />
      </Field>
      <Field label="Description" htmlFor="pp-desc" className="sm:col-span-2">
        <textarea id="pp-desc" value={form.description} onChange={set("description")} rows={2} className={FORM_CONTROL_CLASS} />
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
      <Field label="Currency" htmlFor="pp-currency" hint="3-letter ISO code, e.g. USD">
        <input id="pp-currency" value={form.currency} onChange={set("currency")} maxLength={3} placeholder="USD" className={`${FORM_CONTROL_CLASS} uppercase`} />
      </Field>
      <Field label="Price" htmlFor="pp-price" hint="Leave blank until an approved catalogue supplies a price.">
        <input id="pp-price" type="number" min="0" step="0.01" value={form.price_amount} onChange={set("price_amount")} className={FORM_CONTROL_CLASS} />
      </Field>
      <Field label="Max users" htmlFor="pp-users" hint="Blank means not set.">
        <input id="pp-users" type="number" min="0" step="1" value={form.max_users} onChange={set("max_users")} className={FORM_CONTROL_CLASS} />
      </Field>
      <Field label="Max storage (GB)" htmlFor="pp-storage" hint="Blank means not set.">
        <input id="pp-storage" type="number" min="0" step="1" value={form.max_storage_gb} onChange={set("max_storage_gb")} className={FORM_CONTROL_CLASS} />
      </Field>
      <div className="hidden sm:block" aria-hidden="true" />
      <Field label="Effective from" htmlFor="pp-from">
        <input id="pp-from" type="date" value={form.effective_from} onChange={set("effective_from")} className={FORM_CONTROL_CLASS} />
      </Field>
      <Field label="Effective to" htmlFor="pp-to">
        <input id="pp-to" type="date" value={form.effective_to} min={form.effective_from || undefined} onChange={set("effective_to")} className={FORM_CONTROL_CLASS} />
      </Field>
      <Field label="Features (JSON)" htmlFor="pp-features" hint={'Optional feature flags as a JSON object, e.g. {"api_access": true}'} className="sm:col-span-2">
        <textarea
          id="pp-features"
          value={form.features}
          onChange={set("features")}
          rows={4}
          placeholder='{"api_access": true}'
          className={`${FORM_CONTROL_CLASS} font-mono text-xs`}
        />
      </Field>
      {editing ? (
        <p className="text-xs text-slate-500 sm:col-span-2">
          To make this the default plan, use <span className="font-semibold">Set default</span> on its row in the plans list.
        </p>
      ) : (
        <label className="flex items-center gap-2 text-sm font-medium text-slate-600 sm:col-span-2">
          <input
            type="checkbox"
            checked={form.is_default}
            onChange={setCheck("is_default")}
            className="h-4 w-4 rounded border-slate-300 accent-brand"
          />
          Make this the default plan for new registrations (replaces any current default)
        </label>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 sm:col-span-2">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2 sm:col-span-2">
        <Button variant="secondary" onClick={onCancel} disabled={submitting}>Cancel</Button>
        <Button type="submit" variant="primary" loading={submitting}>
          {editing ? "Save changes" : "Create plan"}
        </Button>
      </div>
    </form>
  );
}

const STATUS_TILES = [
  { key: "", label: "All plans", dot: "bg-slate-800" },
  { key: "active", label: "Active", dot: "bg-emerald-500" },
  { key: "inactive", label: "Inactive", dot: "bg-amber-500" },
  { key: "archived", label: "Archived", dot: "bg-slate-400" },
];

/** Catalogue-wide counts per status that double as the status filter. */
function PlanStatusOverview({ counts, selected, onSelect }) {
  const total = counts ? (counts.active ?? 0) + (counts.inactive ?? 0) + (counts.archived ?? 0) : null;
  return (
    <div role="group" aria-label="Filter plans by status" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {STATUS_TILES.map((tile) => {
        const active = selected === tile.key;
        const count = tile.key === "" ? total : counts ? counts[tile.key] ?? 0 : null;
        return (
          <button
            key={tile.key || "all"}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(tile.key)}
            className={`rounded-2xl border p-3.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
              active ? "border-brand-500 bg-brand-50 shadow-sm" : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm"
            }`}
          >
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <span className={`h-2 w-2 rounded-full ${tile.dot}`} aria-hidden="true" />
              {tile.label}
            </span>
            <span className={`mt-1.5 block text-2xl font-extrabold ${active ? "text-brand-700" : "text-slate-800"}`}>
              {count == null ? "—" : count.toLocaleString()}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function formatPrice(row) {
  if (row.price_amount === null || row.price_amount === undefined) return null;
  const n = Number(row.price_amount);
  const amount = Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(row.price_amount);
  return `${row.currency ? `${row.currency} ` : ""}${amount}`;
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
  const [counts, setCounts] = useState(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Separate from the load error: a failed status/default change keeps the
  // list on screen and is dismissible — "Retry" there used to re-fetch the
  // list rather than retry the action that failed.
  const [actionError, setActionError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);
  const { confirm, ConfirmationDialog } = useConfirmationDialog();
  const requestRef = useRef(0);

  const load = useCallback(async (pageNum) => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = { skip: (pageNum - 1) * PAGE_SIZE, limit: PAGE_SIZE };
      if (search.trim()) params.search = search.trim();
      if (statusFilter) params.status = statusFilter;
      const data = await listCommercialPlans(params);
      if (requestId !== requestRef.current) return;
      setPlans(data?.plans || []);
      setTotal(data?.total || 0);
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setError(err?.message || "Failed to load commercial plans.");
      setPlans([]);
      setTotal(0);
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [search, statusFilter]);

  // Real per-status totals from the list endpoint's own `total` — no
  // client-side extrapolation from the current page.
  const loadCounts = useCallback(async () => {
    try {
      const results = await Promise.all(
        ["active", "inactive", "archived"].map((status) => listCommercialPlans({ status, limit: 1 }))
      );
      setCounts({
        active: results[0]?.total ?? 0,
        inactive: results[1]?.total ?? 0,
        archived: results[2]?.total ?? 0,
      });
    } catch {
      setCounts(null);
    }
  }, []);

  useEffect(() => {
    load(page);
  }, [load, page]);

  useEffect(() => {
    loadCounts();
  }, [loadCounts]);

  useEffect(() => {
    if (!success) return undefined;
    const t = setTimeout(() => setSuccess(null), SUCCESS_DISMISS_MS);
    return () => clearTimeout(t);
  }, [success]);

  const refresh = useCallback(async () => {
    await Promise.all([load(page), loadCounts()]);
  }, [load, loadCounts, page]);

  const changeSearch = (value) => {
    setSearch(value);
    setPage(1);
  };
  const changeStatusFilter = (value) => {
    setStatusFilter(value);
    setPage(1);
  };

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
    if (submitting) return;
    setCreateOpen(false);
    setEditing(null);
  };

  const handleSubmit = async () => {
    if (submitting) return;
    const { payload, error: validationError } = buildPayload(form);
    if (validationError) {
      setFormError(validationError);
      return;
    }
    let update;
    if (editing) {
      const diff = buildUpdate(editing, form, payload);
      if (diff.cleared.length > 0) {
        setFormError(
          `A plan template can't clear a value once it's set, so emptying ${diff.cleared.join(", ")} would not be saved. ` +
            "Put the value back, or draft a new catalog version (Versions) without it."
        );
        return;
      }
      if (Object.keys(diff.update).length === 0) {
        setFormError("Nothing has changed yet.");
        return;
      }
      update = diff.update;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      if (editing) {
        await updateCommercialPlan(editing.id, update);
        setSuccess(`Plan ${editing.plan_code} updated.`);
      } else {
        const created = await createCommercialPlan(payload);
        setSuccess(`Plan ${created?.plan_code || payload.plan_code} created.`);
      }
      setSubmitting(false);
      setCreateOpen(false);
      setEditing(null);
      await refresh();
    } catch (err) {
      setFormError(err?.message || "Failed to save plan.");
      setSubmitting(false);
    }
  };

  const runRowAction = async (plan, action, successMessage, failureMessage) => {
    setBusyId(plan.id);
    setActionError(null);
    try {
      await action();
      setSuccess(successMessage);
      await refresh();
    } catch (err) {
      setActionError(err?.message || failureMessage);
    } finally {
      setBusyId(null);
    }
  };

  const handleStatusChange = async (plan, newStatus) => {
    const ok = await confirm({
      title:
        newStatus === "archived"
          ? `Archive ${plan.plan_code}?`
          : newStatus === "inactive"
            ? `Stop selling ${plan.plan_code}?`
            : `Activate ${plan.plan_code}?`,
      message:
        newStatus === "archived"
          ? "Archived plans can never be sold again and their status can't be changed afterwards. Existing subscriptions and history are kept."
          : newStatus === "inactive"
            ? `Inactive plans are no longer offered; existing subscriptions stay valid.${plan.is_default ? " This plan is the current default, so the catalogue will be left with no default plan." : ""}`
            : "Active plans can be assigned to new subscriptions.",
      confirmLabel: newStatus === "archived" ? "Archive plan" : newStatus === "inactive" ? "Deactivate" : "Activate",
      tone: newStatus === "archived" ? "danger" : "primary",
    });
    if (!ok) return;
    await runRowAction(
      plan,
      () => setCommercialPlanStatus(plan.id, newStatus),
      `Plan ${plan.plan_code} is now ${newStatus}.`,
      "Failed to change plan status."
    );
  };

  const handleDefaultChange = async (plan) => {
    const ok = await confirm({
      title: plan.is_default ? `Clear default on ${plan.plan_code}?` : `Make ${plan.plan_code} the default plan?`,
      message: plan.is_default
        ? "Without a default plan, new registrations are not given any plan automatically."
        : "New registrations will be given this plan. Any other default plan stops being the default.",
      confirmLabel: plan.is_default ? "Clear default" : "Make default",
      tone: "primary",
    });
    if (!ok) return;
    await runRowAction(
      plan,
      () => setCommercialPlanDefault(plan.id, !plan.is_default),
      plan.is_default ? `Default cleared on ${plan.plan_code}.` : `${plan.plan_code} is now the default plan.`,
      "Failed to change default plan."
    );
  };

  // Not memoised: the action handlers close over the current page/filters.
  // The old useMemo(..., []) froze them at first render, so an action taken
  // on page 2 reloaded page 1's rows under a page-2 pagination bar.
  const columns = [
    {
      key: "plan",
      label: "Plan",
      render: (row) => (
        <span className="block min-w-0">
          <span className="flex flex-wrap items-center gap-1.5 font-semibold text-slate-800">
            {row.plan_name}
            {row.is_default && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700">
                <Crown size={10} /> Default
              </span>
            )}
          </span>
          <span className="block font-mono text-xs text-slate-500">{row.plan_code}</span>
          {row.description && <span className="mt-0.5 block max-w-xs truncate text-xs text-slate-400" title={row.description}>{row.description}</span>}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (row) => <StatusBadge status={row.status} options={PLAN_STATUS_OPTIONS} />,
    },
    {
      key: "price",
      label: "Price",
      render: (row) => {
        const price = formatPrice(row);
        const interval = BILLING_INTERVAL_OPTIONS.find((o) => o.value === row.billing_interval)?.label;
        return price ? (
          <span className="text-xs text-slate-700">
            <span className="font-semibold">{price}</span>
            {interval && <span className="text-slate-500"> / {interval.toLowerCase()}</span>}
          </span>
        ) : (
          <span className="text-xs text-slate-400">{interval ? `Not set · ${interval}` : "Not set"}</span>
        );
      },
    },
    {
      key: "limits",
      label: "Limits",
      render: (row) => (
        <span className="text-xs text-slate-600">
          {row.max_users == null ? "No user limit set" : `${displayValue(row.max_users)} users`}
          <span className="block text-slate-500">
            {row.max_storage_gb == null ? "No storage limit set" : `${displayValue(row.max_storage_gb)} GB storage`}
          </span>
        </span>
      ),
    },
    {
      key: "effective",
      label: "Effective",
      render: (row) => (
        <span className="text-xs text-slate-600">
          {row.effective_from || row.effective_to
            ? `${row.effective_from ? formatDateOnly(row.effective_from) : "Any time"} — ${row.effective_to ? formatDateOnly(row.effective_to) : "open-ended"}`
            : "Always"}
        </span>
      ),
    },
    {
      key: "actions",
      label: "Actions",
      width: 300,
      render: (row) => {
        const busy = busyId === row.id;
        const disabled = busyId !== null;
        return (
          <div className="flex flex-wrap items-center gap-1">
            <Button
              size="sm"
              variant="secondary"
              icon={GitBranch}
              onClick={() => navigate(`/super-admin/commercial/plans/${row.id}/versions`)}
              aria-label={`View catalog versions for ${row.plan_code}`}
            >
              Versions
            </Button>
            <Button size="sm" variant="secondary" icon={Pencil} disabled={disabled} onClick={() => openEdit(row)} aria-label={`Edit ${row.plan_code}`}>
              Edit
            </Button>
            {row.status !== "archived" && (
              <Button
                size="sm"
                variant="ghost"
                icon={Power}
                loading={busy}
                disabled={disabled}
                onClick={() => handleStatusChange(row, row.status === "active" ? "inactive" : "active")}
                aria-label={`${row.status === "active" ? "Deactivate" : "Activate"} ${row.plan_code}`}
              >
                {row.status === "active" ? "Deactivate" : "Activate"}
              </Button>
            )}
            {row.status === "active" && (
              <Button
                size="sm"
                variant="ghost"
                icon={row.is_default ? StarOff : Star}
                disabled={disabled}
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
                disabled={disabled}
                onClick={() => handleStatusChange(row, "archived")}
                aria-label={`Archive ${row.plan_code}`}
              >
                Archive
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = Boolean(search.trim() || statusFilter);

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
        meta={activeTab === "plans" ? `${displayValue(total)} plan(s)${filtered ? " match your filters" : ""}` : undefined}
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
            <PlanStatusOverview counts={counts} selected={statusFilter} onSelect={changeStatusFilter} />

            {success && <SuccessMessage message={success} onDismiss={() => setSuccess(null)} />}
            {actionError && (
              <div className="flex items-start justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
                <span>{actionError}</span>
                <button type="button" onClick={() => setActionError(null)} className="shrink-0 font-semibold underline">Dismiss</button>
              </div>
            )}

            <SectionCard
              variant="standard"
              accent="violet"
              title="Plan catalogue"
              description="Open Versions to publish price or limit changes through approval; editing a template here never rewrites existing subscriptions."
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <SearchInput
                    value={search}
                    onChange={changeSearch}
                    placeholder="Search by code, name or description"
                    className="w-full sm:w-72"
                  />
                  <Select
                    value={statusFilter}
                    onChange={changeStatusFilter}
                    options={PLAN_STATUS_OPTIONS}
                    placeholder="All statuses"
                    aria-label="Filter by status"
                    className="w-40"
                  />
                </div>
              }
            >
              {/* A failed fetch also clears `plans` to [], so rendering the
                  table unconditionally showed "No commercial plans yet" right
                  under the error — a fetch failure read as an empty
                  catalogue. The search/filter controls above stay visible. */}
              {error ? (
                <ErrorState title="Couldn't load plans" message={error} onRetry={() => load(page)} />
              ) : (
                <>
                  <DataTable
                    columns={columns}
                    data={plans}
                    loading={loading}
                    loadingRows={4}
                    emptyTitle={filtered ? "No plans match your filters" : "No commercial plans yet"}
                    emptyMessage={
                      filtered
                        ? "Try a different search, or clear the status filter."
                        : "Create the first plan template to start building the catalogue."
                    }
                    emptyAction={
                      filtered ? (
                        <Button variant="secondary" onClick={() => { changeSearch(""); changeStatusFilter(""); }}>Clear filters</Button>
                      ) : (
                        <Button variant="primary" icon={Plus} onClick={openCreate}>Create plan</Button>
                      )
                    }
                    minWidth={1000}
                  />
                  <Pagination page={page} totalPages={totalPages} onPageChange={setPage}>
                    {displayValue(total)} plan(s)
                  </Pagination>
                </>
              )}
            </SectionCard>
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
        description="Only the code and name are required. Leave pricing and limits blank until an approved catalogue supplies them."
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
        description="Editing a template never rewrites existing subscriptions. Only the fields you change are saved."
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
