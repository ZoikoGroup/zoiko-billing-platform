import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ShieldCheck,
  CheckCircle2,
  UserPlus,
  ArrowRightCircle,
  BellOff,
  ScrollText,
  CheckSquare,
  KeyRound,
  Power,
  ShieldAlert,
} from "lucide-react";
import {
  listAttentionItems,
  acknowledgeAttentionItem,
  assignAttentionItem,
  transitionAttentionItem,
  suppressAttentionItem,
  getInvoiceFinalizationBreaker,
  setInvoiceFinalizationBreaker,
} from "../../service/commandCenterService";
import { PageHeader, Modal, Field, Button } from "../../components/billing-ui";
import { ErrorState, Spinner, SuccessMessage, StatusBadge, EmptyState } from "../../components/billing-shared";
import { formatDateTime } from "./constants";
import { useAuth } from "../../context/AuthContext";
import { useCommandCenter } from "../../context/CommandCenterContext";

/**
 * ZB-SA-CMD-003 §12 Lens 5 — Governance: Attention/incident lifecycle
 * (Approval Center, Audit & Evidence, and Privileged Sessions already have
 * their own dedicated pages — ApprovalQueuePage, AuditLogsPage,
 * SupportAccessPage — this page links to them rather than re-implementing
 * their logic, plus owns the Attention queue UI, which had no frontend at
 * all before this pass).
 */

const SEVERITY_OPTIONS = [
  { value: "p0", label: "P0", color: "bg-red-600 text-white" },
  { value: "p1", label: "P1", color: "bg-orange-500 text-white" },
  { value: "p2", label: "P2", color: "bg-amber-400 text-white" },
  { value: "p3", label: "P3", color: "bg-slate-400 text-white" },
];

const STATUS_OPTIONS = [
  { value: "open", label: "Open", color: "bg-red-100 text-red-700" },
  { value: "acknowledged", label: "Acknowledged", color: "bg-amber-100 text-amber-700" },
  { value: "assigned", label: "Assigned", color: "bg-blue-100 text-blue-700" },
  { value: "mitigating", label: "Mitigating", color: "bg-indigo-100 text-indigo-700" },
  { value: "monitoring", label: "Monitoring", color: "bg-cyan-100 text-cyan-700" },
  { value: "resolved", label: "Resolved", color: "bg-emerald-100 text-emerald-700" },
  { value: "closed", label: "Closed", color: "bg-slate-100 text-slate-500" },
  { value: "suppressed", label: "Suppressed", color: "bg-slate-100 text-slate-500" },
];

function SeverityBadge({ value }) {
  return <StatusBadge status={value} options={SEVERITY_OPTIONS} />;
}
function AttentionStatusBadge({ value }) {
  return <StatusBadge status={value} options={STATUS_OPTIONS} />;
}

function ResolveModal({ open, onClose, onSubmit }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setCode(""); } }, [open]);
  return (
    <Modal open={open} onClose={onClose} title="Resolve attention item" icon={CheckCircle2} size="sm">
      <div className="space-y-4">
        <Field label="Resolution code" htmlFor="resolution-code" required hint="Required for the audit record.">
          <input
            id="resolution-code" value={code} onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. restarted_worker, config_fixed"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary" loading={busy} disabled={!code}
            onClick={async () => { setBusy(true); try { await onSubmit(code); onClose(); } finally { setBusy(false); } }}
          >
            Resolve
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function SuppressModal({ open, onClose, onSubmit }) {
  const [reason, setReason] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setReason(""); setMinutes(60); } }, [open]);
  return (
    <Modal open={open} onClose={onClose} title="Suppress attention item" icon={BellOff} size="sm">
      <div className="space-y-4">
        <p className="text-xs text-slate-500">Suppression is time-bound and cannot be permanent — it returns to Open automatically when it expires.</p>
        <Field label="Reason" htmlFor="suppress-reason" required>
          <textarea
            id="suppress-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        <Field label="Duration" htmlFor="suppress-minutes">
          <select
            id="suppress-minutes" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          >
            <option value={30}>30 minutes</option>
            <option value={60}>1 hour</option>
            <option value={240}>4 hours</option>
            <option value={1440}>24 hours</option>
          </select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="danger" loading={busy} disabled={!reason}
            onClick={async () => { setBusy(true); try { await onSubmit(reason, minutes); onClose(); } finally { setBusy(false); } }}
          >
            Suppress
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AttentionRow({ item, currentUserId, onAction }) {
  const [resolveOpen, setResolveOpen] = useState(false);
  const [suppressOpen, setSuppressOpen] = useState(false);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 py-3 text-sm last:border-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <SeverityBadge value={item.severity} />
          <AttentionStatusBadge value={item.status} />
          <span className="truncate font-semibold text-slate-800">{item.title}</span>
          {item.occurrence_count > 1 && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">×{item.occurrence_count}</span>
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-slate-500">
          {item.source_key} · opened {formatDateTime(item.opened_at)}
          {item.owner_user_id ? ` · owner #${item.owner_user_id}` : ""}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-1.5">
        {item.status === "open" && (
          <Button size="sm" variant="secondary" icon={CheckCircle2} onClick={() => onAction(acknowledgeAttentionItem(item.id))}>
            Acknowledge
          </Button>
        )}
        {["open", "acknowledged"].includes(item.status) && (
          <Button size="sm" variant="secondary" icon={UserPlus} onClick={() => onAction(assignAttentionItem(item.id, currentUserId))}>
            Assign to me
          </Button>
        )}
        {["assigned", "acknowledged"].includes(item.status) && (
          <Button size="sm" variant="secondary" icon={ArrowRightCircle} onClick={() => onAction(transitionAttentionItem(item.id, "mitigating"))}>
            Start mitigating
          </Button>
        )}
        {["open", "acknowledged", "assigned", "mitigating", "monitoring"].includes(item.status) && (
          <Button size="sm" variant="primary" icon={CheckCircle2} onClick={() => setResolveOpen(true)}>
            Resolve
          </Button>
        )}
        {["open", "acknowledged", "assigned", "mitigating", "monitoring"].includes(item.status) && (
          <Button size="sm" variant="secondary" icon={BellOff} onClick={() => setSuppressOpen(true)}>
            Suppress
          </Button>
        )}
      </div>
      <ResolveModal open={resolveOpen} onClose={() => setResolveOpen(false)} onSubmit={(code) => onAction(transitionAttentionItem(item.id, "resolved", code))} />
      <SuppressModal open={suppressOpen} onClose={() => setSuppressOpen(false)} onSubmit={(reason, minutes) => onAction(suppressAttentionItem(item.id, reason, minutes))} />
    </div>
  );
}

// ZB-SA-CMD-003 §18 — the one real Domain B circuit breaker implemented so
// far. Toggling requires a reason AND a fresh MFA step-up code every time
// (both pause and resume) — enforced server-side, not just hidden here.
function BreakerToggleModal({ open, onClose, targetEnabled, onSubmit }) {
  const [reason, setReason] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { if (open) { setReason(""); setCode(""); setError(null); } }, [open]);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason, code);
      onClose();
    } catch (err) {
      setError(err?.message || "Failed to update the circuit breaker.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={targetEnabled ? "Resume invoice finalization?" : "Pause invoice finalization?"} icon={targetEnabled ? Power : ShieldAlert} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-slate-600">
          {targetEnabled
            ? "Tenants across the platform will be able to finalize invoices again."
            : "This immediately blocks ALL tenants from finalizing new invoices platform-wide. Already-issued invoices are unaffected."}
        </p>
        <Field label="Reason" htmlFor="breaker-reason" required hint="Required for the audit record.">
          <textarea id="breaker-reason" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100" />
        </Field>
        <Field label="MFA code" htmlFor="breaker-mfa" required hint="A fresh authenticator code — required every time this breaker changes.">
          <input id="breaker-mfa" required inputMode="numeric" maxLength={8} value={code}
            onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))} placeholder="123456"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-center text-lg tracking-widest focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100" />
        </Field>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant={targetEnabled ? "primary" : "danger"} loading={busy} disabled={!reason || code.length < 6}>
            {targetEnabled ? "Resume" : "Pause"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function CircuitBreakerCard() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [modalTarget, setModalTarget] = useState(null);

  const load = useCallback(() => {
    getInvoiceFinalizationBreaker().then(setState).catch((e) => setError(e?.message || "Failed to load."));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function handleSubmit(reason, code) {
    const updated = await setInvoiceFinalizationBreaker(modalTarget, reason, code);
    setState(updated);
  }

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
      <p className="mb-1 flex items-center gap-2 text-sm font-bold text-slate-700"><Power size={16} /> Circuit Breakers</p>
      <p className="mb-4 text-xs text-slate-500">Real, server-enforced platform-wide controls — MFA step-up required on every change.</p>
      {error ? (
        <ErrorState message={error} onRetry={load} title="Unable to load breaker state" />
      ) : !state ? (
        <Spinner />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Invoice Finalization</p>
            <p className={`text-lg font-extrabold ${state.enabled ? "text-emerald-700" : "text-red-600"}`}>
              {state.enabled ? "Enabled" : "Paused"}
            </p>
            {state.reason && <p className="text-xs text-slate-500">Last reason: {state.reason}</p>}
          </div>
          <Button variant={state.enabled ? "danger" : "primary"} icon={state.enabled ? ShieldAlert : Power} onClick={() => setModalTarget(!state.enabled)}>
            {state.enabled ? "Pause" : "Resume"}
          </Button>
        </div>
      )}
      <BreakerToggleModal open={modalTarget !== null} targetEnabled={modalTarget} onClose={() => setModalTarget(null)} onSubmit={handleSubmit} />
    </div>
  );
}

export default function GovernancePage() {
  const { user } = useAuth();
  const { activeGrant, attentionCounts, refresh: refreshShell } = useCommandCenter();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listAttentionItems()
      .then((res) => setItems(res.items || []))
      .catch((e) => setError(e?.message || "Failed to load the Attention queue."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleAction(promise) {
    try {
      await promise;
      setNotice("Attention item updated.");
      load();
      refreshShell();
    } catch (e) {
      setError(e?.message || "Action failed.");
    }
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Governance"
        description="Approval, audit and evidence integrity, privileged access, and the Attention/incident queue — cross-cutting oversight, not a financial view."
        icon={ShieldCheck}
      />

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Link to="/super-admin/approval-queue" className="rounded-2xl border border-slate-200 bg-white p-5 transition hover:border-brand-300 hover:shadow-sm">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-600"><CheckSquare size={14} /> Approval Center</p>
          <p className="mt-1 text-sm font-semibold text-slate-800">Maker-checker queue →</p>
        </Link>
        <Link to="/super-admin/audit-logs" className="rounded-2xl border border-slate-200 bg-white p-5 transition hover:border-brand-300 hover:shadow-sm">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-600"><ScrollText size={14} /> Audit & Evidence</p>
          <p className="mt-1 text-sm font-semibold text-slate-800">Platform audit trail →</p>
        </Link>
        <Link to="/super-admin/support-access" className="rounded-2xl border border-slate-200 bg-white p-5 transition hover:border-brand-300 hover:shadow-sm">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-600"><KeyRound size={14} /> Privileged Sessions</p>
          <p className="mt-1 text-sm font-semibold text-slate-800">
            {activeGrant ? "1 active session" : "0 active sessions"} →
          </p>
        </Link>
      </div>

      {notice && <div className="mt-4"><SuccessMessage message={notice} onDismiss={() => setNotice(null)} /></div>}

      <div className="mt-6">
        <CircuitBreakerCard />
      </div>

      <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm font-bold text-slate-700">Attention Queue</p>
          {attentionCounts && (
            <p className="text-xs text-slate-500">
              {attentionCounts.total_open} open · {attentionCounts.sla_breaches} SLA breach{attentionCounts.sla_breaches === 1 ? "" : "es"}
            </p>
          )}
        </div>
        {loading ? (
          <Spinner />
        ) : error ? (
          <ErrorState message={error} onRetry={load} title="Unable to load the Attention queue" />
        ) : items.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="No open attention items" message="Real signals only: job failures and safety-control state changes report here automatically. Nothing is fabricated for demonstration." />
        ) : (
          <div>
            {items.map((item) => (
              <AttentionRow key={item.id} item={item} currentUserId={user?.id} onAction={handleAction} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
