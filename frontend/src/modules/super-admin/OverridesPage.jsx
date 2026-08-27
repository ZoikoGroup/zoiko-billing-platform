import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldAlert, Plus, Send, Check, X, Undo2, ShieldOff } from "lucide-react";
import {
  listCommercialOverrides,
  createCommercialOverride,
  submitCommercialOverride,
  approveCommercialOverride,
  rejectCommercialOverride,
  revokeCommercialOverride,
  listEntitlementDefinitions,
  listOrganizations,
} from "../../service/commercialService";
import { PageHeader, DataTable, Button, Modal, Field, Select, SearchInput } from "../../components/billing-ui";
import { ErrorState, Spinner, SuccessMessage, StatusBadge, useConfirmationDialog } from "../../components/billing-shared";
import { useAuth } from "../../context/AuthContext";
import {
  OVERRIDE_STATUS_OPTIONS,
  EntitlementRiskBadge,
  formatEntitlementValue,
  formatDateTime,
  displayValue,
} from "./constants";

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
          <input id="ov-expires" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className={inputClass} />
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

export default function OverridesPage() {
  const { user } = useAuth();
  const [overrides, setOverrides] = useState([]);
  const [organizations, setOrganizations] = useState([]);
  const [definitions, setDefinitions] = useState([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [submitTarget, setSubmitTarget] = useState(null);
  const [rejectTarget, setRejectTarget] = useState(null);
  const [revokeTarget, setRevokeTarget] = useState(null);
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
      try {
        await approveCommercialOverride(row.id);
        setSuccess(`Override for ${row.entitlement_key} approved.`);
        load();
      } catch (err) {
        setError(err?.message || "Failed to approve.");
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
      { key: "status", label: "Status", render: (row) => <StatusBadge status={row.status} options={OVERRIDE_STATUS_OPTIONS} /> },
      { key: "expires_at", label: "Expires", render: (row) => <span className="text-xs text-slate-500">{row.expires_at ? formatDateTime(row.expires_at) : "Never"}</span> },
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
              return (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
                  <ShieldAlert size={13} /> Self-approval blocked
                </span>
              );
            }
            return (
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="primary" icon={Check} onClick={() => handleApprove(row)}>Approve</Button>
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
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Commercial Overrides"
        description="ZB-COM-ENT-001 · Part 2 §16.1 · per-org entitlement overrides with maker-checker approval. An override beats the org's plan entitlement (resolver precedence L3) until it expires or is revoked."
        icon={ShieldAlert}
        meta={`${displayValue(overrides.length)} override(s)`}
        actions={<Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>New override</Button>}
      />

      <div className="mt-6 space-y-4">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">
          Every override — regardless of risk classification — requires a different Super Admin to approve it than the
          one who submitted it. An <span className="font-semibold">expired</span> override is excluded automatically
          by the resolver; no cleanup step is needed. At most one live <span className="font-semibold">Approved</span>{" "}
          override may exist per organization + entitlement key at a time.
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search by organization or key…" className="w-full max-w-sm" />
          <Select value={statusFilter} onChange={setStatusFilter} options={OVERRIDE_STATUS_OPTIONS} placeholder="All statuses" className="w-48" />
        </div>

        {success && <SuccessMessage message={success} onDismiss={() => setSuccess(null)} />}
        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
            {error}
            <button type="button" onClick={load} className="ml-3 font-semibold underline">Retry</button>
          </div>
        )}

        {loading && rows.length === 0 ? (
          <Spinner />
        ) : (
          <DataTable
            columns={columns}
            data={rows}
            loading={loading}
            rowKey={(row) => row.id}
            emptyTitle="No commercial overrides yet"
            emptyMessage={search || statusFilter ? "No overrides match your filters." : "Create the first override to grant an org a non-standard entitlement value."}
            minWidth={1080}
          />
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

      {ConfirmationDialog}
    </div>
  );
}
