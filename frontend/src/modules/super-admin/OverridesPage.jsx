import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldAlert, Plus, Send, Check, X, Undo2, ShieldOff, CornerUpLeft, AlertTriangle, Clock, ShieldCheck, FileEdit } from "lucide-react";
import {
  listCommercialOverrides,
  createCommercialOverride,
  submitCommercialOverride,
  approveCommercialOverride,
  rejectCommercialOverride,
  revokeCommercialOverride,
  withdrawCommercialOverride,
  listEntitlementDefinitions,
  listOrganizations,
} from "../../service/commercialService";
import { PageHeader, SectionCard, DataTable, Button, Modal, Field, Select, SearchInput, FORM_CONTROL_CLASS } from "../../components/billing-ui";
import { Spinner, SuccessMessage, StatusBadge, ErrorState, useConfirmationDialog } from "../../components/billing-shared";
import { useAuth } from "../../context/AuthContext";
import {
  OVERRIDE_STATUS_OPTIONS,
  EntitlementRiskBadge,
  formatEntitlementValue,
  formatDateTime,
  displayValue,
} from "./constants";

// expires_at is stored as naive UTC and serialized without an offset; a bare
// "2026-11-05T00:00:00" would otherwise be parsed as local time.
function parseServerDate(value) {
  if (!value) return null;
  const text = String(value);
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(text);
  const d = new Date(text.includes("T") && !hasZone ? `${text}Z` : text);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Expiry is picked as a date and sent as that day's local midnight; show just
// the date then, instead of a misleading "12:00 am".
function formatExpiry(value) {
  const d = parseServerDate(value);
  if (!d) return "—";
  return d.getHours() === 0 && d.getMinutes() === 0
    ? d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })
    : formatDateTime(d);
}

const isPastExpiry = (row) => {
  const d = parseServerDate(row.expires_at);
  return Boolean(d) && d.getTime() <= Date.now();
};

function localDateInput(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// A null INTEGER value resolves as "no limit" (assert_within_limit).
function formatOverrideValue(value, valueType) {
  if (valueType === "integer" && (value === null || value === undefined)) return "No limit";
  return formatEntitlementValue(value, valueType);
}

// The form keeps every value as the raw string the control holds and converts
// once on submit. Returns { value } or { error }.
function parseValueForType(raw, valueType) {
  const text = raw === null || raw === undefined ? "" : String(raw).trim();
  if (valueType === "integer") {
    if (text === "") return { value: null };
    const n = Number(text);
    if (!Number.isInteger(n) || n < 0) return { error: "Enter a whole number of 0 or more, or leave blank for no limit." };
    return { value: n };
  }
  if (valueType === "boolean") {
    if (text !== "true" && text !== "false") return { error: "Choose Enabled or Disabled." };
    return { value: text === "true" };
  }
  if (text === "") return { error: "Enter a value for this override." };
  if (valueType === "set") {
    const items = text.split(",").map((s) => s.trim()).filter(Boolean);
    return items.length ? { value: items } : { error: "Enter at least one value." };
  }
  return { value: text }; // enum — plain string
}

function ValueInput({ id, definition, value, onChange, invalid }) {
  if (!definition) {
    return <input id={id} disabled placeholder="Select an entitlement key first" className={FORM_CONTROL_CLASS} />;
  }
  if (definition.value_type === "boolean") {
    return (
      <Select
        id={id}
        value={value}
        onChange={onChange}
        options={[
          { value: "true", label: "Enabled" },
          { value: "false", label: "Disabled" },
        ]}
        placeholder="Select a value…"
        aria-invalid={invalid || undefined}
      />
    );
  }
  if (definition.value_type === "integer") {
    return (
      <input
        id={id}
        type="number"
        min={0}
        step={1}
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Blank = no limit"
        aria-invalid={invalid || undefined}
        className={FORM_CONTROL_CLASS}
      />
    );
  }
  return (
    <input
      id={id}
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={definition.value_type === "set" ? "Comma-separated, e.g. flat, tiered, volume" : "Value"}
      aria-invalid={invalid || undefined}
      className={FORM_CONTROL_CLASS}
    />
  );
}

const VALUE_HINTS = {
  boolean: "Turns the feature on or off for this organization.",
  integer: "A whole-number limit. Leave blank for no limit.",
  set: "A list of allowed values, separated by commas.",
  enum: "A single allowed value.",
};

function CreateDraftModal({ open, onClose, organizations, definitions, onCreated }) {
  const [orgId, setOrgId] = useState("");
  const [definitionId, setDefinitionId] = useState("");
  const [rawValue, setRawValue] = useState("");
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  useEffect(() => {
    if (open) {
      setOrgId("");
      setDefinitionId("");
      setRawValue("");
      setReason("");
      setExpiresAt("");
      setError(null);
      setFieldErrors({});
    }
  }, [open]);

  const definition = useMemo(
    () => definitions.find((d) => String(d.id) === String(definitionId)) || null,
    [definitions, definitionId]
  );

  const orgOptions = useMemo(
    () => organizations.map((o) => ({ value: String(o.id), label: `${o.organization_name} (${o.organization_code})` })),
    [organizations]
  );
  const definitionOptions = useMemo(
    () =>
      definitions.map((d) => ({
        value: String(d.id),
        label: d.risk_classification === "high_risk" ? `${d.key} (high risk)` : d.key,
      })),
    [definitions]
  );

  // A value typed for one key must not be carried over to a key of another
  // type (an integer "5" would otherwise be sent as a boolean).
  const changeDefinition = (next) => {
    setDefinitionId(next);
    setRawValue("");
    setFieldErrors((prev) => ({ ...prev, value: undefined }));
  };

  const handleClose = () => {
    if (!busy) onClose();
  };

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    const errors = {};
    if (!orgId) errors.org = "Choose an organization.";
    if (!definitionId) errors.definition = "Choose an entitlement key.";
    if (!reason.trim()) errors.reason = "Explain why this organization needs a different value.";
    let parsed = { value: null };
    if (definition) {
      parsed = parseValueForType(rawValue, definition.value_type);
      if (parsed.error) errors.value = parsed.error;
    }
    if (expiresAt && expiresAt < localDateInput(1)) errors.expires = "Pick a date from tomorrow onwards.";
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;

    setBusy(true);
    setError(null);
    try {
      const override = await onCreated({
        organization_id: Number(orgId),
        entitlement_definition_id: Number(definitionId),
        value: parsed.value,
        reason: reason.trim(),
        // Local midnight of the chosen day, not UTC midnight.
        expires_at: expiresAt ? new Date(`${expiresAt}T00:00:00`).toISOString() : null,
      });
      if (override) onClose();
    } catch (err) {
      setError(err?.message || "Failed to create the override draft.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="New entitlement override"
      description="Give one organization a different value for one entitlement. It starts as a draft; submit it, then a different Super Admin approves it."
      icon={ShieldAlert}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="draft-override-form" variant="primary" loading={busy} disabled={busy}>
            Create draft
          </Button>
        </>
      }
    >
      <form id="draft-override-form" onSubmit={handleSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
        <Field label="Organization" htmlFor="ov-org" required error={fieldErrors.org} className="sm:col-span-2">
          <Select id="ov-org" value={orgId} onChange={setOrgId} options={orgOptions} placeholder="Select an organization…" />
        </Field>
        <Field label="Entitlement key" htmlFor="ov-def" required error={fieldErrors.definition} className="sm:col-span-2">
          <Select id="ov-def" value={definitionId} onChange={changeDefinition} options={definitionOptions} placeholder="Select an entitlement key…" />
        </Field>
        {definition?.description && (
          <p className="-mt-2 text-xs text-slate-500 sm:col-span-2">{definition.description}</p>
        )}
        {definition?.risk_classification === "high_risk" && (
          <p className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 sm:col-span-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            High-risk key (identity / security-adjacent). Double-check the organization and value before submitting.
          </p>
        )}
        <Field
          label="Override value"
          htmlFor="ov-value"
          required={Boolean(definition) && definition.value_type !== "integer"}
          error={fieldErrors.value}
          hint={definition ? VALUE_HINTS[definition.value_type] : undefined}
          className="sm:col-span-2"
        >
          <ValueInput id="ov-value" definition={definition} value={rawValue} onChange={setRawValue} invalid={Boolean(fieldErrors.value)} />
        </Field>
        <Field label="Expires on" htmlFor="ov-expires" error={fieldErrors.expires} hint="Leave blank for a permanent override.">
          <input id="ov-expires" type="date" min={localDateInput(1)} value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className={FORM_CONTROL_CLASS} />
        </Field>
        <Field label="Reason" htmlFor="ov-reason" required error={fieldErrors.reason} hint="Why this organization needs a non-standard value.">
          <textarea id="ov-reason" rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} className={FORM_CONTROL_CLASS} />
        </Field>
        {error && (
          <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 sm:col-span-2">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

function ReasonModal({ open, onClose, title, description, icon, submitLabel, submitVariant = "primary", tone, maxLength = 1000, onSubmit }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) { setReason(""); setError(null); }
  }, [open]);

  const handleClose = () => {
    if (!busy) onClose();
  };

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy || !reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason.trim());
      onClose();
    } catch (err) {
      setError(err?.message || "Failed to submit.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title={title} description={description} icon={icon} size="sm" tone={tone}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Reason" htmlFor="ov-reason-modal" required hint="Recorded in the audit trail. Ctrl+Enter to submit.">
          <textarea
            id="ov-reason-modal"
            required
            rows={3}
            maxLength={maxLength}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleSubmit(e);
            }}
            className={FORM_CONTROL_CLASS}
          />
        </Field>
        {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={handleClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant={submitVariant} loading={busy} disabled={busy || !reason.trim()}>{submitLabel}</Button>
        </div>
      </form>
    </Modal>
  );
}

function SummaryTile({ icon: Icon, label, value, tone, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-3 rounded-2xl border bg-white px-4 py-3 text-left transition-colors hover:border-brand-200 hover:bg-brand-50/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 ${
        active ? "border-brand-300 ring-1 ring-brand-200" : "border-slate-200"
      }`}
    >
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${tone}`}>
        <Icon size={16} />
      </span>
      <span>
        <span className="block text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</span>
        <span className="block text-xl font-bold text-slate-900">{displayValue(value)}</span>
      </span>
    </button>
  );
}

// `embedded` drops this page's own PageHeader when it is mounted as a tab of
// the Products & Pricing hub.
export default function OverridesPage({ embedded = false } = {}) {
  const { user } = useAuth();
  const [overrides, setOverrides] = useState([]);
  const [organizations, setOrganizations] = useState([]);
  const [definitions, setDefinitions] = useState([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  // Bumped on clear to remount SearchInput, so text still inside its debounce
  // window is discarded instead of re-applying the search a moment later.
  const [searchResetKey, setSearchResetKey] = useState(0);
  const hasActiveFilters = Boolean(search || statusFilter);
  const clearFilters = useCallback(() => {
    setSearchResetKey((k) => k + 1);
    setSearch("");
    setStatusFilter("");
  }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Organization / key lookups only label rows and fill the create form; if
  // they fail the override list is still shown, with a notice.
  const [lookupError, setLookupError] = useState(null);
  const [lookupsLoaded, setLookupsLoaded] = useState(false);
  const [success, setSuccess] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [submitTarget, setSubmitTarget] = useState(null);
  const [rejectTarget, setRejectTarget] = useState(null);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [withdrawTarget, setWithdrawTarget] = useState(null);
  const [approvingId, setApprovingId] = useState(null);
  // A failed row action. Kept apart from `error` (a failed LOAD), which
  // replaces the whole table — a rejected approval must not hide the list.
  const [actionError, setActionError] = useState(null);
  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  const loadLookups = useCallback(async () => {
    setLookupError(null);
    const [orgRes, defRes] = await Promise.allSettled([
      listOrganizations({ limit: 200 }),
      listEntitlementDefinitions(),
    ]);
    if (orgRes.status === "fulfilled") setOrganizations(orgRes.value?.organizations || []);
    if (defRes.status === "fulfilled") setDefinitions(defRes.value?.definitions || []);
    const failed = [orgRes, defRes].find((r) => r.status === "rejected");
    if (failed) {
      setLookupError(failed.reason?.message || "Couldn't load organizations or entitlement keys.");
    }
    setLookupsLoaded(true);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const oData = await listCommercialOverrides(statusFilter ? { status: statusFilter } : {});
      setOverrides(oData?.overrides || []);
    } catch (err) {
      setError(err?.message || "Failed to load commercial overrides.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    loadLookups();
  }, [loadLookups]);

  useEffect(() => {
    load();
  }, [load]);

  // Success notices clear themselves; errors stay until dismissed.
  useEffect(() => {
    if (!success) return undefined;
    const t = setTimeout(() => setSuccess(null), 6000);
    return () => clearTimeout(t);
  }, [success]);

  const orgById = useMemo(() => {
    const m = {};
    for (const o of organizations) m[o.id] = o;
    return m;
  }, [organizations]);

  const definitionById = useMemo(() => {
    const m = {};
    for (const d of definitions) m[d.id] = d;
    return m;
  }, [definitions]);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return overrides.filter((row) => {
      if (!term) return true;
      const org = orgById[row.organization_id];
      const orgText = org ? `${org.organization_code} ${org.organization_name}` : `#${row.organization_id}`;
      return (
        (row.entitlement_key || "").toLowerCase().includes(term) ||
        orgText.toLowerCase().includes(term) ||
        (row.reason || "").toLowerCase().includes(term)
      );
    });
  }, [overrides, search, orgById]);

  const counts = useMemo(() => {
    const c = { pending: 0, needsMe: 0, live: 0, drafts: 0 };
    for (const row of overrides) {
      if (row.status === "draft") c.drafts += 1;
      if (row.status === "pending_approval") {
        c.pending += 1;
        if (!isPastExpiry(row) && !(user?.id && row.requested_by_user_id === user.id)) c.needsMe += 1;
      }
      if (row.status === "approved" && !isPastExpiry(row)) c.live += 1;
    }
    return c;
  }, [overrides, user]);

  const describe = (row) => {
    const org = orgById[row.organization_id];
    return `${row.entitlement_key || "this key"} for ${org?.organization_name || `organization #${row.organization_id}`}`;
  };

  const handleApprove = useCallback(
    async (row) => {
      if (approvingId) return;
      const org = orgById[row.organization_id];
      const def = definitionById[row.entitlement_definition_id];
      const ok = await confirm({
        title: "Approve this override?",
        message: `${org?.organization_name || `Organization #${row.organization_id}`} will get ${row.entitlement_key} = ${formatOverrideValue(row.value, def?.value_type)} immediately, ahead of its plan's value${
          row.expires_at ? `, until ${formatExpiry(row.expires_at)}` : ""
        }.`,
        confirmLabel: "Approve",
        tone: "primary",
      });
      if (!ok) return;
      setActionError(null);
      setApprovingId(row.id);
      try {
        await approveCommercialOverride(row.id);
        setSuccess(`Override for ${row.entitlement_key} approved and now live.`);
        load();
      } catch (err) {
        setActionError(err?.message || "Failed to approve.");
      } finally {
        setApprovingId(null);
      }
    },
    [approvingId, confirm, load, orgById, definitionById]
  );

  const columns = useMemo(
    () => [
      {
        key: "org",
        label: "Organization",
        render: (row) => {
          const org = orgById[row.organization_id];
          return (
            <span>
              <span className="block text-sm font-semibold text-slate-800">{org?.organization_name || `Organization #${row.organization_id}`}</span>
              <span className="block text-xs text-slate-500">{org?.organization_code || (lookupsLoaded ? "Details not loaded" : "—")}</span>
            </span>
          );
        },
      },
      {
        key: "key",
        label: "Entitlement",
        render: (row) => {
          const def = definitionById[row.entitlement_definition_id];
          return (
            <span className="flex flex-col items-start gap-1">
              <span className="font-mono text-xs font-semibold text-slate-800">{row.entitlement_key || def?.key || `#${row.entitlement_definition_id}`}</span>
              {def && <EntitlementRiskBadge value={def.risk_classification} />}
            </span>
          );
        },
      },
      {
        key: "value",
        label: "Value",
        render: (row) => {
          const def = definitionById[row.entitlement_definition_id];
          return <span className="text-xs font-medium text-slate-700">{formatOverrideValue(row.value, def?.value_type)}</span>;
        },
      },
      {
        key: "status",
        label: "Status",
        render: (row) => (
          <span className="flex flex-col items-start gap-1">
            <StatusBadge status={row.status} options={OVERRIDE_STATUS_OPTIONS} />
            {row.status === "pending_approval" && isPastExpiry(row) && (
              <span className="text-[11px] font-medium text-red-600">Expired before approval</span>
            )}
            {/* The API never stores "expired"; an approved row past its
                expiry is simply no longer applied by the resolver. */}
            {row.status === "approved" && isPastExpiry(row) && (
              <span className="text-[11px] font-medium text-slate-500">Expired — no longer applied</span>
            )}
          </span>
        ),
      },
      {
        key: "expires_at",
        label: "Expires",
        render: (row) => (
          <span className={`text-xs ${isPastExpiry(row) ? "text-red-600" : "text-slate-500"}`}>
            {row.expires_at ? formatExpiry(row.expires_at) : "Never"}
          </span>
        ),
      },
      { key: "reason", label: "Reason", render: (row) => <span className="block max-w-xs truncate text-xs text-slate-500" title={row.reason}>{row.reason || "—"}</span> },
      {
        key: "actions",
        label: "Actions",
        width: 260,
        render: (row) => {
          if (row.status === "draft") {
            return <Button size="sm" variant="primary" icon={Send} onClick={() => setSubmitTarget(row)}>Submit</Button>;
          }
          if (row.status === "pending_approval") {
            const isSelf = user?.id && row.requested_by_user_id === user.id;
            if (isSelf) {
              // Maker-checker: the submitter can't approve or reject, but can
              // pull the request back instead of leaving it stuck.
              return (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700"
                    title="A different Super Admin must approve or reject your request"
                  >
                    <ShieldAlert size={13} /> Awaiting another admin
                  </span>
                  <Button size="sm" variant="secondary" icon={CornerUpLeft} onClick={() => setWithdrawTarget(row)}>Withdraw</Button>
                </div>
              );
            }
            // Approving a lapsed request would grant nothing (the server
            // refuses it too) — only Reject clears it from the queue.
            const approving = approvingId === row.id;
            return (
              <div className="flex flex-wrap items-center gap-1.5">
                {!isPastExpiry(row) && (
                  <Button size="sm" variant="primary" icon={Check} loading={approving} disabled={Boolean(approvingId)} onClick={() => handleApprove(row)}>
                    Approve
                  </Button>
                )}
                <Button size="sm" variant="danger" icon={X} disabled={approving} onClick={() => setRejectTarget(row)}>Reject</Button>
              </div>
            );
          }
          if (row.status === "approved") {
            return <Button size="sm" variant="danger" icon={Undo2} onClick={() => setRevokeTarget(row)}>Revoke</Button>;
          }
          return <span className="text-xs text-slate-400">No actions</span>;
        },
      },
    ],
    [orgById, definitionById, user, handleApprove, approvingId, lookupsLoaded]
  );

  const toggleStatus = (status) => setStatusFilter((prev) => (prev === status ? "" : status));

  return (
    <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
      <PageHeader
        embedded={embedded}
        accent="violet"
        title="Entitlement Overrides"
        description="Give a single organization a different value for one entitlement than its plan grants. Every override needs a second Super Admin to approve it, and applies until it expires or is revoked."
        icon={ShieldAlert}
        meta={error ? null : `${displayValue(overrides.length)} override(s)${statusFilter ? " with this status" : ""}`}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)} disabled={!lookupsLoaded || Boolean(lookupError)}>
            New override
          </Button>
        }
      />

      <div className={`space-y-4 ${embedded ? "" : "mt-6"}`}>
        {!statusFilter && !error && !loading && overrides.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <SummaryTile icon={Clock} label="Awaiting approval" value={counts.pending} tone="bg-amber-50 text-amber-600" onClick={() => toggleStatus("pending_approval")} />
            <SummaryTile icon={ShieldCheck} label="Live now" value={counts.live} tone="bg-emerald-50 text-emerald-600" onClick={() => toggleStatus("approved")} />
            <SummaryTile icon={FileEdit} label="Drafts (not submitted)" value={counts.drafts} tone="bg-slate-100 text-slate-600" onClick={() => toggleStatus("draft")} />
          </div>
        )}

        {!error && counts.needsMe > 0 && statusFilter !== "pending_approval" && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <span>
              {counts.needsMe} override request{counts.needsMe === 1 ? "" : "s"} from another admin {counts.needsMe === 1 ? "is" : "are"} waiting for your review.
            </span>
            <Button size="sm" variant="secondary" onClick={() => setStatusFilter("pending_approval")}>Show requests</Button>
          </div>
        )}

        <SectionCard variant="quiet">
          <p className="text-xs leading-5 text-slate-600">
            How it works: create a <span className="font-semibold">draft</span>, <span className="font-semibold">submit</span>{" "}
            it, and a <span className="font-semibold">different</span> Super Admin approves or rejects it. An approved
            override beats the organization's plan value until it expires (no cleanup needed) or is revoked. Only one live
            override is allowed per organization and key — revoke the old one before creating a replacement.
          </p>
        </SectionCard>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <SearchInput key={searchResetKey} value={search} onChange={setSearch} placeholder="Search by organization, key or reason…" className="w-full sm:max-w-sm" />
          <div className="flex w-full items-center gap-3 sm:w-auto">
            <Select value={statusFilter} onChange={setStatusFilter} options={OVERRIDE_STATUS_OPTIONS} placeholder="All statuses" className="w-full sm:w-48" aria-label="Filter overrides by status" />
            <button
              type="button"
              onClick={clearFilters}
              disabled={!hasActiveFilters}
              title={hasActiveFilters ? "Reset search and status filter" : "No filters applied"}
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-brand-600 hover:bg-brand-50 hover:text-brand-700 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-transparent"
            >
              <X size={14} />
              Clear filters
            </button>
          </div>
        </div>

        {success && <SuccessMessage message={success} onDismiss={() => setSuccess(null)} />}
        {actionError && (
          <div role="alert" className="flex items-start justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>{actionError}</span>
            <button type="button" onClick={() => setActionError(null)} className="text-xs font-semibold underline">Dismiss</button>
          </div>
        )}
        {lookupError && (
          <div role="alert" className="flex items-start justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <span>{lookupError} Organization names and value types may be missing below, and new overrides can't be created until this loads.</span>
            <button type="button" onClick={() => loadLookups()} className="text-xs font-semibold underline">Retry</button>
          </div>
        )}

        {/* error and the table used to render independently, so a failed
            fetch (which also clears `rows` to []) showed the error banner
            stacked above "No commercial overrides yet" — a failure read as an
            empty catalogue. */}
        {error ? (
          <SectionCard variant="standard">
            <ErrorState message={error} onRetry={() => load()} title="Unable to load overrides" />
          </SectionCard>
        ) : (
          <SectionCard
            variant="hero"
            accent="violet"
            icon={ShieldAlert}
            title="Override requests"
            description="Drafts, requests awaiting approval, and overrides that are live or ended."
            meta={search && !loading ? `Showing ${rows.length} of ${overrides.length}` : null}
          >
            {loading && rows.length === 0 ? (
              <Spinner />
            ) : (
              <DataTable
                columns={columns}
                data={rows}
                loading={loading}
                rowKey={(row) => row.id}
                emptyTitle={hasActiveFilters ? "No overrides found" : "No commercial overrides yet"}
                emptyMessage={hasActiveFilters ? "No overrides match your filters." : "Create the first override to grant an org a non-standard entitlement value."}
                emptyAction={
                  hasActiveFilters ? (
                    <Button variant="secondary" size="sm" icon={X} onClick={clearFilters}>Clear filters</Button>
                  ) : lookupsLoaded && !lookupError ? (
                    <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreateOpen(true)}>New override</Button>
                  ) : null
                }
                minWidth={1080}
              />
            )}
          </SectionCard>
        )}
      </div>

      <CreateDraftModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        organizations={organizations}
        definitions={definitions}
        onCreated={async (payload) => {
          const override = await createCommercialOverride(payload);
          setSuccess(`Draft created for ${override?.entitlement_key || "the selected key"}. Submit it for approval when ready.`);
          load();
          return override || true;
        }}
      />

      <ReasonModal
        open={Boolean(submitTarget)}
        onClose={() => setSubmitTarget(null)}
        title="Submit for approval"
        description={submitTarget ? `Send ${describe(submitTarget)} to another Super Admin to approve.` : undefined}
        icon={Send}
        submitLabel="Submit"
        onSubmit={async (reason) => {
          await submitCommercialOverride(submitTarget.id, reason);
          setSuccess(`Override for ${submitTarget.entitlement_key} submitted for approval.`);
          load();
        }}
      />

      <ReasonModal
        open={Boolean(rejectTarget)}
        onClose={() => setRejectTarget(null)}
        title="Reject override"
        description={rejectTarget ? `Decline ${describe(rejectTarget)}. This is final; a new draft is needed to try again.` : undefined}
        icon={X}
        tone="danger"
        submitLabel="Reject"
        submitVariant="danger"
        onSubmit={async (reason) => {
          await rejectCommercialOverride(rejectTarget.id, reason);
          setSuccess(`Override for ${rejectTarget.entitlement_key} rejected.`);
          load();
        }}
      />

      <ReasonModal
        open={Boolean(revokeTarget)}
        onClose={() => setRevokeTarget(null)}
        title="Revoke override"
        description={revokeTarget ? `End ${describe(revokeTarget)} now. The organization goes back to its plan's value. This can't be undone.` : undefined}
        icon={ShieldOff}
        tone="danger"
        maxLength={2000}
        submitLabel="Revoke"
        submitVariant="danger"
        onSubmit={async (reason) => {
          await revokeCommercialOverride(revokeTarget.id, reason);
          setSuccess(`Override for ${revokeTarget.entitlement_key} revoked.`);
          load();
        }}
      />

      <ReasonModal
        open={Boolean(withdrawTarget)}
        onClose={() => setWithdrawTarget(null)}
        title="Withdraw your override request"
        description={withdrawTarget ? `Pull back your request for ${describe(withdrawTarget)}. Nothing was applied yet.` : undefined}
        icon={CornerUpLeft}
        maxLength={2000}
        submitLabel="Withdraw"
        onSubmit={async (reason) => {
          await withdrawCommercialOverride(withdrawTarget.id, reason);
          setSuccess(`Override request for ${withdrawTarget.entitlement_key} withdrawn.`);
          load();
        }}
      />

      {ConfirmationDialog}
    </div>
  );
}
