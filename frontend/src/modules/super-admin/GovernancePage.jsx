import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ShieldCheck,
  CheckCircle2,
  UserPlus,
  ArrowRightCircle,
  BellOff,
  ScrollText,
  KeyRound,
  Power,
  ShieldAlert,
  Eye,
  RefreshCw,
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
import { PageHeader, Modal, Field, Button, SectionCard, FORM_CONTROL_CLASS } from "../../components/billing-ui";
import { ErrorState, Spinner, SuccessMessage, StatusBadge, EmptyState } from "../../components/billing-shared";
import { ATTENTION_ACTIONS, formatDateTime } from "./constants";
import { useAuth } from "../../context/AuthContext";
import { useCommandCenter } from "../../context/CommandCenterContext";

/**
 * ZB-SA-CMD-003 §12 Lens 5 — Governance: Attention/incident lifecycle
 * (Audit & Evidence and Privileged Sessions already have their own
 * dedicated pages — AuditLogsPage, SupportAccessPage — this page links to
 * them rather than re-implementing their logic, plus owns the Attention
 * queue UI, which had no frontend at all before this pass).
 *
 * `embedded` drops this page's own PageHeader (and its page padding) when it
 * is mounted as a tab inside the Audit & Evidence hub, which renders the
 * tab-aware header itself — otherwise the operator sees two stacked headers,
 * the outer one titled for a different tab. Standalone routes
 * (/super-admin/governance, /super-admin/governance/data) leave it false and
 * keep a normal single header.
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

// Shared shape for the two reason dialogs: errors stay inside the dialog (and
// the dialog stays open) so a rejected action can be corrected and retried
// instead of closing and replacing the whole queue with an error screen.
function useDialogSubmit(onSubmit, onClose) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (...args) => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(...args);
      onClose();
    } catch (e) {
      setError(e?.message || "The action failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, submit };
}

function DialogError({ error }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
      {error}
    </div>
  );
}

function ResolveModal({ open, item, onClose, onSubmit }) {
  const [code, setCode] = useState("");
  const { busy, error, setError, submit } = useDialogSubmit(onSubmit, onClose);
  useEffect(() => { if (open) { setCode(""); setError(null); } }, [open, setError]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Resolve attention item"
      description={item?.title}
      icon={CheckCircle2}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="resolve-attention-form" variant="primary" loading={busy} disabled={!code.trim()}>
            Resolve
          </Button>
        </>
      }
    >
      <form
        id="resolve-attention-form"
        className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); if (code.trim()) submit(code.trim()); }}
      >
        <Field label="Resolution code" htmlFor="resolution-code" required hint="Recorded on the audit trail.">
          <input
            id="resolution-code" value={code} onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. restarted_worker, config_fixed"
            className={FORM_CONTROL_CLASS}
          />
        </Field>
        <DialogError error={error} />
      </form>
    </Modal>
  );
}

function SuppressModal({ open, item, onClose, onSubmit }) {
  const [reason, setReason] = useState("");
  const [minutes, setMinutes] = useState(60);
  const { busy, error, setError, submit } = useDialogSubmit(onSubmit, onClose);
  useEffect(() => { if (open) { setReason(""); setMinutes(60); setError(null); } }, [open, setError]);
  return (
    <Modal open={open} onClose={onClose} title="Suppress attention item" description={item?.title} icon={BellOff} size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="suppress-attention-form" variant="danger" loading={busy} disabled={!reason.trim()}>
            Suppress
          </Button>
        </>
      }
    >
      <form
        id="suppress-attention-form"
        className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); if (reason.trim()) submit(reason.trim(), minutes); }}
      >
        <p className="text-xs text-slate-500">Suppression is time-bound and cannot be permanent — the item returns to Open automatically when it expires.</p>
        <Field label="Reason" htmlFor="suppress-reason" required>
          <textarea
            id="suppress-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
            className={FORM_CONTROL_CLASS}
          />
        </Field>
        <Field label="Duration" htmlFor="suppress-minutes">
          <select
            id="suppress-minutes" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}
            className={FORM_CONTROL_CLASS}
          >
            <option value={30}>30 minutes</option>
            <option value={60}>1 hour</option>
            <option value={240}>4 hours</option>
            <option value={1440}>24 hours</option>
          </select>
        </Field>
        <DialogError error={error} />
      </form>
    </Modal>
  );
}

function AttentionRow({ item, currentUserId, busyAction, onQuickAction, onResolve, onSuppress }) {
  const status = item.status;
  const busy = busyAction?.id === item.id;
  const isMine = Boolean(item.owner_user_id && item.owner_user_id === currentUserId);

  return (
    <li className="flex flex-col gap-3 py-4 text-sm lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <SeverityBadge value={item.severity} />
          <AttentionStatusBadge value={item.status} />
          {item.occurrence_count > 1 && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500" title="Times this signal has fired">
              ×{item.occurrence_count}
            </span>
          )}
        </div>
        <p className="mt-1.5 font-semibold text-slate-800">{item.title}</p>
        <p className="mt-0.5 text-xs text-slate-500">
          {item.source_key} · opened {formatDateTime(item.opened_at)}
          {item.owner_user_id ? ` · owner: ${isMine ? "you" : `user #${item.owner_user_id}`}` : " · unassigned"}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-1.5">
        {ATTENTION_ACTIONS.acknowledge.includes(status) && (
          <Button size="sm" variant="secondary" icon={CheckCircle2} loading={busy && busyAction.key === "ack"} disabled={busy}
            onClick={() => onQuickAction(item, "ack", () => acknowledgeAttentionItem(item.id), "Acknowledged")}>
            Acknowledge
          </Button>
        )}
        {ATTENTION_ACTIONS.assign.includes(status) && currentUserId && !isMine && (
          <Button size="sm" variant="secondary" icon={UserPlus} loading={busy && busyAction.key === "assign"} disabled={busy}
            onClick={() => onQuickAction(item, "assign", () => assignAttentionItem(item.id, currentUserId), "Assigned to you")}>
            Assign to me
          </Button>
        )}
        {ATTENTION_ACTIONS.mitigate.includes(status) && (
          <Button size="sm" variant="secondary" icon={ArrowRightCircle} loading={busy && busyAction.key === "mitigate"} disabled={busy}
            onClick={() => onQuickAction(item, "mitigate", () => transitionAttentionItem(item.id, "mitigating"), "Marked as mitigating")}>
            Start mitigating
          </Button>
        )}
        {ATTENTION_ACTIONS.monitor.includes(status) && (
          <Button size="sm" variant="secondary" icon={Eye} loading={busy && busyAction.key === "monitor"} disabled={busy}
            onClick={() => onQuickAction(item, "monitor", () => transitionAttentionItem(item.id, "monitoring"), "Moved to monitoring")}>
            Monitor
          </Button>
        )}
        {ATTENTION_ACTIONS.resolve.includes(status) && (
          <Button size="sm" variant="primary" icon={CheckCircle2} disabled={busy} onClick={() => onResolve(item)}>
            Resolve
          </Button>
        )}
        {ATTENTION_ACTIONS.suppress.includes(status) && (
          <Button size="sm" variant="ghost" icon={BellOff} disabled={busy} onClick={() => onSuppress(item)}>
            Suppress
          </Button>
        )}
      </div>
    </li>
  );
}

// ZB-SA-CMD-003 §18 — the one real Domain B circuit breaker implemented so
// far. Toggling requires a reason every time (both pause and resume).
// Engaging (pausing) additionally requires an incident reference: the server
// rejects an engage without one, because a platform-wide invoice stop is only
// defensible when it is tied to a tracked incident.
function BreakerToggleModal({ open, onClose, targetEnabled, onSubmit }) {
  const [reason, setReason] = useState("");
  const [incidentReference, setIncidentReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const engaging = targetEnabled === false;
  const needsReference = engaging;

  useEffect(() => {
    if (open) { setReason(""); setIncidentReference(""); setError(null); }
  }, [open]);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason, incidentReference.trim());
      onClose();
    } catch (err) {
      setError(err?.message || "Failed to update the circuit breaker.");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    Boolean(reason.trim()) &&
    (!needsReference || incidentReference.trim().length > 0);

  return (
    <Modal open={open} onClose={onClose} title={targetEnabled ? "Resume invoice finalization?" : "Pause invoice finalization?"} icon={targetEnabled ? Power : ShieldAlert} size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="breaker-toggle-form" variant={targetEnabled ? "primary" : "danger"} loading={busy} disabled={!canSubmit}>
            {targetEnabled ? "Resume" : "Pause"}
          </Button>
        </>
      }
    >
      <form id="breaker-toggle-form" onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-slate-600">
          {targetEnabled
            ? "Tenants across the platform will be able to finalize invoices again."
            : "This immediately blocks ALL tenants from finalizing new invoices platform-wide. Already-issued invoices are unaffected."}
        </p>
        <Field label="Reason" htmlFor="breaker-reason" required hint="Required for the audit record.">
          <textarea id="breaker-reason" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100" />
        </Field>
        {needsReference && (
          <Field
            label="Incident reference"
            htmlFor="breaker-incident"
            required
            hint="Required to engage a platform-wide breaker. Links this stop to a tracked incident."
          >
            <input
              id="breaker-incident"
              required
              maxLength={100}
              value={incidentReference}
              onChange={(e) => setIncidentReference(e.target.value)}
              placeholder="INC-2026-014"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
            />
          </Field>
        )}
        {error && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <p>{error}</p>
          </div>
        )}
      </form>
    </Modal>
  );
}

function CircuitBreakerCard() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [modalTarget, setModalTarget] = useState(null);
  const load = useCallback(() => {
    setError(null);
    getInvoiceFinalizationBreaker().then(setState).catch((e) => setError(e?.message || "Failed to load."));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function handleSubmit(reason, incidentReference) {
    const updated = await setInvoiceFinalizationBreaker(modalTarget, reason, incidentReference);
    setState(updated);
  }

  return (
    <SectionCard
      variant="hero"
      accent="slate"
      icon={Power}
      title="Circuit Breakers"
      description="Real, server-enforced platform-wide controls. Every change requires a reason and is audited."
    >
      {error ? (
        <ErrorState message={error} onRetry={load} title="Unable to load breaker state" />
      ) : !state ? (
        <Spinner />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Invoice Finalization</p>
              <p className={`text-lg font-extrabold ${state.enabled ? "text-emerald-700" : "text-red-600"}`}>
                {state.enabled ? "Enabled" : "Paused"}
              </p>
              {state.reason && <p className="text-xs text-slate-500">Last reason: {state.reason}</p>}
            </div>
            <Button
              variant={state.enabled ? "danger" : "primary"}
              icon={state.enabled ? ShieldAlert : Power}
              onClick={() => setModalTarget(!state.enabled)}
            >
              {state.enabled ? "Pause" : "Resume"}
            </Button>
          </div>
        </>
      )}
      <BreakerToggleModal
        open={modalTarget !== null}
        targetEnabled={modalTarget}
        onClose={() => setModalTarget(null)}
        onSubmit={handleSubmit}
      />
    </SectionCard>
  );
}

const SEVERITY_FILTERS = [
  { key: "all", label: "All" },
  { key: "p0", label: "P0" },
  { key: "p1", label: "P1" },
  { key: "p2", label: "P2" },
  { key: "p3", label: "P3" },
];

export default function GovernancePage({ embedded = false } = {}) {
  const { user } = useAuth();
  const { activeGrant, attentionCounts, refresh: refreshShell } = useCommandCenter();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [busyAction, setBusyAction] = useState(null);
  const [resolveItem, setResolveItem] = useState(null);
  const [suppressItem, setSuppressItem] = useState(null);
  const [severity, setSeverity] = useState("all");
  const [mineOnly, setMineOnly] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listAttentionItems()
      .then((res) => setItems(res.items || []))
      .catch((e) => setError(e?.message || "Failed to load the Attention queue."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Success notices clear themselves; errors stay until dismissed.
  useEffect(() => {
    if (!notice) return undefined;
    const id = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(id);
  }, [notice]);

  const afterChange = (message) => {
    setNotice(message);
    load();
    refreshShell?.();
  };

  // A failed action is reported above the queue; it no longer replaces the
  // queue itself with a load-error screen (the queue loaded fine).
  async function handleQuickAction(item, key, run, successLabel) {
    setBusyAction({ id: item.id, key });
    setActionError(null);
    try {
      await run();
      afterChange(`${successLabel}: ${item.title}`);
    } catch (e) {
      setActionError(e?.message || "The action failed. Please try again.");
    } finally {
      setBusyAction(null);
    }
  }

  const visibleItems = useMemo(
    () =>
      items.filter(
        (item) =>
          (severity === "all" || item.severity === severity) &&
          (!mineOnly || (user?.id && item.owner_user_id === user.id))
      ),
    [items, severity, mineOnly, user?.id]
  );

  const severityCounts = useMemo(() => {
    const tally = { all: items.length, p0: 0, p1: 0, p2: 0, p3: 0 };
    for (const item of items) if (item.severity in tally) tally[item.severity] += 1;
    return tally;
  }, [items]);

  const openCount = attentionCounts?.total_open ?? items.length;
  const breachCount = attentionCounts?.sla_breaches ?? 0;

  return (
    <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
      {!embedded && (
        <PageHeader
          title="Governance"
          description="Approval, audit and evidence integrity, privileged access, and the Attention/incident queue — cross-cutting oversight, not a financial view."
          icon={ShieldCheck}
          accent="slate"
        />
      )}

      <div className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${embedded ? "lg:grid-cols-3" : "mt-6 lg:grid-cols-4"}`}>
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Open attention items</p>
          <p className={`mt-1 text-2xl font-extrabold ${openCount > 0 ? "text-slate-900" : "text-emerald-700"}`}>{openCount}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">SLA breaches</p>
          <p className={`mt-1 text-2xl font-extrabold ${breachCount > 0 ? "text-red-600" : "text-slate-900"}`}>{breachCount}</p>
        </div>
        {/* When embedded, the hub around this page IS Audit & Evidence, so a
            card linking back to it would only reload the current page. */}
        {!embedded && (
          <Link to="/super-admin/audit-logs" className="rounded-2xl border border-slate-200 bg-white p-5 transition hover:border-brand-300 hover:shadow-sm">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500"><ScrollText size={14} /> Audit & Evidence</p>
            <p className="mt-1 text-sm font-semibold text-slate-800">Platform audit trail →</p>
          </Link>
        )}
        <Link to="/super-admin/support-access" className="rounded-2xl border border-slate-200 bg-white p-5 transition hover:border-brand-300 hover:shadow-sm">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500"><KeyRound size={14} /> Privileged sessions</p>
          <p className="mt-1 text-sm font-semibold text-slate-800">
            {activeGrant ? "You have an active session" : "No active session"} →
          </p>
        </Link>
      </div>

      {notice && <div className="mt-4"><SuccessMessage message={notice} onDismiss={() => setNotice(null)} /></div>}

      <div className="mt-6">
        <CircuitBreakerCard />
      </div>

      <SectionCard
        variant="standard"
        accent="slate"
        title="Attention Queue"
        description="Real signals only — job failures and safety-control changes report here automatically."
        actions={
          <Button size="sm" variant="ghost" icon={RefreshCw} loading={loading} onClick={load}>
            Refresh
          </Button>
        }
        className="mt-6"
      >
        {actionError && (
          <div role="alert" className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>{actionError}</span>
            <button type="button" onClick={() => setActionError(null)} className="shrink-0 text-xs font-semibold hover:text-red-900">
              Dismiss
            </button>
          </div>
        )}

        {loading && items.length === 0 ? (
          <Spinner />
        ) : error ? (
          <ErrorState message={error} onRetry={load} title="Unable to load the Attention queue" />
        ) : items.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="No open attention items" message="Real signals only: job failures and safety-control state changes report here automatically. Nothing is fabricated for demonstration." />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by severity">
                {SEVERITY_FILTERS.map((f) => {
                  const active = severity === f.key;
                  return (
                    <button
                      key={f.key}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setSeverity(f.key)}
                      className={`rounded-full border px-3 py-1 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 ${
                        active ? "border-slate-800 bg-slate-800 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                      }`}
                    >
                      {f.label} <span className="ml-1 opacity-70">{severityCounts[f.key]}</span>
                    </button>
                  );
                })}
              </div>
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-600">
                <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
                Assigned to me
              </label>
            </div>
            {visibleItems.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-500">No items match these filters.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {visibleItems.map((item) => (
                  <AttentionRow
                    key={item.id}
                    item={item}
                    currentUserId={user?.id}
                    busyAction={busyAction}
                    onQuickAction={handleQuickAction}
                    onResolve={setResolveItem}
                    onSuppress={setSuppressItem}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </SectionCard>

      <ResolveModal
        open={Boolean(resolveItem)}
        item={resolveItem}
        onClose={() => setResolveItem(null)}
        onSubmit={async (code) => {
          const target = resolveItem;
          await transitionAttentionItem(target.id, "resolved", code);
          afterChange(`Resolved: ${target.title}`);
        }}
      />
      <SuppressModal
        open={Boolean(suppressItem)}
        item={suppressItem}
        onClose={() => setSuppressItem(null)}
        onSubmit={async (reason, minutes) => {
          const target = suppressItem;
          await suppressAttentionItem(target.id, reason, minutes);
          afterChange(`Suppressed: ${target.title}`);
        }}
      />
    </div>
  );
}
