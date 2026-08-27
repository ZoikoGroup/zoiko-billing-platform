import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Clock, Plus, ShieldCheck, Timer } from "lucide-react";
import { listCommercialPlans } from "../../service/commercialService";
import {
  listEvaluationPrograms,
  createEvaluationProgram,
  setEvaluationProgramStatus,
} from "../../service/commandCenterService";
import { PageHeader, DataTable, Button, Modal, Field, Select } from "../../components/billing-ui";
import { ErrorState, Spinner } from "../../components/billing-shared";
import { displayValue } from "./constants";

const PAYMENT_REQUIREMENT_OPTIONS = [
  { value: "none", label: "None" },
  { value: "card_required_upfront", label: "Card required upfront" },
];

const CONVERSION_POLICY_OPTIONS = [
  { value: "manual", label: "Manual" },
  { value: "auto_charge_on_expiry", label: "Auto-charge on expiry" },
];

const EXPIRY_ACTION_OPTIONS = [
  { value: "suspend", label: "Suspend" },
  { value: "downgrade", label: "Downgrade" },
];

const EMPTY_FORM = {
  plan_id: "",
  granted_plan_id: "",
  duration_days: 30,
  payment_requirement: "none",
  conversion_policy: "manual",
  expiry_action: "suspend",
  approved_by: "",
};

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

export default function EvaluationProgramsPage() {
  const [programs, setPrograms] = useState([]);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const [togglingId, setTogglingId] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [programsData, plansData] = await Promise.all([
        listEvaluationPrograms(),
        listCommercialPlans({ limit: 200 }),
      ]);
      setPrograms(Array.isArray(programsData) ? programsData : []);
      setPlans(plansData.plans || []);
    } catch (err) {
      setError(err?.message || "Failed to load evaluation programs.");
      setPrograms([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = useCallback(() => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setCreateOpen(true);
  }, []);

  const handleCreate = async () => {
    if (!form.plan_id) {
      setFormError("A signup plan is required.");
      return;
    }
    if (!form.duration_days || Number(form.duration_days) <= 0) {
      setFormError("Duration must be a positive number of days.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await createEvaluationProgram({
        plan_id: Number(form.plan_id),
        granted_plan_id: form.granted_plan_id ? Number(form.granted_plan_id) : undefined,
        duration_days: Number(form.duration_days),
        payment_requirement: form.payment_requirement,
        conversion_policy: form.conversion_policy,
        expiry_action: form.expiry_action,
        approved_by: form.approved_by ? Number(form.approved_by) : undefined,
      });
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setFormError(err?.message || "Failed to create evaluation program.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (program) => {
    setTogglingId(program.id);
    try {
      await setEvaluationProgramStatus(program.id, !program.is_active);
      await load();
    } catch (err) {
      setError(err?.message || "Failed to update program status.");
    } finally {
      setTogglingId(null);
    }
  };

  const columns = useMemo(
    () => [
      {
        key: "plan",
        label: "Signup Plan",
        render: (row) => (
          <span>
            <span className="block font-medium text-slate-700">{row.plan_code || `plan #${row.plan_id}`}</span>
            <span className="block text-xs text-slate-500">
              {row.granted_plan_code
                ? <>grants <span className="font-semibold">{row.granted_plan_code}</span> bundle</>
                : "grant plan unset"}
            </span>
          </span>
        ),
      },
      {
        key: "status",
        label: "Status",
        render: (row) => programStatusPill(row.is_active),
      },
      {
        key: "duration",
        label: "Duration",
        render: (row) => (
          <span className="flex items-center gap-1.5 text-xs text-slate-600">
            <Timer size={13} /> {displayValue(row.duration_days)} days
          </span>
        ),
      },
      {
        key: "payment_requirement",
        label: "Payment Requirement",
        render: (row) => (
          <span className="text-xs text-slate-600">
            {PAYMENT_REQUIREMENT_OPTIONS.find((o) => o.value === row.payment_requirement)?.label || displayValue(row.payment_requirement)}
          </span>
        ),
      },
      {
        key: "conversion_policy",
        label: "Conversion Policy",
        render: (row) => (
          <span className="text-xs text-slate-600">
            {CONVERSION_POLICY_OPTIONS.find((o) => o.value === row.conversion_policy)?.label || displayValue(row.conversion_policy)}
          </span>
        ),
      },
      {
        key: "expiry_action",
        label: "Expiry Action",
        render: (row) => (
          <span className="text-xs text-slate-600">
            {EXPIRY_ACTION_OPTIONS.find((o) => o.value === row.expiry_action)?.label || displayValue(row.expiry_action)}
          </span>
        ),
      },
      {
        key: "approved_by",
        label: "Approved By",
        render: (row) => <span className="text-xs text-slate-600">{row.approved_by ? `user #${row.approved_by}` : "—"}</span>,
      },
      {
        key: "actions",
        label: "Actions",
        width: 220,
        render: (row) => (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => setDetail(row)}>
              Inspect
            </Button>
            <Button
              size="sm"
              variant={row.is_active ? "danger" : "primary"}
              loading={togglingId === row.id}
              onClick={() => handleToggle(row)}
              disabled={!row.is_active && row.approved_by === null}
              title={
                !row.is_active && row.approved_by === null
                  ? "Cannot activate — §B3 requires an approved_by before activation."
                  : "Toggle is_active (the explicit on/off switch)"
              }
            >
              {row.is_active ? "Deactivate" : "Activate"}
            </Button>
          </div>
        ),
      },
    ],
    [togglingId]
  );

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Evaluation Programs"
        description="ZB-COM-ENT-001 · §B3 · bounded trial configurations. A program exists only when deliberately created, and grants trials only once activated. Per-§5 the trial grants the granted_plan's entitlement bundle."
        icon={Clock}
        actions={
          <Button variant="primary" icon={Plus} onClick={openCreate}>
            Create program
          </Button>
        }
        meta={`${displayValue(programs.length)} program(s)`}
      />

      <div className="mt-6 space-y-4">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">
          No program is seeded. Creating one is a deliberate business decision, and a program with an{" "}
          <span className="font-semibold">unset grant plan</span> falls back to the §5 default (Professional bundle) at
          provision time. Activation is blocked without <span className="font-semibold">approved_by</span>.
        </div>

        {error && <ErrorState message={error} onRetry={load} title="Unable to load evaluation programs" />}

        {loading && programs.length === 0 ? (
          <Spinner />
        ) : (
          <DataTable
            columns={columns}
            data={programs}
            loading={loading}
            emptyTitle="No evaluation programs"
            emptyMessage="Create the first bounded trial program here, or manage programs from the Billing Command Center."
            emptyAction={<Button variant="primary" icon={Plus} onClick={openCreate}>Create program</Button>}
            minWidth={960}
          />
        )}
      </div>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create evaluation program"
        description="Starts inactive — creating a program does NOT by itself grant any trial. §B3 mandates an approved_by before activation."
        icon={Clock}
        size="md"
      >
        <div className="space-y-4">
          <Field label="Signup plan" htmlFor="ep-plan" required>
            <select
              id="ep-plan"
              value={form.plan_id}
              onChange={(e) => setForm((prev) => ({ ...prev, plan_id: e.target.value }))}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
            >
              <option value="">Select plan…</option>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.plan_name} ({plan.plan_code}) — {plan.status}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Granted plan (trial entitlement bundle)" htmlFor="ep-granted" hint="§5 the entitlement bundle granted during the trial — defaults to Professional if unset.">
            <select
              id="ep-granted"
              value={form.granted_plan_id}
              onChange={(e) => setForm((prev) => ({ ...prev, granted_plan_id: e.target.value }))}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
            >
              <option value="">Default (Professional)</option>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.plan_name} ({plan.plan_code})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Duration (days)" htmlFor="ep-duration" required>
            <input
              id="ep-duration"
              type="number"
              min={1}
              value={form.duration_days}
              onChange={(e) => setForm((prev) => ({ ...prev, duration_days: e.target.value }))}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
            />
          </Field>
          <Field label="Payment requirement" htmlFor="ep-payreq">
            <Select
              id="ep-payreq"
              value={form.payment_requirement}
              onChange={(v) => setForm((prev) => ({ ...prev, payment_requirement: v }))}
              options={PAYMENT_REQUIREMENT_OPTIONS}
            />
          </Field>
          <Field label="Conversion policy" htmlFor="ep-conv">
            <Select
              id="ep-conv"
              value={form.conversion_policy}
              onChange={(v) => setForm((prev) => ({ ...prev, conversion_policy: v }))}
              options={CONVERSION_POLICY_OPTIONS}
            />
          </Field>
          <Field label="Expiry action" htmlFor="ep-expiry">
            <Select
              id="ep-expiry"
              value={form.expiry_action}
              onChange={(v) => setForm((prev) => ({ ...prev, expiry_action: v }))}
              options={EXPIRY_ACTION_OPTIONS}
            />
          </Field>
          {formError && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {formError}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" icon={Plus} onClick={handleCreate} loading={submitting}>Create program</Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail ? `Program ${detail.id} — ${detail.plan_code}` : ""}
        description="Per-entitlement caps (§5) plus the granted-plan bundle source. Caps rows exist as configuration; enforcement is a Part 2 concern."
        icon={ShieldCheck}
        size="lg"
      >
        {detail && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {programStatusPill(detail.is_active)}
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">Duration: {detail.duration_days} days</span>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">
                Granted plan: {detail.granted_plan_code || "Default (Professional)"}
              </span>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">Approved by: {detail.approved_by ? `user #${detail.approved_by}` : "—"}</span>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Caps ({displayValue(detail.caps?.length || 0)})</p>
              {(detail.caps || []).length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-200 px-4 py-3 text-xs text-slate-500">
                  No per-entitlement caps configured for this program.
                </p>
              ) : (
                <div className="overflow-hidden rounded-2xl border border-slate-200">
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
                          <td className="px-3 py-2 font-mono text-slate-700">{cap.entitlement_key}</td>
                          <td className="px-3 py-2 text-slate-500">{cap.value_type || "—"}</td>
                          <td className="px-3 py-2 text-slate-700">{cap.cap_value === null || cap.cap_value === undefined ? "—" : displayValue(cap.cap_value)}</td>
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
    </div>
  );
}