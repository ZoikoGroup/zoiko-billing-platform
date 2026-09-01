import { useState, useEffect, useCallback } from "react";
import {
  Plus,
  Pencil,
  Power,
  PowerOff,
  Copy,
  Tag,
  Package,
  Loader2,
  CheckCircle,
  Eye,
} from "lucide-react";
import {
  subscriptionApi,
} from "../../../service/billingService";
import {
  formatDisplayDate,
  extractArray,
} from "../../../utils/billing-helpers";
import {
  PageHeader,
  DataTable,
  FormModal,
  ListToolbar,
  Field,
  Select,
  Button,
} from "../../../components/billing-ui";
import {
  ErrorState,
  PageSkeleton,
  EmptyState,
  useConfirmationDialog,
} from "../../../components/billing-shared";
import { useCurrency } from "../utils/CurrencyContext";

const ITEMS_PER_PAGE = 10;

const PERIOD_LABELS = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  semi_annual: "Semi-annual",
  annual: "Annual",
  one_time: "One-time",
};

const PERIOD_OPTIONS = [
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "semi_annual", label: "Semi-annual" },
  { value: "annual", label: "Annual" },
  { value: "one_time", label: "One-time" },
];

const CATEGORY_OPTIONS = [
  { value: "subscription", label: "Subscription" },
  { value: "usage", label: "Usage" },
  { value: "retainer", label: "Retainer" },
  { value: "bundle", label: "Bundle" },
];

function PlanStatusBadge({ active }) {
  return active ? (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
      <CheckCircle size={12} /> Active
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-500">
      <PowerOff size={12} /> Inactive
    </span>
  );
}

function VisibilityBadge({ isPublic }) {
  return isPublic ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">
      <Eye size={11} /> Public
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
      Private
    </span>
  );
}

const BLANK_FORM = {
  plan_code: "",
  plan_name: "",
  description: "",
  category: "subscription",
  billing_period: "monthly",
  billing_cycles: 0,
  pricing_model: "flat",
  unit_price: "",
  setup_fee: "0",
  trial_days: "0",
  is_public: true,
  sort_order: 0,
};

export default function SubscriptionPlansPage() {
  const { baseCurrency: orgCurrency } = useCurrency();

  const [plans, setPlans] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState(null);
  const [form, setForm] = useState(BLANK_FORM);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formErrors, setFormErrors] = useState({});

  const [actionLoadingId, setActionLoadingId] = useState(null);
  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  const [successMsg, setSuccessMsg] = useState("");
  const [duplicateTarget, setDuplicateTarget] = useState(null);
  const [duplicating, setDuplicating] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setCurrentPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchPlans = useCallback(async (page = 1, perPage = ITEMS_PER_PAGE) => {
    setLoading(true);
    setError(null);
    try {
      const data = await subscriptionApi.listPlans({
        page,
        per_page: perPage,
        search_term: debouncedSearch || undefined,
        category: categoryFilter || undefined,
        active_only: false,
      });
      setPlans(extractArray(data));
      setTotal(data?.total ?? 0);
    } catch (err) {
      setError((err && (err.detail || err.message)) || "Failed to load subscription plans.");
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, categoryFilter]);

  useEffect(() => {
    fetchPlans(currentPage);
  }, [debouncedSearch, categoryFilter, currentPage, fetchPlans]);

  useEffect(() => {
    if (!successMsg) return;
    const t = setTimeout(() => setSuccessMsg(""), 4000);
    return () => clearTimeout(t);
  }, [successMsg]);

  const applyFilters = () => {
    setCurrentPage(1);
    fetchPlans(1);
  };

  const resetFilters = () => {
    setSearch("");
    setDebouncedSearch("");
    setCategoryFilter("");
    setStatusFilter("");
    setCurrentPage(1);
  };

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchPlans(currentPage);
    } finally {
      setRefreshing(false);
    }
  }, [fetchPlans, currentPage]);

  const openCreate = () => {
    setEditingPlan(null);
    setForm({ ...BLANK_FORM, unit_price: "" });
    setFormError(null);
    setFormErrors({});
    setModalOpen(true);
  };

  const openEdit = (plan) => {
    setEditingPlan(plan);
    setForm({
      plan_code: plan.plan_code,
      plan_name: plan.plan_name,
      description: plan.description || "",
      category: plan.category,
      billing_period: plan.billing_period,
      billing_cycles: plan.billing_cycles ?? 0,
      pricing_model: plan.pricing_model,
      unit_price: plan.unit_price ?? "",
      setup_fee: plan.setup_fee ?? "0",
      trial_days: plan.trial_days ?? "0",
      is_public: plan.is_public,
      sort_order: plan.sort_order ?? 0,
    });
    setFormError(null);
    setFormErrors({});
    setModalOpen(true);
  };

  const validateForm = () => {
    const errs = {};
    if (!form.plan_code.trim()) errs.plan_code = "Plan code is required.";
    if (!form.plan_name.trim()) errs.plan_name = "Plan name is required.";
    if (form.unit_price === "" || form.unit_price === null || form.unit_price === undefined) {
      errs.unit_price = "Unit price is required.";
    } else {
      const price = Number(form.unit_price);
      if (Number.isNaN(price)) errs.unit_price = "Unit price must be a valid number.";
      else if (price < 0) errs.unit_price = "Unit price cannot be negative.";
    }
    if (form.setup_fee !== "" && form.setup_fee !== null && form.setup_fee !== undefined) {
      const fee = Number(form.setup_fee);
      if (Number.isNaN(fee)) errs.setup_fee = "Setup fee must be a valid number.";
      else if (fee < 0) errs.setup_fee = "Setup fee cannot be negative.";
    }
    if (form.trial_days !== "" && form.trial_days !== null && form.trial_days !== undefined) {
      const days = Number(form.trial_days);
      if (Number.isNaN(days)) errs.trial_days = "Trial days must be a valid number.";
      else if (days < 0) errs.trial_days = "Trial days cannot be negative.";
    }
    if (form.billing_cycles !== "" && form.billing_cycles !== null && form.billing_cycles !== undefined) {
      const cycles = Number(form.billing_cycles);
      if (Number.isNaN(cycles)) errs.billing_cycles = "Billing cycles must be a valid number.";
      else if (cycles < 0) errs.billing_cycles = "Billing cycles cannot be negative.";
    }
    setFormErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async () => {
    if (saving) return;
    if (!validateForm()) return;
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        plan_code: form.plan_code.trim(),
        plan_name: form.plan_name.trim(),
        description: form.description?.trim() || null,
        category: form.category,
        billing_period: form.billing_period,
        billing_cycles: Number(form.billing_cycles || 0),
        pricing_model: form.pricing_model,
        unit_price: Number(form.unit_price),
        setup_fee: Number(form.setup_fee || 0),
        trial_days: Number(form.trial_days || 0),
        is_public: form.is_public,
        sort_order: Number(form.sort_order || 0),
      };
      if (editingPlan) {
        await subscriptionApi.updatePlan(editingPlan.id, payload);
        setSuccessMsg("Plan updated successfully.");
      } else {
        await subscriptionApi.createPlan(payload);
        setSuccessMsg("Plan created successfully.");
      }
      setModalOpen(false);
      setCurrentPage(1);
      await fetchPlans(1);
    } catch (err) {
      setFormError((err && (err.detail || err.message)) || "Failed to save plan.");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (plan) => {
    if (actionLoadingId) return;
    const action = plan.is_active ? "deactivate" : "activate";
    const confirmed = await confirm({
      title: plan.is_active ? "Deactivate plan?" : "Activate plan?",
      message: plan.is_active
        ? `"${plan.plan_name}" will no longer appear as selectable in Create Subscription. Existing subscriptions are unaffected.`
        : `"${plan.plan_name}" will become selectable in Create Subscription.`,
      confirmLabel: plan.is_active ? "Deactivate" : "Activate",
      tone: plan.is_active ? "danger" : "primary",
    });
    if (!confirmed) return;
    setActionLoadingId(plan.id);
    setError(null);
    try {
      if (plan.is_active) {
        await subscriptionApi.deactivatePlan(plan.id);
        setSuccessMsg("Plan deactivated.");
      } else {
        await subscriptionApi.activatePlan(plan.id);
        setSuccessMsg("Plan activated.");
      }
      await fetchPlans(currentPage);
    } catch (err) {
      setError((err && (err.detail || err.message)) || "Failed to update plan status.");
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleDuplicate = async (plan) => {
    if (duplicating) return;
    const ok = await confirm({
      title: "Duplicate plan?",
      message: `Create a copy of "${plan.plan_name}" with a new plan code?`,
      confirmLabel: "Duplicate",
      tone: "primary",
    });
    if (!ok) return;
    setDuplicateTarget(plan.id);
    setDuplicating(true);
    setFormError(null);
    try {
      const baseCode = plan.plan_code;
      const suffix = `-copy`;
      const candidates = [baseCode + suffix];
      let code = candidates[0];
      let collision = true;
      for (let attempt = 1; collision && attempt < 5; attempt++) {
        try {
          await subscriptionApi.createPlan({
            plan_code: code,
            plan_name: `${plan.plan_name} (Copy)`,
            description: plan.description || null,
            category: plan.category,
            billing_period: plan.billing_period,
            billing_cycles: plan.billing_cycles ?? 0,
            pricing_model: plan.pricing_model,
            unit_price: plan.unit_price,
            setup_fee: plan.setup_fee ?? 0,
            trial_days: plan.trial_days ?? 0,
            is_public: plan.is_public,
            sort_order: (plan.sort_order ?? 0) + 1,
          });
          collision = false;
        } catch (err) {
          if (err && (err.status === 409 || (err.detail && typeof err.detail === "string" && (err.detail.includes("exists") || err.detail.includes("already"))))) {
            code = `${baseCode}${suffix}${attempt}`;
          } else {
            throw err;
          }
        }
      }
      setSuccessMsg("Plan duplicated successfully.");
      setCurrentPage(1);
      await fetchPlans(1);
    } catch (err) {
      setError((err && (err.detail || err.message)) || "Failed to duplicate plan.");
    } finally {
      setDuplicateTarget(null);
      setDuplicating(false);
    }
  };

  const filteredPlans = statusFilter
    ? plans.filter((p) =>
        statusFilter === "active" ? p.is_active === true : p.is_active === false
      )
    : plans;

  const columns = [
    {
      key: "plan_name",
      label: "Plan",
      render: (row) => (
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
            <Tag size={16} />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900">
              {row.plan_name || row.plan_code}
            </div>
            <div className="text-xs text-slate-500">{row.plan_code}</div>
            {row.description && (
              <div className="mt-0.5 max-w-xs truncate text-xs text-slate-400">{row.description}</div>
            )}
          </div>
        </div>
      ),
    },
    {
      key: "unit_price",
      label: "Price",
      render: (row) => (
        <span className="text-sm font-semibold text-slate-900">
          {formatPrice(row.unit_price, orgCurrency)}
          <span className="text-xs font-normal text-slate-500">
            {" "}/ {PERIOD_LABELS[row.billing_period] || row.billing_period}
          </span>
        </span>
      ),
    },
    {
      key: "setup_fee",
      label: "Setup Fee",
      render: (row) => (
        <span className="text-sm text-slate-600">
          {row.setup_fee && Number(row.setup_fee) > 0 ? formatPrice(row.setup_fee, orgCurrency) : "\u2014"}
        </span>
      ),
    },
    {
      key: "trial_days",
      label: "Trial",
      render: (row) => (
        <span className="text-sm text-slate-600">
          {row.trial_days && Number(row.trial_days) > 0 ? `${row.trial_days} days` : "\u2014"}
        </span>
      ),
    },
    {
      key: "category",
      label: "Category",
      render: (row) => (
        <span className="text-sm capitalize text-slate-600">{row.category || "\u2014"}</span>
      ),
    },
    {
      key: "is_public",
      label: "Visible",
      render: (row) => <VisibilityBadge isPublic={row.is_public} />,
    },
    {
      key: "is_active",
      label: "Status",
      render: (row) => <PlanStatusBadge active={row.is_active} />,
    },
    {
      key: "created_at",
      label: "Created",
      render: (row) => (
        <span className="text-sm text-slate-500">{formatDisplayDate(row.created_at)}</span>
      ),
    },
    {
      key: "actions",
      label: "Actions",
      align: "right",
      render: (row) => {
        const ToggleIcon = row.is_active ? PowerOff : Power;
        const DuplicateIcon = duplicating && duplicateTarget === row.id ? Loader2 : Copy;
        return (
          <div className="flex items-center justify-end gap-1">
            <Button size="sm" variant="ghost" icon={Pencil} onClick={() => openEdit(row)} aria-label={`Edit ${row.plan_name}`} title="Edit plan">
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={ToggleIcon}
              loading={actionLoadingId === row.id}
              onClick={() => handleToggleActive(row)}
              aria-label={row.is_active ? `Deactivate ${row.plan_name}` : `Activate ${row.plan_name}`}
              title={row.is_active ? "Deactivate" : "Activate"}
            >
              {row.is_active ? "Deactivate" : "Activate"}
            </Button>
            <Button size="sm" variant="ghost" icon={DuplicateIcon} onClick={() => handleDuplicate(row)} aria-label={`Duplicate ${row.plan_name}`} title="Duplicate plan" />
          </div>
        );
      },
    },
  ];

  function formatPrice(v, currency) {
    if (v === null || v === undefined || v === "") return "\u2014";
    const n = Number(v);
    if (Number.isNaN(n)) return "\u2014";
    const symMap = { USD: "$", EUR: "€", GBP: "£", INR: "₹", JPY: "¥", AED: "AED ", SGD: "S$", CAD: "C$", AUD: "A$", CHF: "CHF " };
    const sym = symMap[currency] || (currency ? `${currency} ` : "");
    return `${sym}${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Subscription Plans"
        description="Manage the subscription plan catalog used in Create Subscription."
        icon={Package}
        crumbs={[{ label: "Billing" }, { label: "Subscriptions" }, { label: "Plans" }]}
      />
      {successMsg && (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
          <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {error && (
        <ErrorState
          title="Could not load plans"
          message={error}
          onRetry={() => { setError(null); setLoading(true); fetchPlans(currentPage); }}
        />
      )}

      {!error && loading && plans.length === 0 && <PageSkeleton rows={5} />}

      {!error && !loading && (
        <div>
          <ListToolbar
            search={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search plans…"
            filtersOpen={showFilters}
            onToggleFilters={() => setShowFilters((v) => !v)}
            onRefresh={refresh}
            refreshing={refreshing}
            primaryLabel="Create Plan"
            onPrimary={openCreate}
            primaryIcon={Plus}
          >
            {showFilters && (
              <div className="flex flex-wrap items-center gap-3">
                <Field label="Category">
                  <Select
                    value={categoryFilter}
                    onChange={setCategoryFilter}
                    options={CATEGORY_OPTIONS}
                    placeholder="All Categories"
                    className="w-44"
                  />
                </Field>
                <Field label="Status">
                  <Select
                    value={statusFilter}
                    onChange={setStatusFilter}
                    options={[
                      { value: "active", label: "Active" },
                      { value: "inactive", label: "Inactive" },
                    ]}
                    placeholder="All Statuses"
                    className="w-40"
                  />
                </Field>
                <Button variant="secondary" size="sm" onClick={resetFilters}>
                  Reset
                </Button>
              </div>
            )}
          </ListToolbar>

          {plans.length === 0 && search === "" ? (
            <EmptyState
              icon={Package}
              title="No subscription plans yet"
              message="Create your first plan to start building subscriptions."
              actionLabel="Create your first plan"
              onAction={openCreate}
            />
          ) : (
            <DataTable
              columns={columns}
              data={filteredPlans}
              rowKey={(row) => row.id}
              emptyTitle="No subscription plans found"
              emptyMessage="Try adjusting your search or filters."
              emptyAction={
                <Button variant="secondary" icon={<Plus size={14} />} onClick={openCreate}>
                  Create Plan
                </Button>
              }
            />
          )}

          {total > ITEMS_PER_PAGE && (
            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs text-slate-500">
                {total} {total === 1 ? "plan" : "plans"}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={currentPage <= 1}
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <span className="px-3 text-sm text-slate-500">Page {currentPage}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={currentPage * ITEMS_PER_PAGE >= total}
                  onClick={() => setCurrentPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <FormModal
        open={modalOpen}
        onClose={() => !saving && setModalOpen(false)}
        onSubmit={handleSubmit}
        title={editingPlan ? "Edit Plan" : "Create Plan"}
        description={editingPlan ? `Edit "${editingPlan.plan_name}"` : "Add a new subscription plan."}
        icon={editingPlan ? Pencil : Plus}
        busy={saving}
        error={formError}
        submitLabel={editingPlan ? "Save Changes" : "Create Plan"}
      >
        <div className="grid grid-cols-1 gap-4">
          <Field label="Plan Code" required error={formErrors.plan_code}>
            <input
              type="text"
              value={form.plan_code}
              onChange={(e) => setForm((p) => ({ ...p, plan_code: e.target.value }))}
              disabled={!!editingPlan}
              className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-700 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:bg-slate-50 disabled:text-slate-400"
              placeholder="e.g. basic-monthly"
            />
          </Field>
          <Field label="Plan Name" required error={formErrors.plan_name}>
            <input
              type="text"
              value={form.plan_name}
              onChange={(e) => setForm((p) => ({ ...p, plan_name: e.target.value }))}
              className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-700 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
              placeholder="e.g. Basic Monthly"
            />
          </Field>
          <Field label="Description">
            <textarea
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              rows={2}
              className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-700 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
              placeholder="Optional description"
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Category">
              <Select
                value={form.category}
                onChange={(v) => setForm((p) => ({ ...p, category: v }))}
                options={CATEGORY_OPTIONS}
                placeholder=""
              />
            </Field>
            <Field label="Billing Interval">
              <Select
                value={form.billing_period}
                onChange={(v) => setForm((p) => ({ ...p, billing_period: v }))}
                options={PERIOD_OPTIONS}
                placeholder=""
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Unit Price" required error={formErrors.unit_price} hint={orgCurrency ? `Billed in ${orgCurrency}` : undefined}>
              <div className="relative">
                <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-slate-400">
                  {orgCurrency ? symbolFor(orgCurrency) : ""}
                </span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.unit_price}
                  onChange={(e) => setForm((p) => ({ ...p, unit_price: e.target.value }))}
                  className="w-full rounded-xl border border-slate-200 pl-8 pr-3.5 py-2.5 text-sm text-slate-700 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
                  placeholder="0.00"
                />
              </div>
            </Field>
            <Field label="Setup Fee" error={formErrors.setup_fee}>
              <div className="relative">
                <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-slate-400">
                  {orgCurrency ? symbolFor(orgCurrency) : ""}
                </span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.setup_fee}
                  onChange={(e) => setForm((p) => ({ ...p, setup_fee: e.target.value }))}
                  className="w-full rounded-xl border border-slate-200 pl-8 pr-3.5 py-2.5 text-sm text-slate-700 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
                  placeholder="0.00"
                />
              </div>
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Trial (days)" error={formErrors.trial_days}>
              <input
                type="number"
                min="0"
                value={form.trial_days}
                onChange={(e) => setForm((p) => ({ ...p, trial_days: e.target.value }))}
                className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-700 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
                placeholder="0"
              />
            </Field>
            <Field label="Billing Cycles" error={formErrors.billing_cycles} hint="0 = until cancelled">
              <input
                type="number"
                min="0"
                value={form.billing_cycles}
                onChange={(e) => setForm((p) => ({ ...p, billing_cycles: e.target.value }))}
                className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-700 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
                placeholder="0"
              />
            </Field>
            <Field label="Sort Order">
              <input
                type="number"
                value={form.sort_order}
                onChange={(e) => setForm((p) => ({ ...p, sort_order: e.target.value }))}
                className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-700 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
                placeholder="0"
              />
            </Field>
          </div>
          <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                checked={form.is_public}
                onChange={(e) => setForm((p) => ({ ...p, is_public: e.target.checked }))}
                className="h-4 w-4 rounded border-slate-300 accent-brand"
              />
              Public plan
            </label>
            <span className="text-xs text-slate-500">Public plans are selectable in Create Subscription.</span>
          </div>
        </div>
      </FormModal>

      {ConfirmationDialog}
    </div>
  );

  function symbolFor(currency) {
    const map = { USD: "$", EUR: "€", GBP: "£", INR: "₹", JPY: "¥", AED: "AED ", SGD: "S$", CAD: "C$", AUD: "A$", CHF: "CHF " };
    return map[currency] || (currency ? `${currency} ` : "");
  }
}