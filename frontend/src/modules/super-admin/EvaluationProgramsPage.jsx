import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock, Plus, RefreshCw, ShieldCheck, Timer } from "lucide-react";
import { listCommercialPlans } from "../../service/commercialService";
import {
  listEvaluationPrograms,
  createEvaluationProgram,
  setEvaluationProgramStatus,
  approveEvaluationProgram,
} from "../../service/commandCenterService";
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
import { ErrorState, Spinner, SuccessMessage, useConfirmationDialog } from "../../components/billing-shared";
import { displayValue, formatDateTime } from "./constants";

// Values match the backend enums. trial_expiry.py does not yet implement
// AUTO_CHARGE_ON_EXPIRY or DOWNGRADE — a trial configured that way is
// skipped and logged at expiry (left untouched), so the labels say so
// rather than promising an automatic charge/downgrade.
const PAYMENT_REQUIREMENT_OPTIONS = [
  { value: "none", label: "No card needed" },
  { value: "card_required_upfront", label: "Card required upfront" },
];

const CONVERSION_POLICY_OPTIONS = [
  { value: "manual", label: "Manual — the customer pays to continue" },
  { value: "auto_charge_on_expiry", label: "Auto-charge at trial end (not automated yet)" },
];

const EXPIRY_ACTION_OPTIONS = [
  { value: "suspend", label: "Suspend (after the recovery window)" },
  { value: "downgrade", label: "Downgrade (not automated yet)" },
];

const UNIMPLEMENTED_VALUES = new Set(["auto_charge_on_expiry", "downgrade"]);

const EMPTY_FORM = {
  plan_id: "",
  granted_plan_id: "",
  duration_days: "30",
  payment_requirement: "none",
  conversion_policy: "manual",
  expiry_action: "suspend",
};

const STATUS_FILTERS = [
  { key: "all", label: "All programs", dot: "bg-slate-800", match: () => true },
  { key: "active", label: "Active", dot: "bg-emerald-500", match: (p) => p.is_active },
  { key: "ready", label: "Approved, not active", dot: "bg-sky-500", match: (p) => !p.is_active && p.approved_by != null },
  { key: "needs_approval", label: "Needs approval", dot: "bg-amber-500", match: (p) => !p.is_active && p.approved_by == null },
];

const optionLabel = (options, value) => options.find((o) => o.value === value)?.label || displayValue(value);

const planLabel = (row) => row.plan_code || `plan #${row.plan_id}`;

// cap_value is a JSON column — it may be a number, boolean, string or object.
function formatCapValue(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return displayValue(value);
}

function programStatusPill(isActive) {
  return (
    <span
      className={
        isActive
          ? "inline-flex rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700"
          : "inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600"
      }
    >
      {isActive ? "Active" : "Inactive"}
    </span>
  );
}

function PolicyText({ options, value }) {
  return (
    <span className={`text-xs ${UNIMPLEMENTED_VALUES.has(value) ? "font-medium text-amber-700" : "text-slate-600"}`}>
      {optionLabel(options, value)}
    </span>
  );
}

// `embedded` drops this page's own PageHeader when it is mounted as a tab of
// the Products & Pricing hub.
export default function EvaluationProgramsPage({ embedded = false } = {}) {
  const [programs, setPrograms] = useState([]);
  const [plans, setPlans] = useState([]);
  const [plansError, setPlansError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const [togglingId, setTogglingId] = useState(null);
  const [approvingId, setApprovingId] = useState(null);
  // Row-action outcomes. Kept apart from `error` (a failed LOAD), which
  // replaces the whole table — a rejected toggle must not hide the list.
  const [actionError, setActionError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [detail, setDetail] = useState(null);
  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // The plan catalog only feeds the create form, so failing to load it
    // must not take the programs list down with it.
    const [programsResult, plansResult] = await Promise.allSettled([
      listEvaluationPrograms(),
      listCommercialPlans({ limit: 200 }),
    ]);
    if (programsResult.status === "fulfilled") {
      setPrograms(Array.isArray(programsResult.value) ? programsResult.value : []);
    } else {
      setError(programsResult.reason?.message || "Failed to load evaluation programs.");
      setPrograms([]);
    }
    if (plansResult.status === "fulfilled") {
      setPlans(plansResult.value?.plans || []);
      setPlansError(null);
    } else {
      setPlansError(plansResult.reason?.message || "Failed to load the plan catalog.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // Signup provisioning picks ONE active program per plan with an unordered
  // query, so two active programs on the same plan make the trial terms a
  // new signup gets unpredictable. Surface it instead of letting it hide.
  const activeByPlan = useMemo(() => {
    const m = {};
    for (const p of programs) {
      if (p.is_active) (m[p.plan_id] ||= []).push(p);
    }
    return m;
  }, [programs]);

  const counts = useMemo(() => {
    const c = {};
    for (const f of STATUS_FILTERS) c[f.key] = programs.filter(f.match).length;
    return c;
  }, [programs]);

  const rows = useMemo(() => {
    const matchStatus = STATUS_FILTERS.find((f) => f.key === statusFilter)?.match || (() => true);
    const term = search.trim().toLowerCase();
    return programs.filter((p) => {
      if (!matchStatus(p)) return false;
      if (!term) return true;
      return [p.plan_code, p.granted_plan_code, `#${p.id}`].some((v) => (v || "").toLowerCase().includes(term));
    });
  }, [programs, statusFilter, search]);

  const openCreate = useCallback(() => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setCreateOpen(true);
  }, []);

  const closeCreate = () => {
    if (!submitting) setCreateOpen(false);
  };

  const handleCreate = async (event) => {
    event?.preventDefault();
    if (submitting) return;
    if (!form.plan_id) {
      setFormError("Choose the signup plan this trial applies to.");
      return;
    }
    const days = Number(form.duration_days);
    if (!Number.isInteger(days) || days <= 0) {
      setFormError("Trial length must be a whole number of days, 1 or more.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const created = await createEvaluationProgram({
        plan_id: Number(form.plan_id),
        granted_plan_id: form.granted_plan_id ? Number(form.granted_plan_id) : undefined,
        duration_days: days,
        payment_requirement: form.payment_requirement,
        conversion_policy: form.conversion_policy,
        expiry_action: form.expiry_action,
      });
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      setNotice(`Program #${created?.id ?? ""} created for ${created?.plan_code || "the plan"}. It is inactive until approved and activated.`);
      await load();
    } catch (err) {
      setFormError(err?.message || "Failed to create evaluation program.");
    } finally {
      setSubmitting(false);
    }
  };

  const programLabel = (program) => `${planLabel(program)} program #${program.id}`;

  const handleToggle = async (program) => {
    if (program.is_active) {
      const ok = await confirm({
        title: `Deactivate ${programLabel(program)}?`,
        message: "New signups on this plan stop receiving these trial terms and fall back to the default trial. Trials already granted are not changed.",
        confirmLabel: "Deactivate",
        tone: "danger",
      });
      if (!ok) return;
    } else {
      const others = (activeByPlan[program.plan_id] || []).filter((p) => p.id !== program.id);
      if (others.length > 0) {
        const ok = await confirm({
          title: `Activate a second program for ${planLabel(program)}?`,
          message: `Program ${others.map((p) => `#${p.id}`).join(", ")} is already active for this plan. With more than one active program, which terms a new signup receives is not predictable — deactivate the other program first unless you mean to replace it right after.`,
          confirmLabel: "Activate anyway",
          tone: "danger",
        });
        if (!ok) return;
      }
    }
    setTogglingId(program.id);
    setActionError(null);
    setNotice(null);
    try {
      await setEvaluationProgramStatus(program.id, !program.is_active);
      setNotice(`${programLabel(program)} ${program.is_active ? "deactivated" : "activated"}.`);
      await load();
    } catch (err) {
      setActionError(err?.message || "Failed to update program status.");
    } finally {
      setTogglingId(null);
    }
  };

  const handleApprove = async (program) => {
    setApprovingId(program.id);
    setActionError(null);
    setNotice(null);
    try {
      await approveEvaluationProgram(program.id);
      setNotice(`${programLabel(program)} approved — it can now be activated.`);
      await load();
    } catch (err) {
      setActionError(err?.message || "Failed to approve program.");
    } finally {
      setApprovingId(null);
    }
  };

  const busy = togglingId !== null || approvingId !== null;

  const columns = useMemo(
    () => [
      {
        key: "plan",
        label: "Signup Plan",
        render: (row) => (
          <span>
            <span className="block font-medium text-slate-700">{planLabel(row)}</span>
            <span className="block text-xs text-slate-500">
              {row.granted_plan_code
                ? <>grants <span className="font-semibold">{row.granted_plan_code}</span> features</>
                : "grants default (Professional) features"}
            </span>
          </span>
        ),
      },
      {
        key: "status",
        label: "Status",
        render: (row) => (
          <span className="flex flex-col items-start gap-1">
            {programStatusPill(row.is_active)}
            {row.is_active && (activeByPlan[row.plan_id] || []).length > 1 && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700">
                <AlertTriangle size={11} /> Overlaps another active program
              </span>
            )}
          </span>
        ),
      },
      {
        key: "duration",
        label: "Trial Length",
        numeric: true,
        render: (row) => (
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-600">
            <Timer size={13} /> {displayValue(row.duration_days)} days
          </span>
        ),
      },
      {
        key: "payment_requirement",
        label: "Card",
        render: (row) => <PolicyText options={PAYMENT_REQUIREMENT_OPTIONS} value={row.payment_requirement} />,
      },
      {
        key: "conversion_policy",
        label: "At Trial End",
        render: (row) => (
          <span className="flex flex-col gap-0.5">
            <PolicyText options={CONVERSION_POLICY_OPTIONS} value={row.conversion_policy} />
            <PolicyText options={EXPIRY_ACTION_OPTIONS} value={row.expiry_action} />
          </span>
        ),
      },
      {
        key: "approved_by",
        label: "Approved By",
        render: (row) =>
          row.approved_by ? (
            <span className="text-xs text-slate-600">user #{row.approved_by}</span>
          ) : (
            <span className="text-xs font-medium text-amber-700">Not approved</span>
          ),
      },
      {
        key: "actions",
        label: "Actions",
        width: 220,
        render: (row) => (
          // Rows open the detail view on click; keep button clicks from
          // also triggering that.
          <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            <Button size="sm" variant="secondary" onClick={() => setDetail(row)}>
              Details
            </Button>
            {!row.is_active && row.approved_by == null ? (
              // §B3: activation needs a logged approval first. Offer the
              // approval itself rather than a dead, disabled Activate.
              <Button
                size="sm"
                variant="primary"
                icon={ShieldCheck}
                loading={approvingId === row.id}
                disabled={busy}
                onClick={() => handleApprove(row)}
                title="Record your approval (§B3) so this program can be activated"
              >
                Approve
              </Button>
            ) : (
              <Button
                size="sm"
                variant={row.is_active ? "danger" : "primary"}
                loading={togglingId === row.id}
                disabled={busy}
                onClick={() => handleToggle(row)}
                title={row.is_active ? "Stop granting this trial to new signups" : "Start granting this trial to new signups"}
              >
                {row.is_active ? "Deactivate" : "Activate"}
              </Button>
            )}
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [togglingId, approvingId, activeByPlan, busy]
  );

  const selectedPlan = plans.find((p) => String(p.id) === String(form.plan_id));

  return (
    <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
      <PageHeader
        embedded={embedded}
        accent="violet"
        title="Evaluation Programs"
        description="Custom free-trial terms for specific signup plans. A program grants trials only after it is approved and activated."
        icon={Clock}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" icon={RefreshCw} onClick={() => load()} disabled={loading}>
              Refresh
            </Button>
            <Button variant="primary" icon={Plus} onClick={openCreate}>
              Create program
            </Button>
          </div>
        }
        meta={`${displayValue(programs.length)} program(s)`}
      />

      <div className={`space-y-4 ${embedded ? "" : "mt-6"}`}>
        <SectionCard variant="quiet">
          <p className="text-xs leading-5 text-slate-600">
            Every new self-serve signup already gets the default free trial, even with no program here. Create a
            program only when a plan needs different trial terms — while active, it replaces the default for that
            plan. A program with no granted plan gives trial users the default (Professional) features. To start
            using a program: <span className="font-semibold">Approve</span> it, then{" "}
            <span className="font-semibold">Activate</span> it.
          </p>
        </SectionCard>

        {notice && <SuccessMessage message={notice} onDismiss={() => setNotice(null)} />}
        {actionError && (
          <div role="alert" className="flex items-start justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>{actionError}</span>
            <button type="button" onClick={() => setActionError(null)} className="text-xs font-semibold underline">Dismiss</button>
          </div>
        )}

        {!error && programs.length > 0 && (
          <div role="group" aria-label="Filter by program status" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {STATUS_FILTERS.map((tile) => {
              const active = statusFilter === tile.key;
              return (
                <button
                  key={tile.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setStatusFilter(tile.key)}
                  className={`rounded-2xl border p-3.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                    active ? "border-brand-500 bg-brand-50 shadow-sm" : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm"
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <span className={`h-2 w-2 rounded-full ${tile.dot}`} aria-hidden="true" />
                    <span className="truncate">{tile.label}</span>
                  </span>
                  <span className={`mt-1.5 block text-2xl font-extrabold ${active ? "text-brand-700" : "text-slate-800"}`}>
                    {counts[tile.key].toLocaleString()}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* error and the table used to render independently, so a failed
            fetch (which also clears `programs` to []) showed the error banner
            stacked directly above "No evaluation programs" — a fetch failure
            presented as an empty catalogue. They're mutually exclusive now. */}
        {error ? (
          <ErrorState message={error} onRetry={() => load()} title="Unable to load evaluation programs" />
        ) : (
          <SectionCard
            variant="hero"
            accent="violet"
            icon={Clock}
            title="Configured Trial Programs"
            description="Click a row to see its details and per-feature trial caps."
            actions={
              programs.length > 0 ? (
                <SearchInput value={search} onChange={setSearch} placeholder="Search by plan or program #…" className="w-full sm:w-64" />
              ) : null
            }
          >
            {loading && programs.length === 0 ? (
              <Spinner />
            ) : (
              <DataTable
                columns={columns}
                data={rows}
                loading={loading && programs.length === 0}
                onRowClick={setDetail}
                emptyTitle={programs.length === 0 ? "No evaluation programs" : "No programs match"}
                emptyMessage={
                  programs.length === 0
                    ? "Every signup currently gets the default free trial. Create a program to give a specific plan different trial terms."
                    : "Try a different search or status filter."
                }
                emptyAction={
                  programs.length === 0 ? (
                    <Button variant="primary" icon={Plus} onClick={openCreate}>Create program</Button>
                  ) : (
                    <Button variant="secondary" onClick={() => { setStatusFilter("all"); setSearch(""); }}>Clear filters</Button>
                  )
                }
                minWidth={960}
              />
            )}
          </SectionCard>
        )}
      </div>

      <Modal
        open={createOpen}
        onClose={closeCreate}
        title="Create evaluation program"
        description="The new program starts inactive and unapproved, so creating it does not change any trial yet."
        icon={Clock}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={closeCreate} disabled={submitting}>Cancel</Button>
            <Button type="submit" form="ep-create-form" variant="primary" icon={Plus} loading={submitting}>Create program</Button>
          </>
        }
      >
        <form id="ep-create-form" onSubmit={handleCreate} className="space-y-4" noValidate>
          {plansError && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              The plan list could not be loaded ({plansError}). Close this form and use Refresh to try again.
            </p>
          )}
          <Field label="Signup plan" htmlFor="ep-plan" required hint="New signups on this plan get the trial terms below.">
            <select
              id="ep-plan"
              value={form.plan_id}
              onChange={(e) => setForm((prev) => ({ ...prev, plan_id: e.target.value }))}
              className={FORM_CONTROL_CLASS}
            >
              <option value="">Select plan…</option>
              {plans.map((plan) => (
                // Archived plans can never receive a new subscription, so a
                // trial program on one would never apply.
                <option key={plan.id} value={plan.id} disabled={plan.status === "archived"}>
                  {plan.plan_name} ({plan.plan_code}) — {plan.status}
                </option>
              ))}
            </select>
          </Field>
          {selectedPlan && (activeByPlan[selectedPlan.id] || []).length > 0 && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              This plan already has an active program (#{activeByPlan[selectedPlan.id].map((p) => p.id).join(", #")}).
              Deactivate it before activating the new one.
            </p>
          )}
          <Field label="Features during the trial" htmlFor="ep-granted" hint="Which plan's features trial users get. Leave as default to give Professional features.">
            <select
              id="ep-granted"
              value={form.granted_plan_id}
              onChange={(e) => setForm((prev) => ({ ...prev, granted_plan_id: e.target.value }))}
              className={FORM_CONTROL_CLASS}
            >
              <option value="">Default (Professional)</option>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.plan_name} ({plan.plan_code})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Trial length (days)" htmlFor="ep-duration" required>
            <input
              id="ep-duration"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={form.duration_days}
              onChange={(e) => setForm((prev) => ({ ...prev, duration_days: e.target.value }))}
              className={FORM_CONTROL_CLASS}
            />
          </Field>
          <Field label="Card requirement" htmlFor="ep-payreq">
            <Select
              id="ep-payreq"
              value={form.payment_requirement}
              placeholder=""
              onChange={(v) => setForm((prev) => ({ ...prev, payment_requirement: v }))}
              options={PAYMENT_REQUIREMENT_OPTIONS}
            />
          </Field>
          <Field
            label="When the trial ends"
            htmlFor="ep-conv"
            hint={
              form.conversion_policy === "auto_charge_on_expiry"
                ? "Automatic charging is not implemented yet: at trial end these subscriptions are left as they are (not charged, not suspended) until handled manually."
                : undefined
            }
          >
            <Select
              id="ep-conv"
              value={form.conversion_policy}
              placeholder=""
              onChange={(v) => setForm((prev) => ({ ...prev, conversion_policy: v }))}
              options={CONVERSION_POLICY_OPTIONS}
            />
          </Field>
          <Field
            label="If the customer doesn't pay"
            htmlFor="ep-expiry"
            hint={
              form.expiry_action === "downgrade"
                ? "Automatic downgrade is not implemented yet (there is no downgrade-target plan): expired trials are left as they are until handled manually."
                : "The account gets a read-only recovery window, then is suspended."
            }
          >
            <Select
              id="ep-expiry"
              value={form.expiry_action}
              placeholder=""
              onChange={(v) => setForm((prev) => ({ ...prev, expiry_action: v }))}
              options={EXPIRY_ACTION_OPTIONS}
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
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail ? `Program #${detail.id} — ${planLabel(detail)}` : ""}
        description="Trial terms plus any per-feature caps. When a trial starts, number caps lower the granted limit and on/off caps can switch a feature off; other cap types are not applied."
        icon={ShieldCheck}
        size="lg"
      >
        {detail && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {programStatusPill(detail.is_active)}
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">Trial length: {displayValue(detail.duration_days)} days</span>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">
                Features from: {detail.granted_plan_code || "Default (Professional)"}
              </span>
            </div>
            <dl className="grid gap-x-6 gap-y-3 rounded-2xl border border-slate-200 p-4 text-xs sm:grid-cols-2">
              {[
                ["Card requirement", optionLabel(PAYMENT_REQUIREMENT_OPTIONS, detail.payment_requirement)],
                ["When the trial ends", optionLabel(CONVERSION_POLICY_OPTIONS, detail.conversion_policy)],
                ["If the customer doesn't pay", optionLabel(EXPIRY_ACTION_OPTIONS, detail.expiry_action)],
                ["Approved by", detail.approved_by ? `user #${detail.approved_by}` : "Not approved"],
                ["Created by", detail.created_by ? `user #${detail.created_by}` : "—"],
                ["Created", detail.created_at ? formatDateTime(detail.created_at) : "—"],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
                  <dd className="mt-0.5 text-sm text-slate-700">{value}</dd>
                </div>
              ))}
            </dl>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Caps ({displayValue(detail.caps?.length || 0)})</p>
              {(detail.caps || []).length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-200 px-4 py-3 text-xs text-slate-500">
                  No per-feature caps configured for this program.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-2xl border border-slate-200">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="px-3 py-2 font-semibold text-slate-500">Entitlement</th>
                        <th className="px-3 py-2 font-semibold text-slate-500">Type</th>
                        <th className="px-3 py-2 font-semibold text-slate-500">Cap Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.caps.map((cap) => (
                        <tr key={cap.id} className="border-t border-slate-100">
                          <td className="px-3 py-2 font-mono text-slate-700">{cap.entitlement_key || `definition #${cap.entitlement_definition_id}`}</td>
                          <td className="px-3 py-2 text-slate-500">{cap.value_type || "—"}</td>
                          <td className="px-3 py-2 text-slate-700">{formatCapValue(cap.cap_value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      {ConfirmationDialog}
    </div>
  );
}
