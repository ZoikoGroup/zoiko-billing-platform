import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  ShieldCheck,
  Settings2,
  UserCheck,
  KeyRound,
  History,
  Pencil,
  GitBranch,
  ScrollText,
  LifeBuoy,
} from "lucide-react";
import {
  getCommercialOrganizationDetail,
  getOrganizationProfile,
  getOrganizationOverview,
  updateBillingClassification,
  transitionOrganizationLifecycle,
  getCommercialAccountTrialStatus,
} from "../../service/commercialService";
import { PageHeader, DataTable, Modal, Field, Select, Button } from "../../components/billing-ui";
import { StatusBadge, ErrorState, PageSkeleton, EmptyState, SuccessMessage } from "../../components/billing-shared";
import {
  ACCOUNT_STATUS_OPTIONS,
  PLAN_STATUS_OPTIONS,
  SUBSCRIPTION_STATUS_OPTIONS,
  COMMERCIAL_CLASSIFICATION_OPTIONS,
  LIFECYCLE_STATE_BADGES,
  formatDateTime,
  formatDateOnly,
  displayValue,
  formatFeatureList,
  CommercialSourceBadge,
  CommercialClassificationBadge,
  LifecycleStateBadge,
  ReadinessBadge,
} from "./constants";

// The API serializes naive UTC datetimes (no offset); without normalizing,
// the browser reads them as local time and every timestamp shifts by the
// viewer's UTC offset.
export function asUtc(value) {
  if (!value || typeof value !== "string") return value ?? null;
  if (!value.includes("T") || /([zZ]|[+-]\d{2}:?\d{2})$/.test(value)) return value;
  return `${value}Z`;
}
const fmtDateTime = (value) => formatDateTime(asUtc(value));
const fmtDate = (value) => formatDateOnly(asUtc(value));

// Plan effective_from/effective_to are calendar dates ("YYYY-MM-DD"). new Date()
// reads those as UTC midnight, which renders as the previous day anywhere west
// of UTC — build a local date from the parts instead.
export function formatCalendarDate(value) {
  const match = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return fmtDate(value);
  return formatDateOnly(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

// Lifecycle targets that block every tenant user at login (the backend's
// _ACCESS_BLOCKED_STATES) — moving into one needs an explicit acknowledgement.
const ACCESS_BLOCKING_STATES = ["suspended", "deactivating", "deactivated"];
const TRANSITION_HINTS = {
  onboarding: "Registered, setup still in progress. Users keep access.",
  active: "Fully operational. Users can sign in.",
  suspended: "Blocks every user of this organization from signing in. Records are kept and it can be reactivated.",
  deactivating: "Starts a controlled wind-down and blocks sign-in. Can still be cancelled back to Active.",
  deactivated: "Permanent: sign-in is removed for good and no further transitions are possible. History is kept.",
};

const stateLabel = (value) => LIFECYCLE_STATE_BADGES[value]?.label || String(value || "unknown").replace(/_/g, " ");

function ChangeClassificationModal({ open, onClose, currentValue, onSaved }) {
  const [value, setValue] = useState(currentValue || "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setValue(currentValue || "");
      setReason("");
      setError(null);
    }
  }, [open, currentValue]);

  // The backend treats an unchanged value as a silent no-op (no audit row), so
  // saving it would report a change that never happened.
  const unchanged = value === (currentValue || "");

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy || unchanged || !reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await onSaved(value, reason.trim());
      if (updated !== false) onClose();
    } catch (err) {
      setError(err?.message || "Failed to update billing classification.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Change billing classification" icon={ShieldCheck} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-xs text-slate-500">
          Only <strong>Commercial Standalone</strong> organizations can be charged directly for a subscription. The change is
          recorded in the platform audit trail with your reason and the time it took effect.
        </p>
        <Field label="New classification" htmlFor="new-classification" required>
          <Select id="new-classification" value={value} onChange={setValue} options={COMMERCIAL_CLASSIFICATION_OPTIONS} placeholder="Select…" />
          {unchanged && value && <p className="mt-1 text-xs text-slate-500">This is the current classification — pick a different one.</p>}
        </Field>
        <Field label="Reason" htmlFor="classification-reason" required hint="Required for the audit record.">
          <textarea
            id="classification-reason"
            required
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!value || unchanged || !reason.trim()}>Save change</Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Governed lifecycle transition modal (Phase 3C). Only targets the backend
 * reports as legal for the CURRENT state are offered — the server remains
 * the single source of truth and re-validates on submit. A documented
 * human-readable reason is mandatory; the response's correlation id links
 * the platform-audit trail entry.
 */
function LifecycleTransitionModal({ open, onClose, orgName, currentState, allowedTransitions, onSubmit }) {
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setTarget("");
      setReason("");
      setAcknowledged(false);
      setError(null);
    }
  }, [open]);

  // A new target needs its own acknowledgement.
  useEffect(() => setAcknowledged(false), [target]);

  const blocksAccess = ACCESS_BLOCKING_STATES.includes(target);
  // Mirrors the backend: min_length=3 and a non-blank reason after trimming.
  const reasonValid = reason.trim().length >= 3;
  const canSubmit = Boolean(target) && reasonValid && (!blocksAccess || acknowledged) && !busy;

  const options = useMemo(
    () =>
      (allowedTransitions || []).map((value) => ({
        value,
        label: LIFECYCLE_STATE_BADGES[value]?.label || value,
      })),
    [allowedTransitions]
  );

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(target, reason.trim());
      onClose();
    } catch (err) {
      setError(err?.message || "Transition rejected by the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Lifecycle transition" icon={GitBranch} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-xs text-slate-500">
          Current state: <strong>{stateLabel(currentState)}</strong>. Only the moves allowed from this state are listed. Each
          change is recorded in the audit trail with your reason, and tenant sign-in access follows the new state.
        </p>
        <Field label="Target state" htmlFor="lifecycle-target" required>
          {options.length > 0 ? (
            <>
              <Select id="lifecycle-target" value={target} onChange={setTarget} options={options} placeholder="Select…" />
              {target && TRANSITION_HINTS[target] && <p className="mt-1 text-xs text-slate-500">{TRANSITION_HINTS[target]}</p>}
            </>
          ) : (
            <p className="text-sm text-slate-500">This organization is in a terminal state — no further transitions are possible.</p>
          )}
        </Field>
        <Field label="Reason" htmlFor="lifecycle-reason" required hint="At least 3 characters — stored verbatim in the platform audit trail.">
          <textarea
            id="lifecycle-reason"
            required
            minLength={3}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        {blocksAccess && (
          <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-amber-300"
            />
            <span>
              <AlertTriangle size={12} className="mr-1 inline" aria-hidden="true" />
              I understand every user of <strong>{orgName}</strong> will be blocked from signing in
              {target === "deactivated" ? ", permanently" : ""}.
            </span>
          </label>
        )}
        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant={blocksAccess ? "destructive" : "primary"} loading={busy} disabled={!canSubmit}>
            {target ? `Move to ${stateLabel(target)}` : "Apply transition"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function InfoRow({ label, value, className = "" }) {
  return (
    <div className={`flex items-start justify-between gap-4 border-b border-slate-100 py-2.5 last:border-0 ${className}`}>
      <span className="shrink-0 text-xs font-medium text-slate-500">{label}</span>
      <span className="text-right text-sm font-medium text-slate-700">{value}</span>
    </div>
  );
}

function SectionCard({ icon: Icon, title, subtitle, children, action, className = "" }) {
  return (
    <div className={`rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)] ${className}`}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
            <Icon size={17} />
          </span>
          <div>
            <h2 className="text-base font-bold text-slate-800">{title}</h2>
            {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
          </div>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

// "manual" / "auto_convert" → "Manual" / "Auto convert"; null stays an honest dash.
function humanize(value) {
  if (value === null || value === undefined || value === "") return "—";
  const text = String(value).replace(/_/g, " ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const READINESS_LABELS = {
  administrator: "Administrator",
  configuration: "Billing configuration",
  billing: "Subscription",
  integration: "Integrations",
};

export default function OrganizationDetailPage() {
  const { organizationId } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState(null);      // commercial-plane view (Phase 6/9)
  const [overview, setOverview] = useState(null);  // Phase 3A/3C composed read model
  const [profile, setProfile] = useState(null);
  const [trialStatus, setTrialStatus] = useState(null);  // ZB-COM-ENT-001 Part 3 §16 trial controls
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [classificationModalOpen, setClassificationModalOpen] = useState(false);
  const [transitionModalOpen, setTransitionModalOpen] = useState(false);

  // `silent` refreshes after a mutation without swapping the page for a
  // skeleton — and a failed silent refresh is reported inline, never by
  // replacing a page whose change already succeeded with a load error.
  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      // The overview is authoritative for identity/lifecycle/users; the
      // commercial detail keeps its accepted role for subscription data;
      // the profile adds full contact fields. A missing profile or detail
      // must not blank out the page — only the overview may fail it.
      const [ov, d, p, ts] = await Promise.all([
        getOrganizationOverview(organizationId),
        getCommercialOrganizationDetail(organizationId).catch(() => null),
        getOrganizationProfile(organizationId).catch(() => null),
        getCommercialAccountTrialStatus(organizationId).catch(() => null),
      ]);
      setOverview(ov);
      setDetail(d);
      setProfile(p);
      setTrialStatus(ts);
    } catch (err) {
      if (silent) {
        setActionError(`The change was saved, but the page couldn't refresh: ${err?.message || "unknown error"}. Reload to see the latest state.`);
        return;
      }
      setError(err?.message || "Failed to load organization.");
      setOverview(null);
      setDetail(null);
      setProfile(null);
      setTrialStatus(null);
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    load();
  }, [load]);

  // Success notices dismiss themselves; the X still closes one early.
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  const orgName = overview?.organization?.organization_name || detail?.organization_name || profile?.organization_name || `Organization #${organizationId}`;
  const orgCode = overview?.organization?.organization_code || detail?.organization_code || profile?.organization_code || "—";

  const handleClassificationChange = useCallback(
    async (newClassification, reason) => {
      setActionError(null);
      try {
        await updateBillingClassification(organizationId, newClassification, reason);
        const label = COMMERCIAL_CLASSIFICATION_OPTIONS.find((o) => o.value === newClassification)?.label || newClassification;
        setNotice(`Billing classification changed to ${label}.`);
        await load({ silent: true });
      } catch (err) {
        throw new Error(err?.message || "Failed to update billing classification.");
      }
    },
    [organizationId, load]
  );

  const handleTransition = useCallback(
    async (target, reason) => {
      setActionError(null);
      try {
        const result = await transitionOrganizationLifecycle(organizationId, target, reason);
        setNotice(
          `Lifecycle changed from ${stateLabel(result?.previous_state)} to ${stateLabel(result?.current_state ?? target)}.` +
            (result?.correlation_id ? ` Audit reference: ${result.correlation_id}` : "")
        );
        await load({ silent: true });
      } catch (err) {
        throw new Error(err?.message || "Failed to apply lifecycle transition.");
      }
    },
    [organizationId, load]
  );

  const entitlements = useMemo(() => {
    const raw = detail?.entitlements || {};
    return {
      plan: raw.plan || null,
      limits: raw.limits || {},
      features: formatFeatureList(raw.features),
    };
  }, [detail]);

  if (loading) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <PageHeader title="Organization" icon={Building2} />
        <div className="mt-6"><PageSkeleton rows={8} /></div>
      </div>
    );
  }

  if (error || !overview) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <PageHeader title="Organization" icon={Building2} />
        <div className="mt-6 rounded-3xl border border-slate-200 bg-white">
          <ErrorState message={error} onRetry={() => load()} title="Unable to load organization" />
        </div>
      </div>
    );
  }

  const org = overview.organization || {};
  const readiness = overview.onboarding_readiness || {};

  const profileRow = (label, value) => <InfoRow label={label} value={displayValue(value)} />;

  const subscription = detail?.current_subscription || null;
  const plan = detail?.plan || null;
  const billingConfig = detail?.billing_configuration || null;
  const historyColumns = [
    {
      key: "plan",
      label: "Plan",
      render: (row) => (
        <span>
          <span className="block font-semibold text-slate-800">{row.plan_name}</span>
          <span className="block text-xs text-slate-500">{row.plan_code}</span>
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (row) => <StatusBadge status={row.status} options={SUBSCRIPTION_STATUS_OPTIONS} />,
    },
    {
      key: "period",
      label: "Period",
      render: (row) => (
        <span className="text-xs text-slate-600">
          {fmtDate(row.start_at)} — {fmtDate(row.end_at)}
        </span>
      ),
    },
    {
      key: "current_period",
      label: "Current Period",
      render: (row) => (
        <span className="text-xs text-slate-600">
          {fmtDate(row.current_period_start)} — {fmtDate(row.current_period_end)}
        </span>
      ),
    },
    {
      key: "created_at",
      label: "Created",
      render: (row) => <span className="text-xs text-slate-500">{fmtDateTime(row.created_at)}</span>,
    },
    {
      key: "updated_at",
      label: "Updated",
      render: (row) => <span className="text-xs text-slate-500">{fmtDateTime(row.updated_at)}</span>,
    },
  ];

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        crumbs={[
          { label: "Organizations", href: "/super-admin/organizations" },
          { label: orgCode },
        ]}
        title={orgName}
        description={`Lifecycle: ${stateLabel(overview.lifecycle_state)} · ${overview.access_blocked ? "users are blocked from signing in" : "users can sign in"}`}
        icon={Building2}
        meta={
          <span className="inline-flex items-center gap-2">
            <LifecycleStateBadge value={overview.lifecycle_state} />
            <CommercialSourceBadge value={org.billing_source} />
            <CommercialClassificationBadge value={org.billing_classification} />
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" icon={ArrowLeft} onClick={() => navigate("/super-admin/organizations")}>
              All organizations
            </Button>
            <Button
              variant="secondary"
              icon={GitBranch}
              onClick={() => setTransitionModalOpen(true)}
              disabled={(overview.allowed_transitions || []).length === 0}
              title={(overview.allowed_transitions || []).length === 0 ? "Deactivated is a final state — no further changes are possible" : undefined}
            >
              Change lifecycle
            </Button>
          </div>
        }
      />

      {notice && <div className="mt-4"><SuccessMessage message={notice} onDismiss={() => setNotice(null)} /></div>}
      {actionError && (
        <div className="mt-4 flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} className="shrink-0 text-xs font-semibold underline">Dismiss</button>
        </div>
      )}
      <ChangeClassificationModal
        open={classificationModalOpen}
        currentValue={org.billing_classification}
        onClose={() => setClassificationModalOpen(false)}
        onSaved={handleClassificationChange}
      />
      <LifecycleTransitionModal
        open={transitionModalOpen}
        onClose={() => setTransitionModalOpen(false)}
        orgName={orgName}
        currentState={overview.lifecycle_state}
        allowedTransitions={overview.allowed_transitions}
        onSubmit={handleTransition}
      />

      <div className="mt-6 space-y-6">
        {/* ── Phase 3A/3C composed overview ─────────────────────────────── */}
        <div className="grid gap-6 lg:grid-cols-3">
          <SectionCard
            icon={GitBranch}
            title="Lifecycle & Onboarding"
            subtitle={`Last recorded activity: ${org.last_activity_at ? fmtDateTime(org.last_activity_at) : "unknown"}`}
          >
            <InfoRow label="Lifecycle state" value={<LifecycleStateBadge value={overview.lifecycle_state} />} />
            <InfoRow label="User sign-in" value={overview.access_blocked ? "Blocked" : "Allowed"} />
            <InfoRow
              label="Can move to"
              value={
                (overview.allowed_transitions || []).length > 0
                  ? overview.allowed_transitions.map(stateLabel).join(", ")
                  : "Nothing — final state"
              }
            />
            <div className="mt-4 mb-2 flex flex-wrap items-center gap-2">
              {Object.entries(READINESS_LABELS).map(([key, label]) => (
                <span key={key} className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600">
                  {label}
                  <ReadinessBadge value={readiness[key]} />
                </span>
              ))}
            </div>
            {(overview.onboarding_blockers || []).length > 0 && (
              <ul className="mt-3 space-y-1.5 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800" aria-label="Onboarding blockers">
                {overview.onboarding_blockers.map((b) => (
                  <li key={b} className="flex items-start gap-1.5">• {b}</li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard icon={UserCheck} title="Administrators & Users" subtitle="Counts and real last-login evidence only">
            <InfoRow label="Users (active / total)" value={`${displayValue(overview.user_summary?.active_users)} / ${displayValue(overview.user_summary?.total_users)}`} />
            <InfoRow label="Suspended users" value={displayValue(overview.user_summary?.suspended_users)} />
            <InfoRow label="Unverified (invited)" value={displayValue(overview.user_summary?.invited_unverified)} />
            <div className="mt-3 space-y-2">
              {(overview.administrators || []).length > 0 ? (
                overview.administrators.map((a) => (
                  <div key={a.id} className="rounded-2xl border border-slate-100 bg-slate-50/60 px-3 py-2">
                    <p className="text-sm font-semibold text-slate-700">{[a.first_name, a.last_name].filter(Boolean).join(" ") || a.email}</p>
                    <p className="text-xs text-slate-500">
                      {a.email} ·{" "}
                      {a.last_login_at ? `last login ${fmtDateTime(a.last_login_at)}` : "never logged in"}
                    </p>
                  </div>
                ))
              ) : (
                <p className="text-xs text-slate-500">No organization administrators.</p>
              )}
            </div>
          </SectionCard>

          <SectionCard icon={LifeBuoy} title="Support Access History" subtitle="Privileged grants against this tenant">
            {(overview.recent_privileged_grants || []).length > 0 ? (
              <div className="space-y-2">
                {overview.recent_privileged_grants.map((g) => (
                  <div key={g.id} className="rounded-2xl border border-slate-100 bg-slate-50/60 px-3 py-2">
                    <p className="text-xs font-semibold text-slate-700">
                      {g.ticket_reference} · <StatusBadge status={g.status} options={[{ value: g.status, label: String(g.status || "unknown").replace(/_/g, " ") }]} fallbackColor="bg-slate-100 text-slate-600" />
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{g.reason}</p>
                    {g.expires_at && <p className="text-[11px] text-slate-400">{new Date(asUtc(g.expires_at)).getTime() > Date.now() ? "Expires" : "Expired"} {fmtDateTime(g.expires_at)}</p>}
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={LifeBuoy}
                title="No privileged grants"
                message="No just-in-time support access has been requested for this organization."
              />
            )}
            <button
              type="button"
              onClick={() => navigate(`/super-admin/support-access?organization=${encodeURIComponent(orgCode)}`)}
              className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-brand-600 hover:text-brand-700"
            >
              Request support access for this tenant
            </button>
          </SectionCard>
        </div>

        {/* ── Identity / classification ─────────────────────────────────── */}
        <div className="grid gap-6 lg:grid-cols-3">
          <SectionCard icon={Building2} title="Organization Identity" subtitle="Profile data (super-admin scope)" className="lg:col-span-2">
            <div className="grid gap-x-8 gap-y-0 sm:grid-cols-2">
              <div>
                {profileRow("Organization name", profile?.organization_name ?? org.organization_name)}
                {profileRow("Display name", profile?.display_name)}
                {profileRow("Legal name", profile?.legal_name)}
                {profileRow("Industry", profile?.industry)}
                {profileRow("Email", profile?.email)}
                {profileRow("Phone", profile?.phone)}
                {profileRow("Website", profile?.website)}
              </div>
              <div>
                {profileRow("Address", profile?.address)}
                {profileRow("City", profile?.city)}
                {profileRow("State", profile?.state)}
                {profileRow("Country", profile?.country ?? org.country)}
                {profileRow("Postal code", profile?.postal_code)}
                {profileRow("Currency", profile?.currency ?? org.currency)}
                {profileRow("Timezone", profile?.timezone)}
                {profileRow("Registration number", profile?.registration_number)}
                {profileRow("Tax number", profile?.tax_no)}
                {profileRow("Fiscal year", profile?.fiscal_year_start ? `${profile?.fiscal_year_start} — ${profile?.fiscal_year_end}` : "—")}
              </div>
            </div>
          </SectionCard>

          <SectionCard
            icon={ShieldCheck}
            title="Commercial Classification"
            subtitle="Billing source is server-stamped; classification is Super-Admin controlled"
            action={
              <Button size="sm" variant="secondary" icon={Pencil} onClick={() => setClassificationModalOpen(true)}>
                Change
              </Button>
            }
          >
            <InfoRow label="Billing source" value={<CommercialSourceBadge value={org.billing_source} />} />
            <InfoRow label="Classification" value={<CommercialClassificationBadge value={org.billing_classification} />} />
            <InfoRow label="Account status" value={detail?.account ? <StatusBadge status={detail.account.status} options={ACCOUNT_STATUS_OPTIONS} /> : "Not provisioned"} />
            <InfoRow
              label="Chargeable (standalone)"
              value={
                org.can_charge ? (
                  <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700">Can charge</span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">Disabled</span>
                )
              }
            />
            <InfoRow label="Account ID" value={displayValue(detail?.account?.id)} />
          </SectionCard>
        </div>

        {/* ── Platform audit history for THIS org ───────────────────────── */}
        <SectionCard icon={ScrollText} title="Platform Audit History" subtitle="Most recent super-admin events touching this organization">
          {(overview.recent_audit_events || []).length > 0 ? (
            <DataTable
              columns={[
                {
                  key: "action",
                  label: "Action",
                  render: (row) => <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">{displayValue(row.action)}</span>,
                },
                { key: "entity_type", label: "Entity", render: (row) => <span className="text-xs text-slate-600">{displayValue(row.entity_type)}{row.entity_id ? ` #${row.entity_id}` : ""}</span> },
                { key: "actor_role", label: "Actor Role", render: (row) => <span className="text-xs text-slate-600">{displayValue(row.actor_role)}</span> },
                { key: "reason", label: "Reason", render: (row) => <span className="line-clamp-2 max-w-md text-xs text-slate-600">{displayValue(row.reason)}</span> },
                { key: "correlation_id", label: "Correlation", render: (row) => <span className="font-mono text-[11px] text-slate-400">{displayValue(row.correlation_id)}</span> },
                { key: "created_at", label: "When", render: (row) => <span className="text-xs text-slate-500">{fmtDateTime(row.created_at)}</span> },
              ]}
              data={overview.recent_audit_events}
              loading={false}
              emptyTitle="No audit events"
              minWidth={760}
            />
          ) : (
            <EmptyState icon={ScrollText} title="No audit events yet" message="Super-admin actions on this organization will appear here." />
          )}
        </SectionCard>

        {/* ── Commercial plane (accepted Phases 6/9 views) ──────────────── */}
        <div className="grid gap-6 lg:grid-cols-2">
          <SectionCard icon={Settings2} title="Billing Configuration" subtitle="Operational settings (Billing module)">
            {billingConfig ? (
              <>
                <InfoRow label="Company name" value={displayValue(billingConfig.company_name)} />
                <InfoRow label="Default currency" value={displayValue(billingConfig.default_currency)} />
                <InfoRow label="Timezone" value={displayValue(billingConfig.timezone)} />
                <InfoRow label="Language" value={displayValue(billingConfig.language)} />
                <InfoRow label="Invoice prefix" value={displayValue(billingConfig.invoice_prefix)} />
                <InfoRow label="Tax number" value={displayValue(billingConfig.tax_number)} />
              </>
            ) : (
              <EmptyState
                icon={Settings2}
                title="No billing configuration"
                message="This organization has no operational billing configuration yet."
              />
            )}
          </SectionCard>

          <SectionCard icon={UserCheck} title="Commercial Subscription & Plan" subtitle="Current open subscription (if any)">
            {subscription && plan ? (
              <>
                <div className="mb-3 flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
                  <div>
                    <p className="text-base font-bold text-slate-800">{plan.plan_name}</p>
                    <p className="text-xs text-slate-500">{plan.plan_code}</p>
                  </div>
                  <StatusBadge status={subscription.status} options={SUBSCRIPTION_STATUS_OPTIONS} />
                </div>
                <InfoRow label="Plan status" value={<StatusBadge status={plan.status} options={PLAN_STATUS_OPTIONS} />} />
                <InfoRow label="Default plan" value={plan.is_default ? "Yes" : "No"} />
                <InfoRow label="Billing interval" value={displayValue(plan.billing_interval)} />
                <InfoRow label="Currency" value={displayValue(plan.currency)} />
                <InfoRow label="Price" value={plan.price_amount === null || plan.price_amount === undefined ? "—" : `${plan.currency} ${Number(plan.price_amount).toLocaleString()}`} />
                <InfoRow label="Effective" value={plan.effective_from ? `${formatCalendarDate(plan.effective_from)} — ${formatCalendarDate(plan.effective_to)}` : "—"} />
                <InfoRow label="Period" value={`${fmtDate(subscription.start_at)} — ${fmtDate(subscription.end_at)}`} />
                <InfoRow label="Current period" value={`${fmtDate(subscription.current_period_start)} — ${fmtDate(subscription.current_period_end)}`} />
                <InfoRow label="Subscription ID" value={displayValue(subscription.id)} />
              </>
            ) : (
              <EmptyState
                icon={UserCheck}
                title="No active commercial subscription"
                message="This organization has no current open subscription. Assign one from the Commercial Subscriptions page."
                actionLabel="Assign subscription"
                onAction={() => navigate("/super-admin/commercial/subscriptions")}
              />
            )}
          </SectionCard>
        </div>

        <SectionCard icon={KeyRound} title="Entitlements" subtitle="Read-only view from the current open subscription's plan">
          {entitlements.plan ? (
            <div className="grid gap-6 lg:grid-cols-2">
              <div>
                <p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-600">Limits</p>
                <InfoRow label="Max users" value={displayValue(entitlements.limits?.max_users)} />
                <InfoRow label="Max storage (GB)" value={displayValue(entitlements.limits?.max_storage_gb)} />
                <p className="mt-2 text-xs text-slate-500">
                  A dash means the limit is not set — not unlimited. These plan-level limits are informational and not
                  enforced; enforced limits are managed on the Entitlement Catalog page.
                </p>
              </div>
              <div>
                <p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-600">Features</p>
                {entitlements.features && entitlements.features.length > 0 ? (
                  entitlements.features.map(({ key, value }) => (
                    <div key={key} className="flex items-start justify-between gap-4 border-b border-slate-100 py-2.5 last:border-0">
                      <span className="text-xs font-medium text-slate-500">{key}</span>
                      <span className="text-sm font-medium text-slate-700">{displayValue(value)}</span>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-slate-500">No features declared on the current plan.</p>
                )}
              </div>
            </div>
          ) : (
            <EmptyState
              icon={KeyRound}
              title="No entitlements yet"
              message="Entitlements are resolved from the current open subscription's plan. Nothing is entitled while no open subscription exists."
            />
          )}
        </SectionCard>

        <SectionCard icon={GitBranch} title="Trial Status" subtitle="Whether a trial is running or still available, and what happens when it ends">
          {trialStatus ? (
            <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              <InfoRow
                label="Trial eligibility"
                value={trialStatus.is_trial_eligible ? "Eligible (no prior trial recorded)" : "Not eligible (already had a trial)"}
              />
              <InfoRow
                label="Subscription status"
                value={trialStatus.subscription_status ? <StatusBadge status={trialStatus.subscription_status} options={SUBSCRIPTION_STATUS_OPTIONS} /> : "No open subscription"}
              />
              <InfoRow label="Trial ends" value={trialStatus.trial_ends_at ? fmtDateTime(trialStatus.trial_ends_at) : "—"} />
              <InfoRow label="Recovery window ends" value={trialStatus.recovery_ends_at ? fmtDateTime(trialStatus.recovery_ends_at) : "—"} />
              <InfoRow label="On conversion" value={humanize(trialStatus.evaluation_conversion_policy)} />
              <InfoRow label="When the trial expires" value={humanize(trialStatus.evaluation_expiry_action)} />
              {Array.isArray(trialStatus.trial_granted_entitlements) && trialStatus.trial_granted_entitlements.length > 0 && (
                <div className="sm:col-span-2">
                  <p className="mb-1.5 mt-3 text-xs font-bold uppercase tracking-wider text-slate-600">Trial-granted entitlements (frozen at grant time)</p>
                  {trialStatus.trial_granted_entitlements.map((g) => (
                    <div key={g.key} className="flex items-center justify-between border-b border-slate-100 py-1.5 text-xs last:border-0">
                      <span className="font-mono text-slate-500">{g.key}</span>
                      <span className="font-medium text-slate-700">{typeof g.value === "boolean" ? (g.value ? "Yes" : "No") : displayValue(g.value)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-500">No trial status available for this organization.</p>
          )}
        </SectionCard>

        {detail && (
          <SectionCard icon={History} title="Subscription History" subtitle="All commercial subscriptions, including terminal ones">
            <DataTable
              columns={historyColumns}
              data={detail.subscription_history || []}
              loading={false}
              emptyTitle="No subscription history"
              emptyMessage="No commercial subscriptions have been created for this organization yet."
              minWidth={720}
            />
          </SectionCard>
        )}
      </div>
    </div>
  );
}
