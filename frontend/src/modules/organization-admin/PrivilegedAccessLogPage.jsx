import React, { useCallback, useEffect, useState } from "react";
import { ShieldCheck, ShieldAlert, AlertOctagon, Ban, CheckCircle, XCircle, Clock, KeyRound } from "lucide-react";
import {
  getPrivilegedAccessLog,
  tenantRevokePrivilegedAccess,
  tenantApprovePrivilegedAccess,
  tenantDenyPrivilegedAccess,
} from "../../service/privilegedAccessService";
import { PageHeader, Modal, Field, Button } from "../../components/billing-ui";
import { ErrorState, Spinner, StatusBadge, EmptyState, SuccessMessage } from "../../components/billing-shared";

/**
 * ZB-SA-CMD-003 §19/§20 / ZB-SEC-PRIV-001 (PRV-02, AT-18)
 * Tenant-side support access: org admins approve or decline Zoiko support's
 * requests, see who currently has access (and with which temporary login),
 * revoke it at any time, and review the full history.
 *
 * Approving is the only way support gets in: it issues a temporary, read-only
 * login for the requested minutes, which stops working automatically.
 */

const STATUS_OPTIONS = [
  { value: "pending_approval", label: "Waiting for your approval", color: "bg-amber-100 text-amber-700" },
  { value: "active", label: "Active now", color: "bg-emerald-100 text-emerald-700" },
  { value: "revoked", label: "Revoked", color: "bg-red-100 text-red-700" },
  { value: "exited", label: "Ended by support", color: "bg-slate-100 text-slate-600" },
  { value: "expired", label: "Ended (time limit)", color: "bg-slate-100 text-slate-600" },
  { value: "expired_unused", label: "Lapsed (not approved)", color: "bg-slate-100 text-slate-600" },
  { value: "denied", label: "Declined", color: "bg-slate-100 text-slate-600" },
];

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100";

// The API sends naive UTC timestamps; read them as UTC.
function parseServerTime(value) {
  if (!value) return null;
  const text = String(value);
  const date = new Date(/([zZ]|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTime(value) {
  const date = parseServerTime(value);
  if (!date) return "—";
  return date.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function Remaining({ to, prefix }) {
  const now = useNow();
  const target = parseServerTime(to);
  if (!target) return null;
  const ms = target.getTime() - now;
  if (ms <= 0) return <span className="text-xs text-slate-500">Time is up</span>;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-slate-700">
      <Clock size={12} /> {prefix} {m}:{String(s).padStart(2, "0")}
    </span>
  );
}

function EmergencyBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">
      <AlertOctagon size={12} /> Emergency access
    </span>
  );
}

export default function PrivilegedAccessLogPage() {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);

  // One modal for approve / decline / revoke: { kind, entry }
  const [action, setAction] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  const load = useCallback(({ quiet = false } = {}) => {
    if (!quiet) {
      setLoading(true);
      setError(null);
    }
    return getPrivilegedAccessLog()
      .then((res) => setEntries(res.entries || []))
      .catch((e) => {
        if (!quiet) setError(e?.message || "Failed to load support access.");
      })
      .finally(() => {
        if (!quiet) setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Keep pending/active rows fresh (new requests, sessions ending).
  useEffect(() => {
    const id = setInterval(() => load({ quiet: true }), 20000);
    return () => clearInterval(id);
  }, [load]);

  function openAction(kind, entry) {
    setAction({ kind, entry });
    setNote("");
    setActionError(null);
  }

  async function submitAction(e) {
    e.preventDefault();
    const { kind, entry } = action;
    if (kind !== "approve" && !note.trim()) {
      setActionError("Please give a reason.");
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      if (kind === "approve") {
        await tenantApprovePrivilegedAccess(entry.id, { note: note.trim() || undefined });
        setNotice(`Approved. Zoiko support now has read-only access for ${entry.requested_minutes} minutes.`);
      } else if (kind === "deny") {
        await tenantDenyPrivilegedAccess(entry.id, { note: note.trim() });
        setNotice("Request declined. Support has been told why.");
      } else {
        await tenantRevokePrivilegedAccess(entry.id, { reason: note.trim() });
        setNotice("Access revoked. The temporary login has been switched off.");
      }
      setAction(null);
      load({ quiet: true });
    } catch (err) {
      setActionError(err?.message || "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const pending = (entries || []).filter((e) => e.status === "pending_approval");
  const active = (entries || []).filter((e) => e.status === "active");
  const history = (entries || []).filter((e) => e.status !== "pending_approval" && e.status !== "active");

  const modalConfig = {
    approve: {
      title: "Approve support access",
      icon: CheckCircle,
      variant: "primary",
      confirm: "Approve access",
      message: (entry) =>
        `Zoiko support will get a temporary, read-only login to your organisation for ${entry.requested_minutes} minutes. It stops working automatically, and you can revoke it at any time.`,
      noteLabel: "Note (optional)",
      placeholder: "e.g. Approved for ticket follow-up",
    },
    deny: {
      title: "Decline support access",
      icon: XCircle,
      variant: "danger",
      confirm: "Decline request",
      message: () => "Support won't get access. Your reason is shared with them.",
      noteLabel: "Reason",
      placeholder: "e.g. We weren't expecting this request",
    },
    revoke: {
      title: "Revoke support access",
      icon: Ban,
      variant: "danger",
      confirm: "Revoke now",
      message: () => "Access ends immediately and the temporary login is switched off.",
      noteLabel: "Reason",
      placeholder: "e.g. Issue resolved",
    },
  };
  const cfg = action ? modalConfig[action.kind] : null;

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Platform Support Access"
        description="Zoiko support can only see your billing data when an administrator of your organisation approves it. Approved access is read-only, time-limited, and can be revoked at any time."
        icon={ShieldCheck}
      />

      {notice && (
        <div className="mt-4">
          <SuccessMessage message={notice} onDismiss={() => setNotice(null)} />
        </div>
      )}

      {loading ? (
        <Spinner />
      ) : error ? (
        <ErrorState message={error} onRetry={() => load()} title="Unable to load support access" />
      ) : (
        <div className="mt-6 space-y-6">
          {/* Waiting for approval */}
          <section aria-labelledby="pending-heading">
            <h2 id="pending-heading" className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-800">
              <ShieldAlert size={16} className="text-amber-600" /> Waiting for your approval
              {pending.length > 0 && (
                <span className="rounded-full bg-amber-100 px-2 text-xs font-bold text-amber-800">{pending.length}</span>
              )}
            </h2>
            {pending.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/50 px-4 py-5 text-center text-xs text-slate-500">
                No requests right now. When Zoiko support asks for access, it appears here and your admins get an email.
              </p>
            ) : (
              <div className="space-y-3">
                {pending.map((e) => (
                  <div key={e.id} className="rounded-2xl border border-amber-200 bg-amber-50/50 p-4 shadow-sm">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-sm font-semibold text-slate-900">“{e.reason}”</p>
                        <p className="text-xs text-slate-600">
                          Support ticket <strong>{e.ticket_reference}</strong> · wants read-only access for{" "}
                          <strong>{e.requested_minutes} minutes</strong> · requested {formatDateTime(e.requested_at)}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        {e.approval_expires_at && <Remaining to={e.approval_expires_at} prefix="Lapses in" />}
                        <div className="flex gap-2">
                          <Button size="sm" variant="secondary" icon={XCircle} onClick={() => openAction("deny", e)}>
                            Decline
                          </Button>
                          <Button size="sm" variant="primary" icon={CheckCircle} onClick={() => openAction("approve", e)}>
                            Approve
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Active now */}
          {active.length > 0 && (
            <section aria-labelledby="active-heading">
              <h2 id="active-heading" className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-800">
                <KeyRound size={16} className="text-emerald-600" /> Support has access now
              </h2>
              <div className="space-y-3">
                {active.map((e) => (
                  <div key={e.id} className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-slate-900">“{e.reason}”</p>
                          {e.is_break_glass && <EmergencyBadge />}
                        </div>
                        <p className="text-xs text-slate-600">
                          Ticket {e.ticket_reference} · read-only · ends {formatDateTime(e.expires_at || e.ended_at)}
                        </p>
                        {e.support_username && (
                          <p className="text-xs text-slate-600">
                            Signed in as <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px]">{e.support_username}</code>
                          </p>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        {e.expires_at && <Remaining to={e.expires_at} prefix="Ends in" />}
                        <Button size="sm" variant="danger" icon={Ban} onClick={() => openAction("revoke", e)}>
                          Revoke now
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* History */}
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]" aria-labelledby="history-heading">
            <h2 id="history-heading" className="mb-3 text-sm font-bold text-slate-800">History</h2>
            {history.length === 0 ? (
              <EmptyState
                icon={ShieldCheck}
                title="No support access on record"
                message="Zoiko support has never accessed your organisation's billing data."
              />
            ) : (
              <ul className="divide-y divide-slate-100">
                {history.map((e) => (
                  <li key={e.correlation_id || e.id} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-slate-800">{e.reason}</p>
                        {e.is_break_glass && <EmergencyBadge />}
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        Ticket {e.ticket_reference} · requested {formatDateTime(e.requested_at)}
                        {e.requested_minutes ? ` (${e.requested_minutes} min)` : ""}
                        {e.activated_at ? ` · access ${formatDateTime(e.activated_at)} – ${formatDateTime(e.ended_at)}` : ""}
                      </p>
                      {e.decision_note && <p className="mt-0.5 text-xs text-slate-600">Note: {e.decision_note}</p>}
                    </div>
                    <StatusBadge status={e.status} options={STATUS_OPTIONS} fallbackColor="bg-slate-100 text-slate-600" />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      <Modal open={!!action} onClose={() => setAction(null)} title={cfg?.title} icon={cfg?.icon || ShieldAlert} size="md">
        {action && cfg && (
          <form onSubmit={submitAction} className="space-y-4">
            <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-700 space-y-1">
              <div><strong>Ticket:</strong> {action.entry.ticket_reference}</div>
              <div><strong>Reason given by support:</strong> {action.entry.reason}</div>
            </div>
            <p className="text-sm text-slate-600">{cfg.message(action.entry)}</p>
            <Field label={cfg.noteLabel} htmlFor="support-access-note" required={action.kind !== "approve"}>
              <textarea
                id="support-access-note"
                rows={3}
                maxLength={2000}
                value={note}
                onChange={(ev) => setNote(ev.target.value)}
                placeholder={cfg.placeholder}
                className={INPUT_CLASS}
              />
            </Field>
            {actionError && (
              <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {actionError}
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={() => setAction(null)} disabled={busy}>Cancel</Button>
              <Button
                type="submit"
                variant={cfg.variant}
                icon={cfg.icon}
                loading={busy}
                disabled={action.kind !== "approve" && !note.trim()}
              >
                {cfg.confirm}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
