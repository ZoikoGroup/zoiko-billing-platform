import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldAlert, Plus, Send, Check, X, Undo2, ShieldOff, CornerUpLeft } from "lucide-react";
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
import { PageHeader, SectionCard, DataTable, Button, Modal, Field, Select, SearchInput } from "../../components/billing-ui";
import { ErrorState, Spinner, SuccessMessage, StatusBadge, useConfirmationDialog } from "../../components/billing-shared";
import { useAuth } from "../../context/AuthContext";
import {
  OVERRIDE_STATUS_OPTIONS,
  EntitlementRiskBadge,
  formatEntitlementValue,
  formatDateTime,
  displayValue,
} from "./constants";

// Expiry is picked as a date, so it is stored as midnight; show just the date
// then, instead of a misleading "12:00 am".
function formatExpiry(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.getHours() === 0 && d.getMinutes() === 0
    ? d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })
    : formatDateTime(value);
}

const isPastExpiry = (row) => Boolean(row.expires_at) && new Date(row.expires_at).getTime() <= Date.now();

function localDateInput(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const inputClass =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100";

function parseValueForType(raw, valueType) {
  if (raw === "" || raw === null || raw === undefined) return null;
  if (valueType === "boolean") return raw === "true";
  if (valueType === "integer") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (valueType === "set") {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return raw; // enum — plain string
}

function ValueInput({ definition, value, onChange }) {
  if (!definition) {
    return <input disabled placeholder="Select an entitlement key first" className={inputClass} />;
  }
  if (definition.value_type === "boolean") {
    return (
      <Select
        value={value === null ? "" : String(value)}
        onChange={(v) => onChange(v === "" ? null : v === "true")}
        options={[
          { value: "true", label: "Enabled (true)" },
          { value: "false", label: "Disabled (false)" },
        ]}
        placeholder="Select a value…"
      />
    );
  }
  if (definition.value_type === "integer") {
    return (
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        className={inputClass}
      />
    );
  }
  if (definition.value_type === "set") {
    return (
      <input
        type="text"
        value={Array.isArray(value) ? value.join(", ") : value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder="comma-separated, e.g. flat, tiered, volume"
        className={inputClass}
      />
    );
  }
  return (
    <input
      type="text"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      className={inputClass}
    />
  );
}

function CreateDraftModal({ open, onClose, organizations, definitions, onCreated }) {
  const [orgId, setOrgId] = useState("");
  const [definitionId, setDefinitionId] = useState("");
  const [rawValue, setRawValue] = useState(null);
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setOrgId("");
      setDefinitionId("");
      setRawValue(null);
      setReason("");
      setExpiresAt("");
      setError(null);
    }
  }, [open]);

  const definition = useMemo(
    () => definitions.find((d) => String(d.id) === String(definitionId)) || null,
    [definitions, definitionId]
  );

  const orgOptions = useMemo(
    () => organizations.map((o) => ({ value: String(o.id), label: `${o.organization_code} — ${o.organization_name}` })),
    [organizations]
  );
  const definitionOptions = useMemo(
    () =>
      definitions.map((d) => ({
        value: String(d.id),
        label: d.risk_classification === "high_risk" ? `${d.key} (HIGH RISK)` : d.key,
      })),
    [definitions]
  );

  async function handleSubmit(e) {
    e.preventDefault();
    if (!orgId || !definitionId || !reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const override = await onCreated({
        organization_id: Number(orgId),
        entitlement_definition_id: Number(definitionId),
        value: definition ? parseValueForType(rawValue, definition.value_type) : null,
        reason: reason.trim(),
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
      if (override) onClose();
    } catch (err) {
      setError(err?.message || "Failed to create the override draft.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Draft a commercial override" icon={ShieldAlert} size="lg">
      <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Organization" htmlFor="ov-org" required className="sm:col-span-2">
          <Select value={orgId} onChange={setOrgId} options={orgOptions} placeholder="Select an organization…" />
        </Field>
        <Field label="Entitlement key" htmlFor="ov-def" required className="sm:col-span-2">
          <Select value={definitionId} onChange={setDefinitionId} options={definitionOptions} placeholder="Select an entitlement key…" />
        </Field>
        <Field
          label="Override value"
          htmlFor="ov-value"
          required
          hint={definition ? `Value type: ${definition.value_type}` : undefined}
          className="sm:col-span-2"
        >
          <ValueInput definition={definition} value={rawValue} onChange={setRawValue} />
        </Field>
        <Field label="Expires at" htmlFor="ov-expires" hint="Optional — leave blank for a permanent (Enterprise) override.">
          <input id="ov-expires" type="date" min={localDateInput(1)} value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Reason" htmlFor="ov-reason" required hint="Why this org needs a non-standard value for this key.">
          <textarea id="ov-reason" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} />
        </Field>
        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 sm:col-span-2">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 sm:col-span-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!orgId || !definitionId || !reason.trim()}>
            Create draft
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ReasonModal({ open, onClose, title, icon, submitLabel, submitVariant = "primary", onSubmit }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) { setReason(""); setError(null); }
  }, [open]);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason);
      onClose();
    } catch (err) {
      setError(err?.message || "Failed to submit.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={title} icon={icon} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Reason" htmlFor="ov-reason-modal" required>
          <textarea id="ov-reason-modal" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} />
        </Field>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant={submitVariant} loading={busy} disabled={!reason}>{submitLabel}</Button>
        </div>
      </form>
    </Modal>
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
  const [success, setSuccess] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [submitTarget, setSubmitTarget] = useState(null);
  const [rejectTarget, setRejectTarget] = useState(null);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [withdrawTarget, setWithdrawTarget] = useState(null);
  // A failed row action. Kept apart from `error` (a failed LOAD), which
  // replaces the whole table — a rejected approval must not hide the list.
  const [actionError, setActionError] = useState(null);
  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [oData, orgData, defData] = await Promise.all([
        listCommercialOverrides(statusFilter ? { status: statusFilter } : {}),
        listOrganizations({ limit: 200 }),
        listEntitlementDefinitions(),
      ]);
      setOverrides(oData.overrides || []);
      setOrganizations(orgData.organizations || []);
      setDefinitions(defData.definitions || []);
    } catch (err) {
      setError(err?.message || "Failed to load commercial overrides.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

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
      const orgText = org ? `${org.organization_code} ${org.organization_name}` : "";
      return (
        (row.entitlement_key || "").toLowerCase().includes(term) ||
        orgText.toLowerCase().includes(term)
      );
    });
  }, [overrides, search, orgById]);

  const handleApprove = useCallback(
    async (row) => {
      const ok = await confirm({
        title: "Approve this override?",
        message:
          "This makes the override live immediately, ahead of the org's plan entitlement. You cannot approve your own submission — the backend will reject it if you try.",
        confirmLabel: "Approve",
        tone: "primary",
      });
      if (!ok) return;
      setActionError(null);
      try {
        await approveCommercialOverride(row.id);
        setSuccess(`Override for ${row.entitlement_key} approved.`);
        load();
      } catch (err) {
        setActionError(err?.message || "Failed to approve.");
      }
    },
    [confirm, load]
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
              <span className="block text-sm font-semibold text-slate-800">{org?.organization_code || `#${row.organization_id}`}</span>
              <span className="block text-xs text-slate-500">{org?.organization_name || "—"}</span>
            </span>
          );
        },
      },
      {
        key: "key",
        label: "Entitlement Key",
        render: (row) => {
          const def = definitionById[row.entitlement_definition_id];
          return (
            <span>
              <span className="block font-mono text-xs font-semibold text-slate-800">{row.entitlement_key || def?.key}</span>
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
          return <span className="text-xs font-medium text-slate-700">{formatEntitlementValue(row.value, def?.value_type)}</span>;
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
      { key: "reason", label: "Reason", render: (row) => <span className="block max-w-xs truncate text-xs text-slate-500" title={row.reason}>{row.reason}</span> },
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
                <div className="flex items-center gap-1.5">
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
            return (
              <div className="flex items-center gap-1.5">
                {!isPastExpiry(row) && (
                  <Button size="sm" variant="primary" icon={Check} onClick={() => handleApprove(row)}>Approve</Button>
                )}
                <Button size="sm" variant="danger" icon={X} onClick={() => setRejectTarget(row)}>Reject</Button>
              </div>
            );
          }
          if (row.status === "approved") {
            return <Button size="sm" variant="danger" icon={Undo2} onClick={() => setRevokeTarget(row)}>Revoke</Button>;
          }
          return <span className="text-xs text-slate-500">—</span>;
        },
      },
    ],
    [orgById, definitionById, user, handleApprove]
  );

  return (
    <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
      <PageHeader
        embedded={embedded}
        accent="violet"
        title="Entitlement Overrides"
        description="ZB-COM-ENT-001 · Part 2 §16.1 · per-org entitlement overrides with maker-checker approval. An override beats the org's plan entitlement (resolver precedence L3) until it expires or is revoked."
        icon={ShieldAlert}
        meta={`${displayValue(overrides.length)} override(s)`}
        actions={<Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>New override</Button>}
      />

      <div className={`space-y-4 ${embedded ? "" : "mt-6"}`}>
        <SectionCard variant="quiet">
          <p className="text-xs leading-5 text-slate-600">
            Every override — regardless of risk classification — requires a different Super Admin to approve it than the
            one who submitted it. An <span className="font-semibold">expired</span> override is excluded automatically
            by the resolver; no cleanup step is needed. At most one live <span className="font-semibold">Approved</span>{" "}
            override may exist per organization + entitlement key at a time.
          </p>
        </SectionCard>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <SearchInput key={searchResetKey} value={search} onChange={setSearch} placeholder="Search by organization or key…" className="w-full max-w-sm" />
          <div className="flex items-center gap-3">
            <Select value={statusFilter} onChange={setStatusFilter} options={OVERRIDE_STATUS_OPTIONS} placeholder="All statuses" className="w-48" aria-label="Filter overrides by status" />
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

        {/* error and the table used to render independently, so a failed
            fetch (which also clears `rows` to []) showed the error banner
            stacked above "No commercial overrides yet" — a failure read as an
            empty catalogue. */}
        {error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
            {error}
            <button type="button" onClick={load} className="ml-3 font-semibold underline">Retry</button>
          </div>
        ) : (
          <SectionCard
            variant="hero"
            accent="violet"
            icon={ShieldAlert}
            title="Override Requests"
            description="Per-organization overrides awaiting or holding maker-checker approval — an approved override beats the org's plan entitlement until it expires or is revoked."
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
          setSuccess(`Override draft created for ${override.entitlement_key || "the selected key"}.`);
          load();
          return override;
        }}
      />

      <ReasonModal
        open={Boolean(submitTarget)}
        onClose={() => setSubmitTarget(null)}
        title="Submit for approval"
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
        icon={X}
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
        icon={ShieldOff}
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
        icon={CornerUpLeft}
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
