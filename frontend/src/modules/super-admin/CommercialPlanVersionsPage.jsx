import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, GitBranch, Plus, Send, Check, X, Archive, KeyRound, Pencil } from "lucide-react";
import {
  getCommercialPlan,
  listCommercialPlanVersions,
  createCommercialPlanVersion,
  updateCommercialPlanVersion,
  submitCommercialPlanVersion,
  approveCommercialPlanVersion,
  rejectCommercialPlanVersion,
  archiveCommercialPlanVersion,
  listEntitlementDefinitions,
  listPlanVersionEntitlements,
  setCommercialPlanVersionEntitlement,
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
import { ErrorState, Spinner, SuccessMessage, StatusBadge, useConfirmationDialog } from "../../components/billing-shared";
import {
  BILLING_INTERVAL_OPTIONS,
  CATALOG_VERSION_STATUS_OPTIONS,
  EntitlementRiskBadge,
  formatDateOnly,
  formatDateTime,
  displayValue,
} from "./constants";

const HUB_NAME = "Products & Pricing";
const PLANS_PATH = "/super-admin/commercial/plans";
const SUCCESS_DISMISS_MS = 6000;

const MATRIX_INPUT_CLASS =
  "w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100";

function parseEntitlementValue(raw, valueType) {
  if (raw === "" || raw === null || raw === undefined) return null;
  if (valueType === "boolean") return raw === "true";
  if (valueType === "integer") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (valueType === "set") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return raw;
}

// Stored value -> the string the matrix input edits.
function toEditableValue(value, valueType) {
  if (value === null || value === undefined) return "";
  if (valueType === "set" && Array.isArray(value)) return value.join(", ");
  return String(value);
}

function EntitlementMatrixModal({ open, onClose, version, onSaved }) {
  const [definitions, setDefinitions] = useState([]);
  const [values, setValues] = useState({}); // definition_id -> raw editable value
  const [stored, setStored] = useState({}); // definition_id -> editable form of the server's value
  const [saving, setSaving] = useState({}); // definition_id -> bool
  const [justSaved, setJustSaved] = useState({}); // definition_id -> bool
  const [closing, setClosing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!open || !version) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setFilter("");
    Promise.all([listEntitlementDefinitions(), listPlanVersionEntitlements(version.id)])
      .then(([defData, entData]) => {
        if (!alive) return;
        const defs = defData.definitions || [];
        setDefinitions(defs);
        const byDefId = {};
        for (const ent of entData.entitlements || []) {
          byDefId[ent.entitlement_definition_id] = ent.value;
        }
        const initial = {};
        for (const def of defs) initial[def.id] = toEditableValue(byDefId[def.id], def.value_type);
        setValues(initial);
        setStored(initial);
        setJustSaved({});
      })
      .catch((err) => alive && setError(err?.message || "Failed to load entitlements for this version."))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, version]);

  const isDirty = (def) => (values[def.id] ?? "") !== (stored[def.id] ?? "");
  const dirtyDefinitions = definitions.filter(isDirty);
  const needle = filter.trim().toLowerCase();
  const visibleDefinitions = needle
    ? definitions.filter((def) => def.key.toLowerCase().includes(needle) || (def.description || "").toLowerCase().includes(needle))
    : definitions;

  // Returns true when the row is now stored server-side.
  async function handleSave(definition) {
    const raw = values[definition.id];
    // A non-numeric limit used to be sent as null — stored as "unset" while
    // the operator thought they had saved a number.
    if (definition.value_type === "integer" && raw !== "" && raw != null && !Number.isFinite(Number(raw))) {
      setError(`${definition.key} needs a whole number (or leave it empty to unset it).`);
      return false;
    }
    setSaving((s) => ({ ...s, [definition.id]: true }));
    setError(null);
    try {
      const parsed = parseEntitlementValue(raw, definition.value_type);
      const saved = await setCommercialPlanVersionEntitlement(version.id, definition.id, parsed);
      // Show what the server actually stored, so the row never claims a
      // value it lacks.
      const editable = toEditableValue(saved?.value ?? parsed, definition.value_type);
      setValues((s) => ({ ...s, [definition.id]: editable }));
      setStored((s) => ({ ...s, [definition.id]: editable }));
      setJustSaved((s) => ({ ...s, [definition.id]: true }));
      onSaved?.();
      return true;
    } catch (err) {
      setError(err?.message || `Failed to save ${definition.key}.`);
      return false;
    } finally {
      setSaving((s) => ({ ...s, [definition.id]: false }));
    }
  }

  // Done never discards edits: unsaved rows are saved first, and the modal
  // stays open (showing the error) if any of them fails.
  async function handleDone() {
    if (dirtyDefinitions.length === 0) {
      onClose();
      return;
    }
    setClosing(true);
    let allSaved = true;
    for (const def of dirtyDefinitions) {
      // Sequential: each save is audited, and a failure should stop the batch
      // with the remaining edits still visible.
      if (!(await handleSave(def))) {
        allSaved = false;
        break;
      }
    }
    setClosing(false);
    if (allSaved) onClose();
  }

  const setRowValue = (defId, value) => {
    setValues((s) => ({ ...s, [defId]: value }));
    setJustSaved((s) => ({ ...s, [defId]: false }));
  };

  return (
    <Modal
      open={open}
      onClose={closing ? () => {} : onClose}
      title={`Edit entitlements — v${version?.version_number ?? ""}`}
      description="What this draft grants once published. Leave a value empty to leave it unset."
      icon={KeyRound}
      size="xl"
    >
      {loading ? (
        <Spinner />
      ) : error && definitions.length === 0 ? (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
      ) : (
        <div className="space-y-3">
          {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
          {definitions.length > 8 && (
            <SearchInput value={filter} onChange={setFilter} debounceMs={0} placeholder="Filter entitlement keys" className="sm:max-w-xs" />
          )}
          <div className="max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                  <th className="py-2 pr-3">Key</th>
                  <th className="py-2 pr-3">Risk</th>
                  <th className="py-2 pr-3">Value</th>
                  <th className="py-2 pr-3 text-right">Save</th>
                </tr>
              </thead>
              <tbody>
                {visibleDefinitions.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-xs text-slate-500">
                      {definitions.length === 0 ? "No entitlement keys are defined yet." : "No keys match this filter."}
                    </td>
                  </tr>
                )}
                {visibleDefinitions.map((def) => (
                  <tr key={def.id} className="border-b border-slate-100">
                    <td className="py-2 pr-3">
                      <span className="font-mono text-xs font-semibold text-slate-800">{def.key}</span>
                      {def.description && <span className="block text-xs text-slate-500">{def.description}</span>}
                    </td>
                    <td className="py-2 pr-3"><EntitlementRiskBadge value={def.risk_classification} /></td>
                    <td className="py-2 pr-3">
                      {def.value_type === "boolean" ? (
                        <Select
                          value={values[def.id] === "" ? "" : String(values[def.id])}
                          onChange={(v) => setRowValue(def.id, v)}
                          options={[{ value: "true", label: "Enabled" }, { value: "false", label: "Disabled" }]}
                          placeholder="Unset"
                          aria-label={`Value for ${def.key}`}
                        />
                      ) : (
                        <input
                          value={values[def.id] ?? ""}
                          onChange={(e) => setRowValue(def.id, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && isDirty(def)) {
                              e.preventDefault();
                              handleSave(def);
                            }
                          }}
                          inputMode={def.value_type === "integer" ? "numeric" : undefined}
                          placeholder={def.value_type === "set" ? "comma-separated" : def.value_type}
                          aria-label={`Value for ${def.key}`}
                          className={MATRIX_INPUT_CLASS}
                        />
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      {justSaved[def.id] && !isDirty(def) ? (
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                          <Check size={13} /> Saved
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant={isDirty(def) ? "primary" : "secondary"}
                          loading={Boolean(saving[def.id])}
                          disabled={!isDirty(def) || closing}
                          onClick={() => handleSave(def)}
                        >
                          Save
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-end gap-3">
            {dirtyDefinitions.length > 0 && (
              <span className="text-xs text-amber-700">
                {dirtyDefinitions.length} unsaved change{dirtyDefinitions.length === 1 ? "" : "s"}
              </span>
            )}
            <Button variant="primary" loading={closing} onClick={handleDone}>
              {dirtyDefinitions.length > 0 ? `Save ${dirtyDefinitions.length} & close` : "Done"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

const EMPTY_DRAFT = {
  plan_name: "",
  description: "",
  billing_interval: "",
  currency: "",
  price_amount: "",
  effective_from: "",
  effective_to: "",
  max_users: "",
  max_storage_gb: "",
};

const str = (v) => (v === null || v === undefined ? "" : String(v));

function draftFormFrom(source, fallbackName) {
  if (!source) return { ...EMPTY_DRAFT, plan_name: fallbackName || "" };
  return {
    plan_name: source.plan_name || fallbackName || "",
    description: str(source.description),
    billing_interval: str(source.billing_interval),
    currency: str(source.currency),
    price_amount: str(source.price_amount),
    effective_from: str(source.effective_from),
    effective_to: str(source.effective_to),
    max_users: str(source.max_users),
    max_storage_gb: str(source.max_storage_gb),
  };
}

function buildDraftPayload(form) {
  const num = (v) => (v === "" ? null : Number(v));
  const payload = {
    plan_name: form.plan_name.trim(),
    description: form.description.trim() || null,
    billing_interval: form.billing_interval || null,
    currency: form.currency.trim().toUpperCase() || null,
    price_amount: num(form.price_amount),
    effective_from: form.effective_from || null,
    effective_to: form.effective_to || null,
    max_users: num(form.max_users),
    max_storage_gb: num(form.max_storage_gb),
  };
  if (!payload.plan_name) return { error: "Plan name is required." };
  if (payload.currency && !/^[A-Z]{3}$/.test(payload.currency)) return { error: "Currency must be a 3-letter ISO code, e.g. USD." };
  if (payload.price_amount !== null && !(Number.isFinite(payload.price_amount) && payload.price_amount >= 0)) {
    return { error: "Price must be a number of 0 or more." };
  }
  if (payload.max_users !== null && !(Number.isInteger(payload.max_users) && payload.max_users >= 0)) {
    return { error: "Max users must be a whole number of 0 or more." };
  }
  if (payload.max_storage_gb !== null && !(Number.isInteger(payload.max_storage_gb) && payload.max_storage_gb >= 0)) {
    return { error: "Max storage must be a whole number of 0 or more." };
  }
  if (payload.effective_from && payload.effective_to && payload.effective_to < payload.effective_from) {
    return { error: "“Effective to” must be on or after “Effective from”." };
  }
  return { payload };
}

// Create a new draft (prefilled from `source`, the newest version, so a
// correction only touches what changes) or edit an existing DRAFT's fields.
function DraftModal({ open, onClose, mode, source, sourceLabel, planName, onSubmit }) {
  const [form, setForm] = useState(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setForm(draftFormFrom(source, planName));
      setError(null);
      setBusy(false);
    }
  }, [open, source, planName]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const editing = mode === "edit";

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    const { payload, error: validationError } = buildDraftPayload(form);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(payload);
      onClose();
    } catch (err) {
      setError(err?.message || (editing ? "Failed to save the draft." : "Failed to create the draft version."));
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={editing ? `Edit draft v${source?.version_number ?? ""}` : "Draft a new catalog version"}
      description={
        editing
          ? "Drafts stay editable until they're submitted for approval."
          : sourceLabel
            ? `Pre-filled from ${sourceLabel} — change only what's different. Nothing goes live until another admin approves it.`
            : "Nothing goes live until another admin approves it. Leave pricing and limits blank until an approved catalogue supplies them."
      }
      icon={editing ? Pencil : GitBranch}
      size="lg"
    >
      <form noValidate onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Plan name" htmlFor="cv-name" required className="sm:col-span-2">
          <input id="cv-name" value={form.plan_name} onChange={set("plan_name")} maxLength={200} className={FORM_CONTROL_CLASS} />
        </Field>
        <Field label="Description" htmlFor="cv-desc" className="sm:col-span-2">
          <textarea id="cv-desc" rows={2} value={form.description} onChange={set("description")} className={FORM_CONTROL_CLASS} />
        </Field>
        <Field label="Billing interval" htmlFor="cv-interval">
          <Select
            id="cv-interval"
            value={form.billing_interval}
            onChange={(v) => setForm((f) => ({ ...f, billing_interval: v }))}
            options={BILLING_INTERVAL_OPTIONS}
            placeholder="Not set"
          />
        </Field>
        <Field label="Currency" htmlFor="cv-currency" hint="3-letter ISO code, e.g. USD">
          <input id="cv-currency" maxLength={3} value={form.currency} onChange={set("currency")} placeholder="USD" className={`${FORM_CONTROL_CLASS} uppercase`} />
        </Field>
        <Field label="Price" htmlFor="cv-price" hint="Leave blank until an approved catalogue supplies a price.">
          <input id="cv-price" type="number" min="0" step="0.01" value={form.price_amount} onChange={set("price_amount")} className={FORM_CONTROL_CLASS} />
        </Field>
        <div className="hidden sm:block" aria-hidden="true" />
        <Field label="Max users" htmlFor="cv-users" hint="Blank means not set.">
          <input id="cv-users" type="number" min="0" step="1" value={form.max_users} onChange={set("max_users")} className={FORM_CONTROL_CLASS} />
        </Field>
        <Field label="Max storage (GB)" htmlFor="cv-storage" hint="Blank means not set.">
          <input id="cv-storage" type="number" min="0" step="1" value={form.max_storage_gb} onChange={set("max_storage_gb")} className={FORM_CONTROL_CLASS} />
        </Field>
        <Field label="Effective from" htmlFor="cv-from">
          <input id="cv-from" type="date" value={form.effective_from} onChange={set("effective_from")} className={FORM_CONTROL_CLASS} />
        </Field>
        <Field label="Effective to" htmlFor="cv-to">
          <input id="cv-to" type="date" value={form.effective_to} min={form.effective_from || undefined} onChange={set("effective_to")} className={FORM_CONTROL_CLASS} />
        </Field>
        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 sm:col-span-2">{error}</p>
        )}
        <div className="flex items-center justify-end gap-2 sm:col-span-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>{editing ? "Save draft" : "Create draft"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// Shared by Submit and Reject: a required free-text reason, the error shown
// in place, and the dialog kept open until the action succeeds.
function ReasonModal({ open, onClose, title, icon, label, hint, confirmLabel, tone = "primary", fallbackError, onSubmit }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) { setReason(""); setError(null); setBusy(false); }
  }, [open]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy || !reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason.trim());
      onClose();
    } catch (err) {
      setError(err?.message || fallbackError);
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title={title} icon={icon} size="sm" tone={tone === "danger" ? "danger" : "default"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label={label} htmlFor="version-reason" required hint={hint}>
          <textarea
            id="version-reason"
            required
            rows={3}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit(e);
            }}
            className={FORM_CONTROL_CLASS}
          />
        </Field>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant={tone} loading={busy} disabled={!reason.trim()}>{confirmLabel}</Button>
        </div>
      </form>
    </Modal>
  );
}

const STATUS_ORDER = ["draft", "pending_approval", "published", "rejected", "archived"];

function formatVersionPrice(row) {
  if (row.price_amount === null || row.price_amount === undefined) return null;
  const n = Number(row.price_amount);
  const amount = Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(row.price_amount);
  return `${row.currency ? `${row.currency} ` : ""}${amount}`;
}

export default function CommercialPlanVersionsPage() {
  const { planId } = useParams();
  const navigate = useNavigate();
  const [plan, setPlan] = useState(null);
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Mutation failures stay separate from load failures: they keep the table
  // visible and are dismissed rather than "retried" by re-fetching the list.
  const [actionError, setActionError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [draftModal, setDraftModal] = useState(null); // { mode: "create" | "edit", version? }
  const [submitTarget, setSubmitTarget] = useState(null);
  const [rejectTarget, setRejectTarget] = useState(null);
  const [matrixTarget, setMatrixTarget] = useState(null);
  const { confirm, ConfirmationDialog } = useConfirmationDialog();
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, v] = await Promise.all([
        getCommercialPlan(planId),
        listCommercialPlanVersions(planId),
      ]);
      setPlan(p);
      setVersions(v?.versions || []);
      loadedOnce.current = true;
    } catch (err) {
      setError(err?.message || "Failed to load catalog versions.");
    } finally {
      setLoading(false);
    }
  }, [planId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!success) return undefined;
    const t = setTimeout(() => setSuccess(null), SUCCESS_DISMISS_MS);
    return () => clearTimeout(t);
  }, [success]);

  const runAction = useCallback(
    async (version, action, successMessage, failureMessage) => {
      setBusyId(version.id);
      setActionError(null);
      try {
        await action();
        setSuccess(successMessage);
        await load();
      } catch (err) {
        setActionError(err?.message || failureMessage);
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const handleApprove = useCallback(
    async (version) => {
      const ok = await confirm({
        title: `Approve and publish v${version.version_number}?`,
        message:
          "This makes the version live and it can never be edited again. You can't approve a version you submitted yourself — another admin has to.",
        confirmLabel: "Approve & publish",
        tone: "primary",
      });
      if (!ok) return;
      await runAction(version, () => approveCommercialPlanVersion(version.id), `Version ${version.version_number} published.`, "Failed to approve/publish.");
    },
    [confirm, runAction]
  );

  const handleArchive = useCallback(
    async (version) => {
      const ok = await confirm({
        title: `Archive v${version.version_number}?`,
        message: "Archiving retires this version from new subscriptions. Existing subscriptions keep referencing it — history is preserved.",
        confirmLabel: "Archive version",
        tone: "danger",
      });
      if (!ok) return;
      await runAction(version, () => archiveCommercialPlanVersion(version.id), `Version ${version.version_number} archived.`, "Failed to archive.");
    },
    [confirm, runAction]
  );

  const counts = useMemo(() => {
    const c = {};
    for (const v of versions) c[v.status] = (c[v.status] || 0) + 1;
    return c;
  }, [versions]);
  // The backend lists newest first (version_number desc).
  const latest = versions[0] || null;
  const live = versions.find((v) => v.status === "published") || null;

  const columns = useMemo(
    () => [
      {
        key: "version",
        label: "Version",
        width: 110,
        render: (row) => (
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-sm font-semibold text-slate-700">v{row.version_number}</span>
            {live && row.id === live.id && (
              <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">Live</span>
            )}
          </span>
        ),
      },
      { key: "status", label: "Status", render: (row) => <StatusBadge status={row.status} options={CATALOG_VERSION_STATUS_OPTIONS} /> },
      {
        key: "price",
        label: "Price",
        render: (row) => {
          const price = formatVersionPrice(row);
          const interval = BILLING_INTERVAL_OPTIONS.find((o) => o.value === row.billing_interval)?.label;
          return price ? (
            <span className="text-xs text-slate-700">
              <span className="font-semibold">{price}</span>
              {interval && <span className="text-slate-500"> / {interval.toLowerCase()}</span>}
            </span>
          ) : (
            <span className="text-xs text-slate-400">Not set</span>
          );
        },
      },
      {
        key: "limits",
        label: "Limits",
        render: (row) => (
          <span className="text-xs text-slate-600">
            {row.max_users == null ? "No user limit" : `${displayValue(row.max_users)} users`} ·{" "}
            {row.max_storage_gb == null ? "no storage limit" : `${displayValue(row.max_storage_gb)} GB`}
          </span>
        ),
      },
      {
        key: "effective",
        label: "Effective",
        render: (row) => (
          <span className="text-xs text-slate-500">
            {row.effective_from || row.effective_to
              ? `${row.effective_from ? formatDateOnly(row.effective_from) : "Any time"} — ${row.effective_to ? formatDateOnly(row.effective_to) : "open-ended"}`
              : "Always"}
          </span>
        ),
      },
      { key: "published_at", label: "Published", render: (row) => <span className="text-xs text-slate-500">{row.published_at ? formatDateTime(row.published_at) : "—"}</span> },
      {
        key: "actions",
        label: "Actions",
        width: 320,
        render: (row) => {
          const busy = busyId === row.id;
          const disabled = busyId !== null;
          if (row.status === "draft") {
            return (
              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="sm" variant="secondary" icon={Pencil} disabled={disabled} onClick={() => setDraftModal({ mode: "edit", version: row })} aria-label={`Edit details of v${row.version_number}`}>Edit details</Button>
                <Button size="sm" variant="secondary" icon={KeyRound} disabled={disabled} onClick={() => setMatrixTarget(row)}>Edit entitlements</Button>
                <Button size="sm" variant="primary" icon={Send} disabled={disabled} onClick={() => setSubmitTarget(row)} aria-label={`Submit v${row.version_number} for approval`}>Submit</Button>
              </div>
            );
          }
          if (row.status === "pending_approval") {
            return (
              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="sm" variant="primary" icon={Check} loading={busy} disabled={disabled} onClick={() => handleApprove(row)} aria-label={`Approve v${row.version_number}`}>Approve</Button>
                <Button size="sm" variant="danger" icon={X} disabled={disabled} onClick={() => setRejectTarget(row)} aria-label={`Reject v${row.version_number}`}>Reject</Button>
              </div>
            );
          }
          if (row.status === "published") {
            return <Button size="sm" variant="danger" icon={Archive} loading={busy} disabled={disabled} onClick={() => handleArchive(row)} aria-label={`Archive v${row.version_number}`}>Archive</Button>;
          }
          return <span className="text-xs text-slate-400">No actions — {row.status === "rejected" ? "rejected versions are final" : "kept for history"}</span>;
        },
      },
    ],
    [busyId, handleApprove, handleArchive, live]
  );

  const backButton = (
    <Button variant="secondary" icon={ArrowLeft} onClick={() => navigate(PLANS_PATH)}>
      Back to plans
    </Button>
  );

  // Full-page spinner only for the first load. Reloads after an action keep
  // the page (and any open dialog) mounted instead of flashing a spinner.
  if (loading && !loadedOnce.current) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <PageHeader crumbs={[{ label: HUB_NAME }, { label: "Catalog Versions" }]} title="Catalog Versions" icon={GitBranch} accent="violet" actions={backButton} />
        <div className="mt-6"><Spinner /></div>
      </div>
    );
  }

  if (error && !plan) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <PageHeader crumbs={[{ label: HUB_NAME }, { label: "Catalog Versions" }]} title="Catalog Versions" icon={GitBranch} accent="violet" actions={backButton} />
        <div className="mt-6 rounded-3xl border border-slate-200 bg-white">
          <ErrorState message={error} onRetry={() => load()} title="Unable to load catalog versions" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        crumbs={[{ label: HUB_NAME }, { label: "Plans" }, { label: plan?.plan_code || "Plan" }]}
        title={`Catalog Versions — ${plan?.plan_name || plan?.plan_code || ""}`}
        description="Price and limit changes are published as new versions: draft it, submit it, and a second admin approves it. Published versions never change — history is never overwritten."
        icon={GitBranch}
        accent="violet"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {backButton}
            <Button variant="primary" icon={Plus} onClick={() => setDraftModal({ mode: "create" })}>New draft</Button>
          </div>
        }
        meta={`${versions.length} version(s)${live ? ` · v${live.version_number} is live` : " · none published yet"}`}
      />

      <div className="mt-6 space-y-4">
        {versions.length > 0 && (
          <div className="flex flex-wrap gap-2" aria-label="Versions by status">
            {STATUS_ORDER.filter((s) => counts[s]).map((s) => (
              <span key={s} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                <StatusBadge status={s} options={CATALOG_VERSION_STATUS_OPTIONS} />
                <span className="font-bold text-slate-800">{counts[s]}</span>
              </span>
            ))}
          </div>
        )}

        {success && <SuccessMessage message={success} onDismiss={() => setSuccess(null)} />}
        {actionError && (
          <div className="flex items-start justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
            <span>{actionError}</span>
            <button type="button" onClick={() => setActionError(null)} className="shrink-0 font-semibold underline">Dismiss</button>
          </div>
        )}
        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
            {error}
            <button type="button" onClick={() => load()} className="ml-3 font-semibold underline">Retry</button>
          </div>
        )}

        <SectionCard
          variant="standard"
          accent="violet"
          icon={GitBranch}
          title="Version history"
          description="Draft → Submit for approval → Approved by a different admin → Published (live). Newest first."
        >
          <DataTable
            columns={columns}
            data={versions}
            loading={loading}
            loadingRows={3}
            rowKey={(row) => row.id}
            emptyTitle="No catalog versions yet"
            emptyMessage="Create the first draft to start versioning this plan's catalog."
            emptyAction={<Button variant="primary" icon={Plus} onClick={() => setDraftModal({ mode: "create" })}>Create first draft</Button>}
            minWidth={1040}
          />
        </SectionCard>
      </div>

      <DraftModal
        open={Boolean(draftModal)}
        mode={draftModal?.mode}
        source={draftModal?.mode === "edit" ? draftModal.version : latest || plan}
        sourceLabel={draftModal?.mode === "edit" ? null : latest ? `v${latest.version_number}` : plan ? "the plan template" : null}
        planName={plan?.plan_name}
        onClose={() => setDraftModal(null)}
        onSubmit={async (payload) => {
          if (draftModal?.mode === "edit") {
            await updateCommercialPlanVersion(draftModal.version.id, payload);
            setSuccess(`Draft v${draftModal.version.version_number} saved.`);
          } else {
            const version = await createCommercialPlanVersion(planId, payload);
            setSuccess(version?.version_number ? `Draft version ${version.version_number} created.` : "Draft version created.");
          }
          load();
        }}
      />
      <ReasonModal
        open={Boolean(submitTarget)}
        onClose={() => setSubmitTarget(null)}
        title={`Submit v${submitTarget?.version_number ?? ""} for approval`}
        icon={Send}
        label="Reason"
        hint="Shown to the approving admin. After submitting, the draft can no longer be edited."
        confirmLabel="Submit"
        fallbackError="Failed to submit for approval."
        onSubmit={async (reason) => {
          await submitCommercialPlanVersion(submitTarget.id, reason);
          setSuccess(`Version ${submitTarget.version_number} submitted for approval.`);
          load();
        }}
      />
      <ReasonModal
        open={Boolean(rejectTarget)}
        onClose={() => setRejectTarget(null)}
        title={`Reject v${rejectTarget?.version_number ?? ""}`}
        icon={X}
        label="Rejection reason"
        hint="Rejected versions are final. To try again, create a new draft."
        confirmLabel="Reject"
        tone="danger"
        fallbackError="Failed to reject."
        onSubmit={async (reason) => {
          await rejectCommercialPlanVersion(rejectTarget.id, reason);
          setSuccess(`Version ${rejectTarget.version_number} rejected.`);
          load();
        }}
      />
      <EntitlementMatrixModal
        open={Boolean(matrixTarget)}
        version={matrixTarget}
        onClose={() => setMatrixTarget(null)}
        onSaved={() => setSuccess(`Entitlements updated for v${matrixTarget?.version_number}.`)}
      />
      {ConfirmationDialog}
    </div>
  );
}
