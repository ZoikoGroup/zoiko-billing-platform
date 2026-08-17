import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { GitBranch, Plus, Send, Check, X, Archive } from "lucide-react";
import {
  getCommercialPlan,
  listCommercialPlanVersions,
  createCommercialPlanVersion,
  submitCommercialPlanVersion,
  approveCommercialPlanVersion,
  rejectCommercialPlanVersion,
  archiveCommercialPlanVersion,
} from "../../service/commercialService";
import { PageHeader, DataTable, Button, Modal, Field } from "../../components/billing-ui";
import { ErrorState, Spinner, SuccessMessage, StatusBadge, useConfirmationDialog } from "../../components/billing-shared";
import { CATALOG_VERSION_STATUS_OPTIONS, formatDateOnly, formatDateTime, displayValue } from "./constants";

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

function CreateDraftModal({ open, onClose, planName, onCreated }) {
  const [form, setForm] = useState({ ...EMPTY_DRAFT, plan_name: planName });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setForm({ ...EMPTY_DRAFT, plan_name: planName });
      setError(null);
    }
  }, [open, planName]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const numOrNull = (v) => (v === "" ? null : Number(v));
      const payload = {
        plan_name: form.plan_name.trim(),
        description: form.description.trim() || null,
        billing_interval: form.billing_interval || null,
        currency: form.currency.trim().toUpperCase() || null,
        price_amount: numOrNull(form.price_amount),
        effective_from: form.effective_from || null,
        effective_to: form.effective_to || null,
        max_users: numOrNull(form.max_users),
        max_storage_gb: numOrNull(form.max_storage_gb),
      };
      const version = await onCreated(payload);
      if (version) onClose();
    } catch (err) {
      setError(err?.message || "Failed to create the draft version.");
    } finally {
      setBusy(false);
    }
  }

  const inputClass = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100";

  return (
    <Modal open={open} onClose={onClose} title="Draft a new catalog version" icon={GitBranch} size="lg">
      <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Plan name" htmlFor="cv-name" required className="sm:col-span-2">
          <input id="cv-name" required value={form.plan_name} onChange={set("plan_name")} className={inputClass} />
        </Field>
        <Field label="Description" htmlFor="cv-desc" className="sm:col-span-2">
          <textarea id="cv-desc" rows={2} value={form.description} onChange={set("description")} className={inputClass} />
        </Field>
        <Field label="Currency" htmlFor="cv-currency" hint="ISO-4217 code, e.g. USD">
          <input id="cv-currency" maxLength={3} value={form.currency} onChange={set("currency")} className={inputClass} />
        </Field>
        <Field label="Price amount" htmlFor="cv-price" hint="Optional — only set once an approved catalog supplies a price.">
          <input id="cv-price" type="number" min="0" step="0.01" value={form.price_amount} onChange={set("price_amount")} className={inputClass} />
        </Field>
        <Field label="Effective from" htmlFor="cv-from">
          <input id="cv-from" type="date" value={form.effective_from} onChange={set("effective_from")} className={inputClass} />
        </Field>
        <Field label="Effective to" htmlFor="cv-to">
          <input id="cv-to" type="date" value={form.effective_to} onChange={set("effective_to")} className={inputClass} />
        </Field>
        <Field label="Max users" htmlFor="cv-users">
          <input id="cv-users" type="number" min="0" value={form.max_users} onChange={set("max_users")} className={inputClass} />
        </Field>
        <Field label="Max storage (GB)" htmlFor="cv-storage">
          <input id="cv-storage" type="number" min="0" value={form.max_storage_gb} onChange={set("max_storage_gb")} className={inputClass} />
        </Field>
        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 sm:col-span-2">{error}</p>
        )}
        <div className="flex items-center justify-end gap-2 sm:col-span-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>Create draft</Button>
        </div>
      </form>
    </Modal>
  );
}

function SubmitModal({ open, onClose, onSubmit }) {
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
      setError(err?.message || "Failed to submit for approval.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Submit for approval" icon={Send} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Reason" htmlFor="submit-reason" required>
          <textarea id="submit-reason" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100" />
        </Field>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!reason}>Submit</Button>
        </div>
      </form>
    </Modal>
  );
}

export default function CommercialPlanVersionsPage() {
  const { planId } = useParams();
  const navigate = useNavigate();
  const [plan, setPlan] = useState(null);
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [submitTarget, setSubmitTarget] = useState(null);
  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, v] = await Promise.all([
        getCommercialPlan(planId),
        listCommercialPlanVersions(planId),
      ]);
      setPlan(p);
      setVersions(v.versions || []);
    } catch (err) {
      setError(err?.message || "Failed to load catalog versions.");
    } finally {
      setLoading(false);
    }
  }, [planId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleApprove = useCallback(
    async (version) => {
      const ok = await confirm({
        title: `Publish version ${version.version_number}?`,
        message: "This makes the version live and permanently immutable. You cannot approve your own submission — the backend will reject it if you try.",
        confirmLabel: "Approve & publish",
        tone: "primary",
      });
      if (!ok) return;
      try {
        await approveCommercialPlanVersion(version.id);
        setSuccess(`Version ${version.version_number} published.`);
        load();
      } catch (err) {
        setError(err?.message || "Failed to approve/publish.");
      }
    },
    [confirm, load]
  );

  const handleArchive = useCallback(
    async (version) => {
      const ok = await confirm({
        title: `Archive version ${version.version_number}?`,
        message: "Archiving retires this version from new subscriptions. Existing subscriptions keep referencing it — history is preserved.",
        confirmLabel: "Archive",
        tone: "danger",
      });
      if (!ok) return;
      try {
        await archiveCommercialPlanVersion(version.id);
        setSuccess(`Version ${version.version_number} archived.`);
        load();
      } catch (err) {
        setError(err?.message || "Failed to archive.");
      }
    },
    [confirm, load]
  );

  const [rejectTarget, setRejectTarget] = useState(null);

  const columns = useMemo(
    () => [
      { key: "version", label: "Version", width: 90, render: (row) => <span className="font-mono text-sm font-semibold text-slate-700">v{row.version_number}</span> },
      { key: "status", label: "Status", render: (row) => <StatusBadge status={row.status} options={CATALOG_VERSION_STATUS_OPTIONS} /> },
      { key: "price", label: "Price", render: (row) => <span className="text-xs text-slate-600">{row.price_amount === null ? "—" : `${row.currency || ""} ${row.price_amount}`}</span> },
      { key: "limits", label: "Limits", render: (row) => <span className="text-xs text-slate-600">{displayValue(row.max_users)} users · {displayValue(row.max_storage_gb)} GB</span> },
      { key: "effective", label: "Effective", render: (row) => <span className="text-xs text-slate-500">{formatDateOnly(row.effective_from)} — {formatDateOnly(row.effective_to)}</span> },
      { key: "published_at", label: "Published", render: (row) => <span className="text-xs text-slate-500">{row.published_at ? formatDateTime(row.published_at) : "—"}</span> },
      {
        key: "actions",
        label: "Actions",
        width: 260,
        render: (row) => {
          if (row.status === "draft") {
            return <Button size="sm" variant="primary" icon={Send} onClick={() => setSubmitTarget(row)}>Submit</Button>;
          }
          if (row.status === "pending_approval") {
            return (
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="primary" icon={Check} onClick={() => handleApprove(row)}>Approve</Button>
                <Button size="sm" variant="danger" icon={X} onClick={() => setRejectTarget(row)}>Reject</Button>
              </div>
            );
          }
          if (row.status === "published") {
            return <Button size="sm" variant="danger" icon={Archive} onClick={() => handleArchive(row)}>Archive</Button>;
          }
          return <span className="text-xs text-slate-400">—</span>;
        },
      },
    ],
    [handleApprove, handleArchive]
  );

  if (loading) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <PageHeader title="Catalog Versions" icon={GitBranch} />
        <div className="mt-6"><Spinner /></div>
      </div>
    );
  }

  if (error && !plan) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <PageHeader title="Catalog Versions" icon={GitBranch} />
        <div className="mt-6 rounded-3xl border border-slate-200 bg-white">
          <ErrorState message={error} onRetry={load} title="Unable to load catalog versions" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        crumbs={[
          { label: "Commercial Plans", href: "/super-admin/commercial/plans" },
          { label: plan?.plan_code },
        ]}
        title={`Catalog Versions — ${plan?.plan_name}`}
        description="Every published version is immutable. Correcting a price/limit creates a new version — history is never overwritten (ZB-COM-BILL-001 §T1)."
        icon={GitBranch}
        actions={<Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>New draft</Button>}
      />

      {success && <div className="mt-4"><SuccessMessage message={success} onDismiss={() => setSuccess(null)} /></div>}
      {error && (
        <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
          {error}
          <button type="button" onClick={load} className="ml-3 font-semibold underline">Retry</button>
        </div>
      )}

      <div className="mt-6">
        <DataTable
          columns={columns}
          data={versions}
          rowKey={(row) => row.id}
          emptyTitle="No catalog versions yet"
          emptyMessage="Create the first draft to start versioning this plan's catalog."
          minWidth={960}
        />
      </div>

      <CreateDraftModal
        open={createOpen}
        planName={plan?.plan_name}
        onClose={() => setCreateOpen(false)}
        onCreated={async (payload) => {
          const version = await createCommercialPlanVersion(planId, payload);
          setSuccess(`Draft version ${version.version_number} created.`);
          load();
          return version;
        }}
      />
      <SubmitModal
        open={Boolean(submitTarget)}
        onClose={() => setSubmitTarget(null)}
        onSubmit={async (reason) => {
          await submitCommercialPlanVersion(submitTarget.id, reason);
          setSuccess(`Version ${submitTarget.version_number} submitted for approval.`);
          load();
        }}
      />
      <Modal
        open={Boolean(rejectTarget)}
        onClose={() => setRejectTarget(null)}
        title="Reject version"
        icon={X}
        size="sm"
      >
        {rejectTarget && (
          <RejectVersionForm
            onClose={() => setRejectTarget(null)}
            onSubmit={async (reason) => {
              await rejectCommercialPlanVersion(rejectTarget.id, reason);
              setSuccess(`Version ${rejectTarget.version_number} rejected.`);
              setRejectTarget(null);
              load();
            }}
          />
        )}
      </Modal>
      {ConfirmationDialog}
    </div>
  );
}

function RejectVersionForm({ onClose, onSubmit }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason);
    } catch (err) {
      setError(err?.message || "Failed to reject.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field label="Rejection reason" htmlFor="reject-version-reason" required>
        <textarea id="reject-version-reason" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100" />
      </Field>
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="danger" loading={busy} disabled={!reason}>Reject</Button>
      </div>
    </form>
  );
}
