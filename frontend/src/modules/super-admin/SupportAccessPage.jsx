import React, { useCallback, useEffect, useState } from "react";
import { useSearchParams, useLocation } from "react-router-dom";
import { ShieldAlert, KeyRound, Users, CreditCard, Repeat, History, LogOut } from "lucide-react";
import {
  requestPrivilegedAccess,
  activatePrivilegedAccess,
  getActivePrivilegedAccess,
  listMyPrivilegedAccess,
  getPrivilegedAccessTenantSummary,
  searchOrganizations,
  exitPrivilegedAccess,
} from "../../service/privilegedAccessService";
import { PageHeader, Modal, Field, Button, SearchInput } from "../../components/billing-ui";
import { ErrorState, Spinner, SuccessMessage, StatusBadge, EmptyState, useConfirmationDialog } from "../../components/billing-shared";
import useIsDesktopViewport from "../../hooks/useIsDesktopViewport";
import MobileWriteBlock from "./MobileWriteBlock";
import { formatDateTime } from "./constants";
import { useCommandCenter } from "../../context/CommandCenterContext";

const GRANT_STATUS_OPTIONS = [
  { value: "pending_step_up", label: "Pending Step-Up", color: "bg-amber-100 text-amber-700" },
  { value: "active", label: "Active", color: "bg-emerald-100 text-emerald-700" },
  { value: "exited", label: "Exited", color: "bg-slate-100 text-slate-600" },
  { value: "expired", label: "Expired", color: "bg-slate-100 text-slate-600" },
  { value: "denied", label: "Denied", color: "bg-red-100 text-red-700" },
];

function GrantStatusBadge({ value }) {
  return <StatusBadge status={value} options={GRANT_STATUS_OPTIONS} />;
}

// ── Step 1: request access (select tenant + reason + ticket + duration) ──
function RequestAccessModal({ open, onClose, onRequested, initialOrgCode = "" }) {
  const [query, setQuery] = useState("");
  const [orgs, setOrgs] = useState([]);
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [reason, setReason] = useState("");
  const [ticket, setTicket] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setOrgs([]);
      setSelectedOrg(null);
      setReason("");
      setTicket("");
      setMinutes(30);
      setError(null);
    }
  }, [open]);

  // A deep-linked ?organization={code} (e.g. from an organization's Support
  // Access History card) seeds the search and auto-selects the exact match.
  useEffect(() => {
    if (!open || selectedOrg) return;
    const effectiveQuery = query || initialOrgCode;
    setSearching(true);
    searchOrganizations(effectiveQuery)
      .then((res) => {
        const list = res.organizations || [];
        setOrgs(list);
        if (initialOrgCode && !selectedOrg) {
          const match = list.find(
            (o) => (o.organization_code || "").toLowerCase() === initialOrgCode.toLowerCase()
          );
          if (match) setSelectedOrg(match);
        }
      })
      .catch(() => setOrgs([]))
      .finally(() => setSearching(false));
  }, [open, query, initialOrgCode, selectedOrg]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!selectedOrg) return;
    setBusy(true);
    setError(null);
    try {
      const grant = await requestPrivilegedAccess({
        organization_id: selectedOrg.id,
        reason,
        ticket_reference: ticket,
        requested_minutes: minutes,
      });
      onRequested(grant);
    } catch (err) {
      setError(err?.message || "Failed to request tenant support access.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Request tenant support access" icon={ShieldAlert} size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-slate-600">
          Just-in-time, tenant-scoped, read-only access to one organization's billing summary. Requires a fresh
          MFA step-up, expires automatically, and is fully audited.
        </p>

        <Field label="Tenant" required hint="Search by organization name or code.">
          {selectedOrg ? (
            <div className="flex items-center justify-between rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm">
              <span className="font-semibold text-slate-800">
                {selectedOrg.organization_name} <span className="text-slate-500">({selectedOrg.organization_code})</span>
              </span>
              <button type="button" className="text-xs font-medium text-brand-600" onClick={() => setSelectedOrg(null)}>
                Change
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <SearchInput value={query} onChange={setQuery} placeholder="Search organizations…" />
              <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-200">
                {searching ? (
                  <div className="p-3"><Spinner /></div>
                ) : orgs.length === 0 ? (
                  <p className="p-3 text-xs text-slate-500">No matching organizations.</p>
                ) : (
                  orgs.map((org) => (
                    <button
                      type="button"
                      key={org.id}
                      onClick={() => setSelectedOrg(org)}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50"
                    >
                      <span>{org.organization_name}</span>
                      <span className="text-xs text-slate-500">{org.organization_code}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </Field>

        <Field label="Business reason" htmlFor="pa-reason" required hint="Required for the audit record.">
          <textarea
            id="pa-reason"
            required
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>

        <Field label="Ticket / incident reference" htmlFor="pa-ticket" required>
          <input
            id="pa-ticket"
            required
            value={ticket}
            onChange={(e) => setTicket(e.target.value)}
            placeholder="INC-1234"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>

        <Field label="Duration" htmlFor="pa-minutes" hint="Maximum 30 minutes; auto-expires, never renews silently.">
          <select
            id="pa-minutes"
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          >
            <option value={5}>5 minutes</option>
            <option value={15}>15 minutes</option>
            <option value={30}>30 minutes</option>
          </select>
        </Field>

        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="danger" loading={busy} disabled={!selectedOrg || !reason || !ticket}>
            Continue to step-up
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Step 2: MFA step-up to activate the pending grant ──────────────────
function StepUpModal({ open, grant, onClose, onActivated }) {
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setCode("");
      setRecoveryCode("");
      setUseRecovery(false);
      setError(null);
    }
  }, [open]);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = useRecovery ? { recovery_code: recoveryCode.trim() } : { code };
      const updated = await activatePrivilegedAccess(grant.id, payload);
      onActivated(updated);
    } catch (err) {
      setError(err?.message || "Step-up verification failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!grant) return null;

  return (
    <Modal open={open} onClose={onClose} title="MFA step-up required" icon={KeyRound} size="sm" closeOnBackdrop={false}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-slate-600">
          Confirm a fresh verification code to activate access to{" "}
          <strong>{grant.organization_name}</strong>. This grant expires 5 minutes after the request if not
          activated.
        </p>
        {!useRecovery ? (
          <Field label="6-digit authenticator code" htmlFor="pa-stepup-code" required>
            <input
              id="pa-stepup-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))}
              placeholder="123456"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-center text-lg tracking-widest focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
            />
          </Field>
        ) : (
          <Field label="Recovery code" htmlFor="pa-stepup-recovery" required>
            <input
              id="pa-stepup-recovery"
              autoFocus
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
            />
          </Field>
        )}
        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            className="text-xs font-medium text-brand-600"
            onClick={() => { setUseRecovery((v) => !v); setError(null); }}
          >
            {useRecovery ? "Use authenticator code instead" : "Use a recovery code instead"}
          </button>
          <Button
            type="submit"
            variant="danger"
            loading={busy}
            disabled={useRecovery ? !recoveryCode : code.length < 6}
          >
            Activate access
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Active session: persistent tenant-context chrome + read-only summary ──
function TenantSummaryPanel({ grant }) {
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState(null);

  useEffect(() => {
    getPrivilegedAccessTenantSummary(grant.id)
      .then(setSummary)
      .catch((err) => setSummaryError(err?.message || "Failed to load the tenant summary."));
  }, [grant.id]);

  const customer = summary?.customer_summary || {};
  const subscription = summary?.subscription_summary || {};
  const invoice = summary?.invoice_summary || {};

  return (
    <div className="space-y-4">
      {summaryError ? (
        <ErrorState message={summaryError} title="Unable to load tenant summary" />
      ) : !summary ? (
        <Spinner />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-600">
              <Users size={14} /> Tenant Customers
            </p>
            <p className="mt-1 text-2xl font-extrabold text-slate-900">{customer.total_active_customers ?? "—"}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-600">
              <Repeat size={14} /> Tenant Subscriptions
            </p>
            <p className="mt-1 text-2xl font-extrabold text-slate-900">{subscription.total_active_subscriptions ?? "—"}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-600">
              <CreditCard size={14} /> Tenant Invoices by Status
            </p>
            <div className="mt-2 space-y-1 text-xs text-slate-600">
              {Object.keys(invoice).length === 0 ? (
                <span className="text-slate-500">No invoice data.</span>
              ) : (
                Object.entries(invoice).map(([status, value]) => (
                  <div key={status} className="flex items-center justify-between">
                    <span className="capitalize">{status.replace(/_/g, " ")}</span>
                    <span className="font-semibold text-slate-800">
                      {typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SupportAccessPage() {
  const { activeGrant, refresh: refreshShell } = useCommandCenter();
  const location = useLocation();
  // Same workflow, reached from two sidebar labels ("Support Access" and
  // "Privileged Sessions" under Governance & Security) — only the heading
  // changes to match whichever label the operator clicked.
  const pageTitle =
    location.pathname === "/super-admin/governance/privileged-sessions"
      ? "Privileged Sessions"
      : "Support Access";
  const [searchParams] = useSearchParams();
  const deepLinkOrgCode = searchParams.get("organization") || "";
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [showRequest, setShowRequest] = useState(false);
  const [pendingGrant, setPendingGrant] = useState(null); // awaiting step-up (page-local: not shell chrome)
  const [exiting, setExiting] = useState(false);
  const { confirm, ConfirmationDialog } = useConfirmationDialog();
  // ZB-SA-CMD-003 §17 — privileged-access request/activation are privileged
  // writes and are blocked below the 768px desktop floor.
  const isDesktop = useIsDesktopViewport();

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    // The shared shell context only tracks ACTIVE grants (that's all the
    // persistent banner needs); this page additionally resumes an
    // in-progress PENDING_STEP_UP request across a reload.
    Promise.all([getActivePrivilegedAccess(), listMyPrivilegedAccess()])
      .then(([active, historyRes]) => {
        setHistory(historyRes.grants || []);
        setPendingGrant(active && active.status === "pending_step_up" ? active : null);
      })
      .catch((e) => setError(e?.message || "Failed to load privileged access state."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function handleRequested(grant) {
    setShowRequest(false);
    setPendingGrant(grant);
  }

  function handleActivated(grant) {
    setPendingGrant(null);
    setNotice(`Privileged access to ${grant.organization_name} is now active.`);
    refreshShell();
    load();
  }

  async function handleExit() {
    if (!activeGrant) return;
    const ok = await confirm({
      title: "Exit privileged access?",
      message:
        `This ends the active read-only session into ${activeGrant.organization_name} immediately. ` +
        "The exit is recorded in the platform audit trail with a correlation id.",
      confirmLabel: "Exit now",
      tone: "danger",
    });
    if (!ok) return;
    setExiting(true);
    setError(null);
    try {
      await exitPrivilegedAccess(activeGrant.id);
      setNotice(`Privileged access to ${activeGrant.organization_name} has been exited.`);
      refreshShell();
      load();
    } catch (e) {
      setError(e?.message || "Failed to exit privileged access.");
    } finally {
      setExiting(false);
    }
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title={pageTitle}
        description="Just-in-time, tenant-scoped, MFA-protected privileged access to a tenant's read-only billing summary (Domain B). Default off — no standing access exists."
        icon={ShieldAlert}
        actions={
          activeGrant ? (
            isDesktop ? (
              <Button variant="secondary" icon={LogOut} loading={exiting} onClick={handleExit}>
                Exit session
              </Button>
            ) : (
              <MobileWriteBlock action="exiting a privileged access session" />
            )
          ) : !pendingGrant ? (
            isDesktop ? (
              <Button variant="danger" icon={ShieldAlert} onClick={() => setShowRequest(true)}>
                Request tenant support access
              </Button>
            ) : (
              <MobileWriteBlock action="requesting tenant support access" />
            )
          ) : null
        }
      />

      {notice && <div className="mt-4"><SuccessMessage message={notice} onDismiss={() => setNotice(null)} /></div>}

      <div className="mt-6 space-y-6">
        {loading ? (
          <Spinner />
        ) : error ? (
          <ErrorState message={error} onRetry={load} title="Unable to load support access" />
        ) : activeGrant ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4">
              <div>
                <p className="text-sm font-bold text-slate-800">
                  Active session · {activeGrant.organization_name}
                  <span className="ml-2 text-xs font-medium text-slate-500">({activeGrant.organization_code})</span>
                </p>
                <p className="mt-0.5 text-xs text-slate-600">
                  Ticket {activeGrant.ticket_reference} · expires {formatDateTime(activeGrant.expires_at)} · read-only financial summary scope
                </p>
              </div>
              <GrantStatusBadge value={activeGrant.status} />
            </div>
            <TenantSummaryPanel grant={activeGrant} />
          </>
        ) : (
          <EmptyState
            icon={ShieldAlert}
            title="No active privileged access session"
            message="Requesting access creates a time-boxed, audited grant into exactly one tenant's read-only billing summary."
          />
        )}

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
          <p className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-700">
            <History size={16} /> My Access History
          </p>
          {history.length === 0 ? (
            <p className="text-xs text-slate-500">No privileged access requests yet.</p>
          ) : (
            <div className="space-y-2">
              {history.map((g) => (
                <div key={g.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 py-2 text-sm last:border-0">
                  <div>
                    <span className="font-semibold text-slate-800">{g.organization_name}</span>
                    <span className="ml-2 text-xs text-slate-500">{g.ticket_reference}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-slate-500">{formatDateTime(g.requested_at)}</span>
                    <GrantStatusBadge value={g.status} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <RequestAccessModal
        open={showRequest}
        onClose={() => setShowRequest(false)}
        onRequested={handleRequested}
        initialOrgCode={deepLinkOrgCode}
      />
      <StepUpModal
        open={!!pendingGrant}
        grant={pendingGrant}
        onClose={() => setPendingGrant(null)}
        onActivated={handleActivated}
      />
      {ConfirmationDialog}
    </div>
  );
}
