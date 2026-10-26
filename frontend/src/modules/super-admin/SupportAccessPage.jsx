import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import {
  ShieldAlert,
  KeyRound,
  Users,
  CreditCard,
  Repeat,
  History,
  LogOut,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  ShieldCheck,
  AlertOctagon,
  FileCheck2,
  Radio,
  Ban,
  Check,
  Info,
  RefreshCw,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
} from "lucide-react";
import {
  requestPrivilegedAccess,
  getActivePrivilegedAccess,
  listMyPrivilegedAccess,
  getPrivilegedAccessTenantSummary,
  getSupportAccessCredentials,
  searchOrganizations,
  exitPrivilegedAccess,
  cancelPrivilegedAccess,
  listLivePrivilegedAccess,
  revokePrivilegedAccess,
  openBreakGlass,
  reviewBreakGlass,
  listPendingReviews,
} from "../../service/privilegedAccessService";
import { PageHeader, Modal, Field, Button, SearchInput, HubTabs } from "../../components/billing-ui";
import { ErrorState, Spinner, SuccessMessage, StatusBadge, EmptyState, useConfirmationDialog } from "../../components/billing-shared";
import useIsDesktopViewport from "../../hooks/useIsDesktopViewport";
import MobileWriteBlock from "./MobileWriteBlock";
import { formatDateTime } from "./constants";
import { useCommandCenter } from "../../context/CommandCenterContext";
import { useAuth } from "../../context/AuthContext";
import {
  canRequestTenantSupport,
  canRevokeTenantSupport,
  canBreakGlass,
  canReviewBreakGlass,
} from "../../config/roles";

// How often the page re-checks a request that is waiting on someone else.
const PENDING_POLL_MS = 10000;
const QUEUE_POLL_MS = 30000;
const INPUT_CLASS =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100";
const DANGER_INPUT_CLASS =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-red-300 focus:outline-none focus:ring-2 focus:ring-red-100";

const GRANT_STATUS_OPTIONS = [
  { value: "pending_approval", label: "Waiting for approval", color: "bg-amber-100 text-amber-700" },
  { value: "awaiting_tenant", label: "Waiting for tenant", color: "bg-amber-100 text-amber-700" },
  { value: "pending_step_up", label: "Pending step-up", color: "bg-amber-100 text-amber-700" },
  { value: "approved", label: "Approved — ready", color: "bg-blue-100 text-blue-700" },
  { value: "active", label: "Active", color: "bg-emerald-100 text-emerald-700" },
  { value: "revoked", label: "Revoked", color: "bg-red-100 text-red-700" },
  { value: "cancelled", label: "Cancelled", color: "bg-slate-100 text-slate-600" },
  { value: "exited", label: "Ended", color: "bg-slate-100 text-slate-600" },
  { value: "expired", label: "Expired", color: "bg-slate-100 text-slate-600" },
  { value: "expired_unused", label: "Expired (unused)", color: "bg-slate-100 text-slate-600" },
  { value: "denied", label: "Denied", color: "bg-red-100 text-red-700" },
];

// ── Time helpers ─────────────────────────────────────────────────────────
// The API serializes naive UTC datetimes (no "Z"); without this the browser
// would read them as local time and every countdown would be off by the
// viewer's UTC offset.
export function parseServerTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const text = String(value);
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(text);
  const date = new Date(hasZone ? text : `${text}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fmt(value) {
  return formatDateTime(parseServerTime(value));
}

function formatRemaining(ms) {
  if (ms <= 0) return "0:00";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function timeAgo(value) {
  const date = parseServerTime(value);
  if (!date) return "—";
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return fmt(value);
}

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Live "m:ss left" chip. Calls onElapsed once when it reaches zero. */
function Countdown({ to, prefix = "", suffix = "left", onElapsed, tone = "slate" }) {
  const now = useNow(1000);
  const target = parseServerTime(to);
  const remaining = target ? target.getTime() - now : 0;
  const firedRef = useRef(false);

  useEffect(() => {
    firedRef.current = false;
  }, [to]);

  useEffect(() => {
    if (target && remaining <= 0 && !firedRef.current && onElapsed) {
      firedRef.current = true;
      onElapsed();
    }
  }, [target, remaining, onElapsed]);

  if (!target) return null;
  const urgent = remaining < 2 * 60 * 1000;
  const colors = urgent
    ? "bg-red-100 text-red-700"
    : tone === "emerald"
      ? "bg-emerald-100 text-emerald-800"
      : tone === "blue"
        ? "bg-blue-100 text-blue-800"
        : "bg-slate-100 text-slate-700";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums ${colors}`}>
      <Clock size={12} />
      {remaining <= 0 ? "Time is up" : `${prefix}${formatRemaining(remaining)} ${suffix}`.trim()}
    </span>
  );
}

// ── Status presentation ──────────────────────────────────────────────────
function displayStatus(grant) {
  if (!grant) return null;
  if (grant.awaiting_tenant_approval) return "awaiting_tenant";
  if (grant.status === "revoked" && grant.revoked_by_user_id && grant.revoked_by_user_id === grant.requested_by_user_id) {
    return "cancelled";
  }
  return grant.status;
}

function GrantStatusBadge({ grant, value }) {
  return <StatusBadge status={value ?? displayStatus(grant)} options={GRANT_STATUS_OPTIONS} />;
}

function EmergencyBadge({ compact = false }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">
      <AlertOctagon size={12} /> {compact ? "Emergency" : "Emergency Access"}
    </span>
  );
}

function OrgLabel({ grant }) {
  return (
    <span className="min-w-0">
      <span className="font-semibold text-slate-900">{grant.organization_name || `Organization #${grant.organization_id}`}</span>
      {grant.organization_code && (
        <span className="ml-1.5 font-mono text-xs text-slate-500">{grant.organization_code}</span>
      )}
    </span>
  );
}

function grantOutcome(grant) {
  switch (displayStatus(grant)) {
    case "denied":
      return grant.approval_note ? `Denied: ${grant.approval_note}` : "Denied by an approver.";
    case "cancelled":
      return "You cancelled this request.";
    case "revoked":
      return `${grant.revoked_by_tenant ? "Revoked by the tenant administrator" : "Revoked"}${grant.revoke_reason ? `: ${grant.revoke_reason}` : "."}`;
    case "expired_unused":
      return grant.approved_at
        ? "Approved, but not activated in time."
        : "No one approved it within 60 minutes.";
    case "expired":
      return "Session reached its time limit.";
    case "exited":
      return "Session ended.";
    default:
      return null;
  }
}

// ── Progress tracker: where the current request is in the flow ─────────────
const FLOW_STEPS = [
  { key: "request", label: "Request", hint: "Tenant, reason, ticket" },
  { key: "approve", label: "Organisation approves", hint: "The tenant's org admin decides" },
  { key: "login", label: "Temporary login", hint: "User ID + password, read-only" },
  { key: "ends", label: "Auto-ends", hint: "Stops working on time" },
];

function flowStepIndex(grant, hasSession) {
  if (hasSession) return 2;
  if (!grant) return 0;
  return 1;
}

function FlowTracker({ current }) {
  return (
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Support access steps">
      {FLOW_STEPS.map((step, index) => {
        const done = index < current;
        const isCurrent = index === current;
        return (
          <li
            key={step.key}
            aria-current={isCurrent ? "step" : undefined}
            className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 ${
              isCurrent
                ? "border-brand-300 bg-brand-50"
                : done
                  ? "border-emerald-200 bg-emerald-50/60"
                  : "border-slate-200 bg-white"
            }`}
          >
            <span
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                done ? "bg-emerald-500 text-white" : isCurrent ? "bg-brand-600 text-white" : "bg-slate-200 text-slate-600"
              }`}
            >
              {done ? <Check size={12} /> : index + 1}
            </span>
            <span className="min-w-0">
              <span className={`block text-xs font-semibold ${isCurrent ? "text-brand-800" : "text-slate-700"}`}>{step.label}</span>
              <span className="block text-[11px] text-slate-500">{step.hint}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function FormError({ message }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
      {message}
    </p>
  );
}

// ── Tenant picker (shared by normal request and break-glass) ───────────────
function OrgPicker({ open, selected, onSelect, initialOrgCode = "" }) {
  const [query, setQuery] = useState("");
  const [orgs, setOrgs] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const requestIdRef = useRef(0);
  const autoPickedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setOrgs([]);
      setSearchError(null);
      autoPickedRef.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (!open || selected) return;
    const effectiveQuery = query || (!autoPickedRef.current ? initialOrgCode : "");
    const requestId = ++requestIdRef.current;
    setSearching(true);
    setSearchError(null);
    searchOrganizations(effectiveQuery)
      .then((res) => {
        if (requestId !== requestIdRef.current) return; // a newer search superseded this one
        const list = res?.organizations || [];
        setOrgs(list);
        if (initialOrgCode && !autoPickedRef.current) {
          autoPickedRef.current = true;
          const match = list.find((o) => (o.organization_code || "").toLowerCase() === initialOrgCode.toLowerCase());
          if (match) onSelect(match);
        }
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current) return;
        setOrgs([]);
        setSearchError(err?.message || "Could not search organizations.");
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setSearching(false);
      });
  }, [open, query, initialOrgCode, selected, onSelect]);

  if (selected) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm">
        <span className="min-w-0 truncate">
          <span className="font-semibold text-slate-800">{selected.display_name || selected.organization_name}</span>{" "}
          <span className="font-mono text-xs text-slate-500">{selected.organization_code}</span>
        </span>
        <button type="button" className="shrink-0 text-xs font-semibold text-brand-600 hover:underline" onClick={() => onSelect(null)}>
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <SearchInput value={query} onChange={setQuery} placeholder="Type a name or code, e.g. ACME" aria-label="Search organizations" />
      <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-200" role="listbox" aria-label="Organizations">
        {searching ? (
          <p className="flex items-center gap-2 p-3 text-xs text-slate-500">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-transparent" /> Searching…
          </p>
        ) : searchError ? (
          <p className="p-3 text-xs text-red-600">{searchError}</p>
        ) : orgs.length === 0 ? (
          <p className="p-3 text-xs text-slate-500">{query ? `No organization matches “${query}”.` : "No organizations found."}</p>
        ) : (
          orgs.map((org) => (
            <button
              type="button"
              role="option"
              aria-selected={false}
              key={org.id}
              onClick={() => onSelect(org)}
              className="flex w-full items-center justify-between gap-3 border-b border-slate-100 px-3 py-2 text-left text-sm last:border-0 hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
            >
              <span className="min-w-0 truncate">
                {org.display_name || org.organization_name}
                {org.is_active === false && <span className="ml-2 text-[11px] font-medium text-slate-400">(inactive)</span>}
              </span>
              <span className="shrink-0 font-mono text-xs text-slate-500">{org.organization_code}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ── Request access modal ───────────────────────────────────────────────────
function RequestAccessModal({ open, onClose, onRequested, initialOrgCode = "" }) {
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [reason, setReason] = useState("");
  const [ticket, setTicket] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) {
      setSelectedOrg(null);
      setReason("");
      setTicket("");
      setMinutes(30);
      setError(null);
    }
  }, [open]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!selectedOrg) return;
    setBusy(true);
    setError(null);
    try {
      const grant = await requestPrivilegedAccess({
        organization_id: selectedOrg.id,
        reason: reason.trim(),
        ticket_reference: ticket.trim(),
        requested_minutes: minutes,
      });
      onRequested(grant);
    } catch (err) {
      setError(err?.message || "Failed to request tenant support access.");
    } finally {
      setBusy(false);
    }
  }

  const ready = selectedOrg && reason.trim() && ticket.trim();

  return (
    <Modal open={open} onClose={onClose} title="Request tenant support access" icon={ShieldAlert} size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
          <Info size={14} className="mt-0.5 shrink-0 text-slate-400" />
          <p>
            You'll get <strong>read-only</strong> access to one tenant's billing summary. The tenant's organisation admin is
            emailed and must approve it. You then get a temporary read-only user ID and password for the time you
            choose. Everything is audited.
          </p>
        </div>

        <Field label="Tenant" required>
          <OrgPicker open={open} selected={selectedOrg} onSelect={setSelectedOrg} initialOrgCode={initialOrgCode} />
        </Field>

        <Field label="Why do you need access?" htmlFor="pa-reason" required hint="Shown to the approver and the tenant's admins, and kept in the audit log.">
          <textarea
            id="pa-reason"
            required
            rows={3}
            maxLength={2000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Customer reports invoice INV-1042 shows the wrong total; need to compare against their subscription."
            className={INPUT_CLASS}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Ticket / incident reference" htmlFor="pa-ticket" required>
            <input
              id="pa-ticket"
              required
              maxLength={100}
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
              placeholder="SUP-5678"
              className={INPUT_CLASS}
            />
          </Field>
          <Field label="Session length" htmlFor="pa-minutes" hint="Ends automatically.">
            <select id="pa-minutes" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={INPUT_CLASS}>
              <option value={5}>5 minutes</option>
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes (max)</option>
            </select>
          </Field>
        </div>

        <FormError message={error} />

        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" icon={ShieldAlert} loading={busy} disabled={!ready}>
            Submit request
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Break-glass modal ────────────────────────────────────────────────────
function BreakGlassModal({ open, onClose, onActivated, initialOrgCode = "" }) {
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [reason, setReason] = useState("");
  const [incidentRef, setIncidentRef] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) {
      setSelectedOrg(null);
      setReason("");
      setIncidentRef("");
      setAcknowledged(false);
      setError(null);
    }
  }, [open]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!selectedOrg) return;
    setBusy(true);
    setError(null);
    try {
      const grant = await openBreakGlass({
        organization_id: selectedOrg.id,
        reason: reason.trim(),
        incident_reference: incidentRef.trim(),
      });
      onActivated(grant);
    } catch (err) {
      setError(err?.message || "Failed to open emergency access.");
    } finally {
      setBusy(false);
    }
  }

  const ready = selectedOrg && reason.trim() && incidentRef.trim() && acknowledged;

  return (
    <Modal open={open} onClose={onClose} title="Emergency (break-glass) access" icon={AlertOctagon} size="md" closeOnBackdrop={false}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="rounded-xl border border-red-300 bg-red-50 p-3.5 text-xs leading-relaxed text-red-900">
          <p className="mb-1 flex items-center gap-1.5 font-bold uppercase tracking-wider text-red-800">
            <AlertTriangle size={14} /> Only for production emergencies
          </p>
          Skips approval and opens a 30-minute read-only session immediately. This raises a <strong>P1 security alert</strong>,
          notifies the tenant's admins, and requires an <strong>independent review within 24 hours</strong> (overdue reviews
          escalate to P0). For anything that can wait, use a normal request instead.
        </div>

        <Field label="Tenant" required>
          <OrgPicker open={open} selected={selectedOrg} onSelect={setSelectedOrg} initialOrgCode={initialOrgCode} />
        </Field>

        <Field label="What is the emergency?" htmlFor="bg-reason" required hint="Describe the outage or critical issue.">
          <textarea
            id="bg-reason"
            required
            rows={3}
            maxLength={2000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. All invoice payments for this tenant are failing in production since 09:40 UTC."
            className={DANGER_INPUT_CLASS}
          />
        </Field>

        <Field label="Incident reference" htmlFor="bg-incident" required>
          <input
            id="bg-incident"
            required
            maxLength={100}
            value={incidentRef}
            onChange={(e) => setIncidentRef(e.target.value)}
            placeholder="INC-P1-9999"
            className={DANGER_INPUT_CLASS}
          />
        </Field>

        <label className="flex cursor-pointer items-start gap-2 text-xs text-slate-700">
          <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-0.5" />
          I understand this is an emergency override that will be independently reviewed.
        </label>

        <FormError message={error} />

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="danger" icon={AlertOctagon} loading={busy} disabled={!ready}>
            Open emergency access
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Read-only tenant summary for the active session ─────────────────────────
function formatAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function StatusCounts({ counts }) {
  if (!counts || typeof counts !== "object") return null;
  const entries = Object.entries(counts).filter(([, v]) => typeof v === "number");
  if (entries.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {entries.map(([status, count]) => (
        <span key={status} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
          <span className="capitalize">{status.replace(/_/g, " ")}</span> <strong className="text-slate-800">{count}</strong>
        </span>
      ))}
    </div>
  );
}

function SummaryCard({ icon: Icon, title, children }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
        <Icon size={14} /> {title}
      </p>
      {children}
    </div>
  );
}

function TenantSummaryPanel({ grant }) {
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState(null);

  const loadSummary = useCallback(() => {
    setSummary(null);
    setSummaryError(null);
    getPrivilegedAccessTenantSummary(grant.id)
      .then(setSummary)
      .catch((err) => setSummaryError(err?.message || "Failed to load the tenant summary."));
  }, [grant.id]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  if (summaryError) return <ErrorState message={summaryError} onRetry={loadSummary} title="Unable to load tenant summary" />;
  if (!summary) return <Spinner />;

  const customer = summary.customer_summary || {};
  const subscription = summary.subscription_summary || {};
  const invoice = summary.invoice_summary || {};
  const invoiceRows = [
    ["Paid", invoice.paid_count, invoice.paid_amount],
    ["Overdue", invoice.overdue_count, invoice.overdue_amount],
    ["Sent (unpaid)", invoice.sent_count, null],
    ["Draft", invoice.draft_count, null],
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <SummaryCard icon={Users} title="Active customers">
          <p className="mt-1 text-3xl font-extrabold text-slate-900">{customer.total_active_customers ?? "—"}</p>
          <StatusCounts counts={customer.by_status} />
        </SummaryCard>
        <SummaryCard icon={Repeat} title="Active subscriptions">
          <p className="mt-1 text-3xl font-extrabold text-slate-900">{subscription.total_active_subscriptions ?? "—"}</p>
          <StatusCounts counts={subscription.by_status} />
        </SummaryCard>
        <SummaryCard icon={CreditCard} title="Invoices">
          {invoice.total_invoices === undefined ? (
            <p className="mt-2 text-xs text-slate-500">No invoice data.</p>
          ) : (
            <>
              <p className="mt-1 text-3xl font-extrabold text-slate-900">{invoice.total_invoices}</p>
              <p className="text-xs text-slate-500">Total value {formatAmount(invoice.total_amount)}</p>
              <dl className="mt-3 space-y-1 text-xs">
                {invoiceRows.map(([label, count, amount]) => (
                  <div key={label} className="flex items-center justify-between gap-2">
                    <dt className="text-slate-600">{label}</dt>
                    <dd className="font-semibold tabular-nums text-slate-800">
                      {count ?? 0}
                      {amount !== null && amount !== undefined && (
                        <span className="ml-1.5 font-normal text-slate-500">({formatAmount(amount)})</span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </SummaryCard>
      </div>
      <p className="text-[11px] text-slate-500">
        Figures come from the tenant's own billing dashboard; amounts are in the tenant's base currency. This view is
        read-only and cannot be exported.
      </p>
    </div>
  );
}

// ── Note modal used by approve / deny / revoke ─────────────────────────────
function NoteActionModal({ action, onClose, onSubmit }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setNote("");
    setError(null);
  }, [action]);

  if (!action) return null;
  const { config, grant } = action;

  async function handleSubmit(e) {
    e.preventDefault();
    if (config.noteRequired && !note.trim()) {
      setError(`${config.noteLabel} is required.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(grant, note.trim());
    } catch (err) {
      setError(err?.message || "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={config.title} icon={config.icon} size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-700">
          <OrgLabel grant={grant} />
          <p className="mt-1">
            <span className="text-slate-500">Requested by</span> {grant.requested_by_email || "another operator"} ·{" "}
            <span className="text-slate-500">Ticket</span> {grant.ticket_reference}
          </p>
          <p className="mt-1 text-slate-600">“{grant.reason}”</p>
        </div>
        <p className="text-sm text-slate-600">{config.message}</p>
        <Field label={config.noteLabel} htmlFor="action-note" required={config.noteRequired} hint={config.noteHint}>
          <textarea
            id="action-note"
            rows={3}
            maxLength={2000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={config.placeholder}
            className={INPUT_CLASS}
          />
        </Field>
        <FormError message={error} />
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            type="submit"
            variant={config.variant}
            icon={config.icon}
            loading={busy}
            disabled={config.noteRequired && !note.trim()}
          >
            {config.confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const REVOKE_CONFIG = {
  title: "Revoke support access",
  icon: Ban,
  variant: "danger",
  confirmLabel: "Revoke now",
  message: "Access ends immediately. The requester is emailed, and tenant admins are notified if the session was active.",
  noteLabel: "Reason for revoking",
  noteRequired: true,
  noteHint: "Shown to the requester and saved in the audit log.",
  placeholder: "e.g. Issue resolved via another channel.",
};

// ── Live sessions tab (revokers) ────────────────────────────────────────────
function LiveSessionsTab({ grants, loading, error, onReload, onActionCompleted, isDesktop, currentUserId }) {
  const [action, setAction] = useState(null);

  async function submit(grant, reason) {
    await revokePrivilegedAccess(grant.id, { reason });
    setAction(null);
    onActionCompleted(`Revoked access to ${grant.organization_name}.`);
  }

  if (loading && grants.length === 0) return <Spinner />;
  if (error) return <ErrorState message={error} onRetry={onReload} title="Unable to load live sessions" />;
  if (grants.length === 0) {
    return (
      <EmptyState
        icon={Radio}
        title="No live support access"
        message="Nobody currently has, or is waiting for, access to a tenant. Pending, approved and active grants appear here."
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-3 border-b border-slate-100 bg-slate-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 md:grid">
        <span>Tenant &amp; reason</span>
        <span>Operator</span>
        <span>Status</span>
        <span className="text-right">Action</span>
      </div>
      {grants.map((g) => {
        const deadline = g.status === "active" ? g.expires_at : g.activation_deadline || g.approval_expires_at;
        const isOwn = currentUserId && g.requested_by_user_id === currentUserId;
        return (
          <div
            key={g.id}
            className="grid grid-cols-1 gap-2 border-b border-slate-100 px-4 py-3 text-sm last:border-0 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center md:gap-3"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <OrgLabel grant={g} />
                {g.is_break_glass && <EmergencyBadge compact />}
              </div>
              <p className="truncate text-xs text-slate-500" title={g.reason}>
                {g.ticket_reference} · {g.reason}
              </p>
            </div>
            <div className="min-w-0 truncate text-xs text-slate-600">
              {g.requested_by_email || `User #${g.requested_by_user_id}`}
              {isOwn && <span className="ml-1 text-slate-400">(you)</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <GrantStatusBadge grant={g} />
              {deadline && <Countdown to={deadline} suffix="left" tone={g.status === "active" ? "emerald" : "slate"} onElapsed={onReload} />}
            </div>
            <div className="md:text-right">
              {isDesktop ? (
                <Button size="sm" variant="secondary" icon={Ban} onClick={() => setAction({ config: REVOKE_CONFIG, grant: g })}>
                  Revoke
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
      {!isDesktop && (
        <div className="p-4">
          <MobileWriteBlock action="revoking support access" />
        </div>
      )}
      <NoteActionModal action={action} onClose={() => setAction(null)} onSubmit={submit} />
    </div>
  );
}

// ── Break-glass reviews tab ─────────────────────────────────────────────────
function BreakGlassReviewsTab({ grants, loading, error, onReload, onActionCompleted, isDesktop }) {
  const [selectedGrant, setSelectedGrant] = useState(null);
  const [outcome, setOutcome] = useState("justified");
  const [note, setNote] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState(null);
  const now = useNow(30000);

  async function handleCompleteReview(e) {
    e.preventDefault();
    if (!selectedGrant || !note.trim()) {
      setReviewError("Review findings are required.");
      return;
    }
    setReviewBusy(true);
    setReviewError(null);
    try {
      await reviewBreakGlass(selectedGrant.id, { outcome, note: note.trim() });
      setSelectedGrant(null);
      onActionCompleted(`Review recorded for ${selectedGrant.organization_name}; the security alert is resolved.`);
    } catch (err) {
      setReviewError(err?.message || "Failed to record the review.");
    } finally {
      setReviewBusy(false);
    }
  }

  if (loading && grants.length === 0) return <Spinner />;
  if (error) return <ErrorState message={error} onRetry={onReload} title="Unable to load reviews" />;
  if (grants.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="No emergency sessions awaiting review"
        message="Every break-glass session has been reviewed. You can't review a session you opened yourself."
      />
    );
  }

  return (
    <div className="space-y-3">
      {grants.map((g) => {
        const due = parseServerTime(g.review_due_at);
        const isOverdue = due && due.getTime() < now;
        return (
          <div
            key={g.id}
            className={`rounded-2xl border p-4 shadow-sm ${isOverdue ? "border-red-400 bg-red-50/50" : "border-slate-200 bg-white"}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <OrgLabel grant={g} />
                  <EmergencyBadge compact />
                  {isOverdue && (
                    <span className="inline-flex items-center rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-extrabold uppercase text-white">
                      Overdue — P0
                    </span>
                  )}
                </div>
                <p className="text-sm text-slate-700">“{g.reason}”</p>
                <p className="text-xs text-slate-500">
                  Opened by {g.requested_by_email || "an operator"} {timeAgo(g.requested_at)} · Incident{" "}
                  <span className="font-medium text-slate-700">{g.ticket_reference}</span> · Review due{" "}
                  <span className={isOverdue ? "font-bold text-red-700" : ""}>{fmt(g.review_due_at)}</span>
                </p>
              </div>
              {isDesktop && (
                <Button
                  size="sm"
                  variant="primary"
                  icon={FileCheck2}
                  onClick={() => {
                    setSelectedGrant(g);
                    setOutcome("justified");
                    setNote("");
                    setReviewError(null);
                  }}
                >
                  Review
                </Button>
              )}
            </div>
          </div>
        );
      })}
      {!isDesktop && <MobileWriteBlock action="recording a break-glass review" />}

      <Modal open={!!selectedGrant} onClose={() => setSelectedGrant(null)} title="Review emergency access" icon={FileCheck2} size="md">
        <form onSubmit={handleCompleteReview} className="space-y-4">
          <p className="text-sm text-slate-600">
            Was the emergency access to <strong>{selectedGrant?.organization_name}</strong> justified? Your decision resolves
            the security alert and is recorded in the audit trail.
          </p>
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="sr-only">Review outcome</legend>
            {[
              { value: "justified", label: "Justified", hint: "A genuine emergency", color: "border-emerald-300 bg-emerald-50 text-emerald-800" },
              { value: "not_justified", label: "Not justified", hint: "Policy violation", color: "border-red-300 bg-red-50 text-red-800" },
            ].map((opt) => (
              <label
                key={opt.value}
                className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2.5 text-sm ${
                  outcome === opt.value ? opt.color : "border-slate-200 bg-white text-slate-700"
                }`}
              >
                <input
                  type="radio"
                  name="review-outcome"
                  value={opt.value}
                  checked={outcome === opt.value}
                  onChange={() => setOutcome(opt.value)}
                  className="mt-1"
                />
                <span>
                  <span className="block font-semibold">{opt.label}</span>
                  <span className="block text-xs opacity-80">{opt.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <Field label="Findings" htmlFor="review-note" required hint="Saved in the security audit log.">
            <textarea
              id="review-note"
              required
              rows={3}
              maxLength={2000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Did the incident warrant bypassing approval? Note anything unusual."
              className={INPUT_CLASS}
            />
          </Field>
          <FormError message={reviewError} />
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => setSelectedGrant(null)} disabled={reviewBusy}>Cancel</Button>
            <Button type="submit" variant="primary" loading={reviewBusy} disabled={!note.trim()}>Submit review</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// ── "My access" tab ─────────────────────────────────────────────────────────
function PendingRequestCard({ grant, cancelling, onCancel, onRefresh, isDesktop }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Clock size={16} className="text-amber-600" />
            <h3 className="text-sm font-bold text-slate-900">Waiting for {grant.organization_name} to approve</h3>
            <GrantStatusBadge grant={grant} />
          </div>
          <p className="mt-1.5 text-xs text-amber-900">
            The organisation's admins have been emailed. As soon as one of them approves, your temporary user ID and
            password appear here — this page checks automatically.
          </p>
          <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-slate-700 sm:grid-cols-2">
            <div><dt className="inline text-slate-500">Tenant: </dt><dd className="inline font-medium">{grant.organization_name} {grant.organization_code && `(${grant.organization_code})`}</dd></div>
            <div><dt className="inline text-slate-500">Ticket: </dt><dd className="inline font-medium">{grant.ticket_reference}</dd></div>
            <div><dt className="inline text-slate-500">Access length: </dt><dd className="inline font-medium">{grant.requested_minutes} min</dd></div>
            <div><dt className="inline text-slate-500">Requested: </dt><dd className="inline font-medium">{fmt(grant.requested_at)}</dd></div>
            <div className="sm:col-span-2"><dt className="inline text-slate-500">Reason: </dt><dd className="inline">{grant.reason}</dd></div>
          </dl>
        </div>
        <div className="flex flex-col items-end gap-2">
          {grant.approval_expires_at && (
            <Countdown to={grant.approval_expires_at} prefix="Request expires in " suffix="" onElapsed={onRefresh} />
          )}
          {isDesktop ? (
            <Button size="sm" variant="secondary" loading={cancelling} onClick={onCancel}>
              Cancel Request
            </Button>
          ) : (
            <MobileWriteBlock action="cancelling support access" />
          )}
          <button type="button" onClick={onRefresh} className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-slate-700">
            <RefreshCw size={11} /> Check now
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Temporary login issued on approval ──────────────────────────────────
function CopyField({ label, value, secret = false }) {
  const [shown, setShown] = useState(!secret);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setShown(true); // clipboard blocked: at least let them select it
    }
  }

  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <div className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-900" title={shown ? value : undefined}>
          {shown ? value : "•".repeat(Math.min(value.length, 16))}
        </code>
        {secret && (
          <button
            type="button"
            onClick={() => setShown((v) => !v)}
            className="rounded-lg border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-50"
            aria-label={shown ? `Hide ${label}` : `Show ${label}`}
          >
            {shown ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        )}
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function CredentialsPanel({ grant }) {
  const [creds, setCreds] = useState(null);
  const [error, setError] = useState(null);

  const loadCreds = useCallback(() => {
    setError(null);
    getSupportAccessCredentials(grant.id)
      .then(setCreds)
      .catch((err) => setError(err?.message || "Could not load the temporary login."));
  }, [grant.id]);

  useEffect(() => {
    loadCreds();
  }, [loadCreds]);

  if (error) return <ErrorState message={error} onRetry={loadCreds} title="Temporary login unavailable" />;
  if (!creds) return <Spinner />;

  return (
    <div className="rounded-2xl border border-brand-200 bg-brand-50/50 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <KeyRound size={16} className="text-brand-600" /> Your temporary login for {grant.organization_name}
          </p>
          <p className="mt-0.5 text-xs text-slate-600">
            {creds.access} access · works until {fmt(creds.expires_at)}, then stops automatically.
          </p>
        </div>
        <Countdown to={creds.expires_at} suffix="left" tone="emerald" />
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <CopyField label="User ID" value={creds.username} />
        <CopyField label="Password" value={creds.password} secret />
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
        <p className="max-w-xl">
          Open the login page in a <strong>private / incognito window</strong> and sign in with these details — signing in
          here would replace your Super Admin session.
        </p>
        <a
          href={creds.login_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-lg bg-white px-3 py-1.5 font-semibold text-brand-700 shadow-sm hover:bg-brand-50"
        >
          <ExternalLink size={13} /> Open login page
        </a>
      </div>
    </div>
  );
}

function ActiveSessionCard({ grant, exiting, onExit, onElapsed, isDesktop }) {
  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
            </span>
            <p className="text-sm font-bold text-slate-800">Active session · {grant.organization_name}</p>
            {grant.organization_code && <span className="font-mono text-xs text-slate-500">{grant.organization_code}</span>}
            {grant.is_break_glass && <EmergencyBadge />}
          </div>
          <p className="mt-1 text-xs text-slate-600">
            Ticket {grant.ticket_reference} · read-only billing summary · ends {fmt(grant.expires_at)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Countdown to={grant.expires_at} suffix="left" tone="emerald" onElapsed={onElapsed} />
          {isDesktop ? (
            <Button size="sm" variant="secondary" icon={LogOut} loading={exiting} onClick={onExit}>
              End session
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function HistoryList({ history }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-700">
        <History size={16} /> My Access History
      </p>
      {history.length === 0 ? (
        <p className="text-xs text-slate-500">You haven't requested support access yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {history.map((g) => {
            const outcome = grantOutcome(g);
            return (
              <li key={g.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <OrgLabel grant={g} />
                    <span className="text-xs text-slate-500">{g.ticket_reference}</span>
                    {g.is_break_glass && <EmergencyBadge compact />}
                  </div>
                  <p className="max-w-xl truncate text-xs text-slate-500" title={g.reason}>{g.reason}</p>
                  {outcome && <p className="text-xs text-slate-600">{outcome}</p>}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-500">{fmt(g.requested_at)}</span>
                  <GrantStatusBadge grant={g} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────
const LIVE_STATUSES = ["pending_approval", "approved", "pending_step_up"];

export default function SupportAccessPage() {
  const { activeGrant: shellGrant, refresh: refreshShell } = useCommandCenter();
  const { user } = useAuth();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkOrgCode = searchParams.get("organization") || "";

  const pageTitle =
    location.pathname === "/super-admin/governance/privileged-sessions" ? "Privileged Sessions" : "Support Access";

  const role = user?.platform_role;
  const canRequest = canRequestTenantSupport(role);
  const canRevoke = canRevokeTenantSupport(role);
  const canBreakGlassAct = canBreakGlass(role);
  const canReview = canReviewBreakGlass(role);
  const hasOwnAccess = canRequest || canBreakGlassAct;

  const isDesktop = useIsDesktopViewport();
  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  // ── My access state
  const [history, setHistory] = useState([]);
  const [liveOwn, setLiveOwn] = useState(null);
  const [loading, setLoading] = useState(hasOwnAccess);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const [showRequest, setShowRequest] = useState(false);
  const [showBreakGlass, setShowBreakGlass] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(
    ({ quiet = false } = {}) => {
      if (!hasOwnAccess) return Promise.resolve();
      if (!quiet) {
        setLoading(true);
        setError(null);
      }
      return Promise.all([getActivePrivilegedAccess(), listMyPrivilegedAccess()])
        .then(([active, historyRes]) => {
          setHistory(historyRes?.grants || []);
          setLiveOwn(active || null);
          setError(null);
        })
        .catch((e) => {
          if (!quiet) setError(e?.message || "Failed to load your support access.");
        })
        .finally(() => {
          if (!quiet) setLoading(false);
        });
    },
    [hasOwnAccess]
  );

  useEffect(() => {
    load();
  }, [load]);

  // The shell's grant drives the top banner; fall back to our own read so the
  // page is right even when the shell hasn't refreshed yet.
  const sessionGrant = shellGrant || (liveOwn?.status === "active" ? liveOwn : null);
  const pendingGrant = useMemo(() => {
    if (sessionGrant) return null;
    if (liveOwn && LIVE_STATUSES.includes(liveOwn.status)) return liveOwn;
    return history.find((g) => LIVE_STATUSES.includes(g.status)) || null;
  }, [sessionGrant, liveOwn, history]);

  // Waiting on someone else → keep checking so an approval shows up by itself.
  useEffect(() => {
    if (!pendingGrant) return undefined;
    const id = setInterval(() => load({ quiet: true }), PENDING_POLL_MS);
    return () => clearInterval(id);
  }, [pendingGrant, load]);

  // Tell the operator when the organisation approves while they wait.
  const waitingIdRef = useRef(null);
  useEffect(() => {
    if (pendingGrant) {
      waitingIdRef.current = pendingGrant.id;
    } else if (waitingIdRef.current && sessionGrant?.id === waitingIdRef.current) {
      setNotice(`${sessionGrant.organization_name} approved your request. Your temporary login is below.`);
      waitingIdRef.current = null;
    }
  }, [pendingGrant, sessionGrant]);

  // ── Queues (approvals / live / reviews) — loaded up front for tab counts
  const [live, setLive] = useState({ grants: [], loading: canRevoke, error: null });
  const [reviews, setReviews] = useState({ grants: [], loading: canReview, error: null });

  const loadQueue = useCallback((fetcher, setter, fallback) => {
    setter((s) => ({ ...s, loading: true }));
    return fetcher()
      .then((res) => setter({ grants: res?.grants || [], loading: false, error: null }))
      .catch((e) => setter((s) => ({ ...s, loading: false, error: e?.message || fallback })));
  }, []);

  const loadLive = useCallback(
    () => canRevoke && loadQueue(listLivePrivilegedAccess, setLive, "Failed to load live sessions."),
    [canRevoke, loadQueue]
  );
  const loadReviews = useCallback(
    () => canReview && loadQueue(listPendingReviews, setReviews, "Failed to load break-glass reviews."),
    [canReview, loadQueue]
  );

  const reloadAll = useCallback(() => {
    load({ quiet: true });
    loadLive();
    loadReviews();
  }, [load, loadLive, loadReviews]);

  useEffect(() => {
    loadLive();
    loadReviews();
    if (!canRevoke && !canReview) return undefined;
    const id = setInterval(() => {
        loadLive();
      loadReviews();
    }, QUEUE_POLL_MS);
    return () => clearInterval(id);
  }, [canRevoke, canReview, loadLive, loadReviews]);

  // ── Tabs
  const overdueReviews = reviews.grants.filter((g) => {
    const due = parseServerTime(g.review_due_at);
    return due && due.getTime() < Date.now();
  }).length;

  const tabs = useMemo(() => {
    const countChip = (n, urgent) =>
      n > 0 ? (
        <span className={`ml-1 rounded-full px-1.5 text-[11px] font-bold ${urgent ? "bg-red-600 text-white" : "bg-amber-100 text-amber-800"}`}>
          {n}
        </span>
      ) : null;
    const list = [];
    if (hasOwnAccess) list.push({ key: "my_access", label: "My Access", icon: ShieldAlert });
    if (canRevoke)
      list.push({ key: "live", label: <>Live Sessions{countChip(live.grants.length)}</>, icon: Radio, text: "Live Sessions" });
    if (canReview)
      list.push({
        key: "reviews",
        label: <>Break-Glass Reviews{countChip(reviews.grants.length, overdueReviews > 0)}</>,
        icon: FileCheck2,
        text: "Break-Glass Reviews",
      });
    return list;
  }, [hasOwnAccess, canRevoke, canReview, live.grants.length, reviews.grants.length, overdueReviews]);

  const requestedTab = searchParams.get("tab");
  const activeTab = tabs.some((t) => t.key === requestedTab) ? requestedTab : tabs[0]?.key;

  function selectTab(key) {
    const next = new URLSearchParams(searchParams);
    next.set("tab", key);
    setSearchParams(next, { replace: true });
  }

  // ── Actions
  function handleRequested(grant) {
    setShowRequest(false);
    setLiveOwn(grant);
    setNotice(`Request sent to ${grant.organization_name}'s admins. Your temporary login appears here once they approve.`);
    reloadAll();
  }

  function handleActivated(grant) {
    setShowBreakGlass(false);
    setLiveOwn(grant);
    setNotice(
      grant.is_break_glass
        ? `Emergency access to ${grant.organization_name} is open. A security review is now due within 24 hours.`
        : `Access to ${grant.organization_name} is open. Your temporary login is below.`
    );
    refreshShell();
    reloadAll();
  }

  async function handleCancelRequest() {
    if (!pendingGrant) return;
    const ok = await confirm({
      title: "Cancel this request?",
      message: `Your request for ${pendingGrant.organization_name} will be withdrawn. You can submit a new one at any time.`,
      confirmLabel: "Cancel request",
      tone: "danger",
    });
    if (!ok) return;
    setCancelling(true);
    setError(null);
    try {
      await cancelPrivilegedAccess(pendingGrant.id);
      setNotice("Request cancelled.");
      setLiveOwn(null);
      reloadAll();
    } catch (err) {
      setError(err?.message || "Failed to cancel the request.");
    } finally {
      setCancelling(false);
    }
  }

  async function handleExit() {
    if (!sessionGrant) return;
    const ok = await confirm({
      title: "End this session?",
      message: `Your read-only access to ${sessionGrant.organization_name} ends now. The tenant's admins are notified that it ended.`,
      confirmLabel: "End session",
      tone: "danger",
    });
    if (!ok) return;
    setExiting(true);
    setError(null);
    try {
      await exitPrivilegedAccess(sessionGrant.id);
      setNotice(`Session with ${sessionGrant.organization_name} ended.`);
      setLiveOwn(null);
      refreshShell();
      reloadAll();
    } catch (e) {
      setError(e?.message || "Failed to end the session.");
    } finally {
      setExiting(false);
    }
  }

  const handleSessionElapsed = useCallback(() => {
    setNotice("Your session reached its time limit and has ended.");
    setLiveOwn(null);
    refreshShell();
    load({ quiet: true });
  }, [refreshShell, load]);

  const handleQueueAction = useCallback(
    (msg) => {
      setNotice(msg);
      reloadAll();
    },
    [reloadAll]
  );

  // ── Header actions
  const canStartNew = hasOwnAccess && !sessionGrant && !pendingGrant;
  // An active session's "End session" lives on its own card, next to the countdown.
  let headerActions = null;
  if (canStartNew && isDesktop) {
    headerActions = (
      <div className="flex flex-wrap items-center gap-2">
        {canBreakGlassAct && (
          <Button variant="danger" icon={AlertOctagon} onClick={() => setShowBreakGlass(true)}>
            Break-Glass Access
          </Button>
        )}
        {canRequest && (
          <Button variant="primary" icon={ShieldAlert} onClick={() => setShowRequest(true)}>
            Request access
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title={pageTitle}
        description="Ask a tenant for time-limited, read-only access. Once their organisation admin approves, you get a temporary user ID and password that stop working automatically. Everything is audited."
        icon={ShieldAlert}
        actions={headerActions}
      />

      {notice && (
        <div className="mt-4">
          <SuccessMessage message={notice} onDismiss={() => setNotice(null)} />
        </div>
      )}

      {tabs.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={ShieldAlert}
            title="Your role can't use support access"
            message={`Support access is available to support operators, security operators, auditors and platform administrators. Your platform role is ${role ? role.replace(/_/g, " ") : "not set"} — ask a platform administrator if you need it.`}
          />
        </div>
      ) : (
        <>
          {tabs.length > 1 && (
            <HubTabs tabs={tabs} active={activeTab} onChange={selectTab} label="Support access sections" className="mt-6" />
          )}

          <div className="mt-6 space-y-6">
            {activeTab === "live" && (
              <LiveSessionsTab
                {...live}
                onReload={loadLive}
                onActionCompleted={handleQueueAction}
                isDesktop={isDesktop}
                currentUserId={user?.id}
              />
            )}
            {activeTab === "reviews" && (
              <BreakGlassReviewsTab
                {...reviews}
                onReload={loadReviews}
                onActionCompleted={handleQueueAction}
                isDesktop={isDesktop}
              />
            )}
            {activeTab === "my_access" && (
              <>
                {loading ? (
                  <Spinner />
                ) : error && !pendingGrant && !sessionGrant ? (
                  <ErrorState message={error} onRetry={() => load()} title="Unable to load support access" />
                ) : (
                  <>
                    {error && <FormError message={error} />}
                    {(sessionGrant || pendingGrant) && <FlowTracker current={flowStepIndex(pendingGrant, !!sessionGrant)} />}

                    {sessionGrant ? (
                      <>
                        <ActiveSessionCard
                          grant={sessionGrant}
                          exiting={exiting}
                          onExit={handleExit}
                          onElapsed={handleSessionElapsed}
                          isDesktop={isDesktop}
                        />
                        <CredentialsPanel grant={sessionGrant} />
                        <TenantSummaryPanel grant={sessionGrant} />
                      </>
                    ) : pendingGrant ? (
                      <PendingRequestCard
                        grant={pendingGrant}
                        cancelling={cancelling}
                        onCancel={handleCancelRequest}
                        onRefresh={() => load({ quiet: true })}
                        isDesktop={isDesktop}
                      />
                    ) : (
                      <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/40 p-6">
                        <div className="flex flex-col items-center text-center">
                          <ShieldAlert className="mb-3 h-9 w-9 text-slate-300" />
                          <p className="text-sm font-semibold text-slate-700">No active support session</p>
                          <p className="mt-1 max-w-md text-xs text-slate-500">
                            Need to look at a customer's billing to resolve a ticket? Request access — here's how it works:
                          </p>
                        </div>
                        <div className="mx-auto mt-5 max-w-3xl">
                          <FlowTracker current={-1} />
                        </div>
                        {isDesktop ? (
                          <div className="mt-5 flex flex-wrap justify-center gap-2">
                            {canRequest && (
                              <Button variant="primary" icon={ShieldAlert} onClick={() => setShowRequest(true)}>
                                Request access
                              </Button>
                            )}
                            {canBreakGlassAct && (
                              <Button variant="danger" icon={AlertOctagon} onClick={() => setShowBreakGlass(true)}>
                                Emergency access
                              </Button>
                            )}
                          </div>
                        ) : (
                          <div className="mt-5">
                            <MobileWriteBlock action="requesting tenant support access" />
                          </div>
                        )}
                      </div>
                    )}

                    <HistoryList history={history} />
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}

      <RequestAccessModal
        open={showRequest}
        onClose={() => setShowRequest(false)}
        onRequested={handleRequested}
        initialOrgCode={deepLinkOrgCode}
      />

      <BreakGlassModal
        open={showBreakGlass}
        onClose={() => setShowBreakGlass(false)}
        onActivated={handleActivated}
        initialOrgCode={deepLinkOrgCode}
      />

      {ConfirmationDialog}
    </div>
  );
}
