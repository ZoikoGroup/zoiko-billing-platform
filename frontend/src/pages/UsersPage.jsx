import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { KeyRound, Power, UserPlus, GitBranch, Building2, Mail, Users as UsersIcon, Trash2, MoreHorizontal, X } from "lucide-react";

import { apiFetch } from "../api/client";
import { PageHeader, DataTable, ListToolbar, Select, Modal, Field, Button } from "../components/billing-ui";
import { ErrorState, SuccessMessage, Pagination, StatusBadge, DashboardChartCard, DashboardChartErrorBoundary } from "../components/billing-shared";
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { formatTrialRemaining, TrialProgressBar } from "../modules/super-admin/constants";

// This page is scoped to Organization Admins only — one tenant-facing
// administrator role per organization. Billing/finance/auditor roles are
// invited by each tenant's own org admin, and Super Admin accounts have
// their own platform-role tooling; neither belongs in this roster.
const FIXED_ROLE = "org_admin";

const STATUS_OPTIONS = [
  { value: "true", label: "Active" },
  { value: "false", label: "Inactive" },
];

function initialsOf(firstName, lastName, email) {
  const first = (firstName || "").trim();
  const last = (lastName || "").trim();
  if (first || last) return `${first[0] || ""}${last[0] || ""}`.toUpperCase();
  return (email || "?").slice(0, 2).toUpperCase();
}

// ZB-SA-P3 (Phase 3B) — evidence-based derived account status computed by
// the backend. Labels/colors only; the server is authoritative.
const DERIVED_STATUS_BADGES = {
  active: { label: "Active", color: "bg-emerald-100 text-emerald-700" },
  invited: { label: "Invited (not yet accepted)", color: "bg-indigo-100 text-indigo-700" },
  suspended: { label: "Suspended", color: "bg-red-100 text-red-700" },
  locked: { label: "Locked", color: "bg-amber-100 text-amber-700" },
};

const DERIVED_STATUS_OPTIONS = Object.entries(DERIVED_STATUS_BADGES).map(([value, badge]) => ({
  value,
  ...badge,
}));

const PAGE_SIZE = 25;

function formatDateTimeSafe(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

/** Shared shell for reason-mandated user mutations (Phase 3B). */
function ReasonModal({ open, onClose, title, icon, description, busy, error, submitLabel, submitDisabled, onSubmit, children }) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title={title} icon={icon} size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(reason);
        }}
        className="space-y-4"
      >
        {description && <p className="text-xs text-slate-500">{description}</p>}
        {children}
        <Field label="Reason" htmlFor="user-action-reason" required hint="Stored verbatim in the platform audit trail.">
          <textarea
            id="user-action-reason"
            required
            minLength={3}
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
          <Button type="submit" variant="primary" loading={busy} disabled={submitDisabled || reason.trim().length < 3}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Per-row actions as a labelled menu. The old strip of five unlabelled icons
 * did not fit its column (icons overlapped and clipped) and gave no clue what
 * e.g. the key icon did. The menu is position:fixed from the trigger's
 * rectangle so the table's overflow container cannot clip it.
 */
function RowActionsMenu({ label, items }) {
  const [pos, setPos] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const open = pos !== null;

  useEffect(() => {
    if (!open) return undefined;
    const close = () => setPos(null);
    const onPointer = (e) => {
      if (!menuRef.current?.contains(e.target) && !triggerRef.current?.contains(e.target)) close();
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        close();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    menuRef.current?.querySelector("button:not(:disabled)")?.focus();
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function toggle() {
    if (open) return setPos(null);
    const r = triggerRef.current.getBoundingClientRect();
    const menuHeight = items.length * 36 + 16;
    const openUp = r.bottom + menuHeight > window.innerHeight && r.top > menuHeight;
    setPos({ right: window.innerWidth - r.right, ...(openUp ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) });
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          style={{ position: "fixed", ...pos }}
          className="z-50 w-64 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg"
        >
          {items.map(({ label: itemLabel, icon: Icon, onClick, disabled, danger, separated }) => (
            <React.Fragment key={itemLabel}>
              {separated && <div className="my-1 h-px bg-slate-100" />}
              <button
                type="button"
                role="menuitem"
                disabled={disabled}
                onClick={() => {
                  setPos(null);
                  onClick();
                }}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  danger ? "text-red-600 hover:bg-red-50" : "text-slate-700 hover:bg-slate-100"
                }`}
              >
                <Icon size={15} className="shrink-0" />
                <span className="truncate">{itemLabel}</span>
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </>
  );
}

function OrgSelect({ id, value, onChange, organizations, allowNone = false }) {
  return (
    <>
      <label htmlFor={id} className="sr-only">Organization</label>
      <select
        id={id}
        required={!allowNone}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
      >
        <option value="">Select organization…</option>
        {allowNone && <option value="__none__">— No organization —</option>}
        {organizations.map((o) => (
          <option key={o.id} value={o.id}>{o.organization_name} ({o.organization_code})</option>
        ))}
      </select>
    </>
  );
}

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [me, setMe] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [loading, setLoading] = useState(true);

  // Phase 3B modals
  const [organizations, setOrganizations] = useState([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [statusTarget, setStatusTarget] = useState(null);
  const [membershipTarget, setMembershipTarget] = useState(null);
  const [purgeTarget, setPurgeTarget] = useState(null);
  const [modalError, setModalError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    apiFetch("/api/super-admin/users", {
      params: {
        search,
        role: FIXED_ROLE,
        is_active: status === "" ? undefined : status === "true",
        skip: (page - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
      },
    })
      .then((data) => {
        setUsers(data.users);
        setTotal(data.total ?? 0);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [search, status, page]);

  useEffect(() => {
    load();
  }, [load]);

  // Directory for invite/membership pickers — loaded lazily on first open.
  const ensureOrganizations = useCallback(() => {
    if (organizations.length > 0) return;
    apiFetch("/api/super-admin/organizations", { params: { limit: 200 } })
      .then((data) => setOrganizations(data.organizations || []))
      .catch((err) => setError(err.message));
  }, [organizations.length]);

  useEffect(() => {
    apiFetch("/api/auth/me").then(setMe).catch(() => {});
  }, []);

  const resetToFirstPage = useCallback((value) => {
    setSearch(value);
    setPage(1);
  }, []);

  // Bumped on clear to remount the toolbar's search box, so text still inside
  // its debounce window is discarded instead of re-applying a moment later.
  const [toolbarResetKey, setToolbarResetKey] = useState(0);
  const hasActiveFilters = Boolean(search || status);
  const clearFilters = useCallback(() => {
    setToolbarResetKey((k) => k + 1);
    setSearch("");
    setStatus("");
    setPage(1);
  }, []);

  function openStatus(u) {
    setModalError("");
    setStatusTarget(u);
  }

  function openMembership(u) {
    setModalError("");
    ensureOrganizations();
    setMembershipTarget(u);
  }

  function openPurge(u) {
    setModalError("");
    setPurgeTarget(u);
  }

  function openInvite() {
    setModalError("");
    ensureOrganizations();
    setInviteOpen(true);
  }

  async function handleStatusSubmit(reason) {
    const u = statusTarget;
    if (!u) return;
    setBusyId(u.id);
    try {
      await apiFetch(`/api/super-admin/users/${u.id}/status`, {
        method: "PUT",
        body: { is_active: !u.is_active, reason },
      });
      setNotice(`User ${u.email} ${u.is_active ? "deactivated" : "reactivated"}.`);
      setStatusTarget(null);
      load();
    } catch (err) {
      setModalError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleMembershipSubmit(orgValue, reason) {
    const u = membershipTarget;
    if (!u) return;
    setBusyId(u.id);
    try {
      await apiFetch(`/api/super-admin/users/${u.id}/membership`, {
        method: "PUT",
        body: { organization_id: orgValue === "__none__" || orgValue === "" ? null : Number(orgValue), reason },
      });
      setNotice(`Membership for ${u.email} updated.`);
      setMembershipTarget(null);
      load();
    } catch (err) {
      setModalError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function handlePurgeSubmit(reason, confirmation) {
    // Permanent, irreversible deletion of the whole tenant identified by this
    // admin row's organization. The backend re-verifies the confirmation code.
    const u = purgeTarget;
    if (!u || !u.organization_id) return;
    setBusyId(u.id);
    try {
      const res = await apiFetch(`/api/super-admin/organizations/${u.organization_id}/purge`, {
        method: "POST",
        timeout: 120000,
        body: { reason, confirmation },
      });
      setNotice(res?.message || `Organization "${u.organization_name}" permanently deleted.`);
      setPurgeTarget(null);
      load();
    } catch (err) {
      setModalError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function resetPassword(u) {
    setBusyId(u.id);
    setNotice("");
    setError("");
    try {
      await apiFetch(`/api/super-admin/users/${u.id}/reset-password`, { method: "PUT" });
      setNotice(`Reset link sent to ${u.email}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function resendInvite(u) {
    // P15: closes the Phase 14 gap where a pending Organization Admin
    // invitation had no resend action if the email failed. Reuses the same
    // busyId loading/duplicate-request guard as every other row action here.
    setBusyId(u.id);
    setNotice("");
    setError("");
    try {
      const res = await apiFetch(`/api/super-admin/users/${u.id}/resend-invite`, { method: "POST" });
      // Truthful outcome from the backend's email_sent field — never a
      // hardcoded "sent" string regardless of what actually happened.
      if (res.email_sent === false) {
        setError(res.message);
      } else {
        setNotice(res.message);
      }
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  const columns = useMemo(
    () => [
      {
        key: "user",
        label: "Organization Admin",
        render: (u) => (
          <span className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-brand to-brand-hover text-xs font-bold text-white shadow-sm">
              {initialsOf(u.first_name, u.last_name, u.email)}
            </span>
            <span className="min-w-0 overflow-hidden">
              <span className="block truncate font-semibold text-slate-800">{u.first_name} {u.last_name}</span>
              <span className="block truncate text-xs text-slate-500" title={u.email}>{u.email}</span>
            </span>
          </span>
        ),
      },
      {
        key: "organization",
        label: "Organization",
        hideBelow: "md",
        render: (u) => (
          <span className="flex min-w-0 items-center gap-1.5 text-slate-600">
            <Building2 size={13} className="shrink-0 text-slate-400" />
            <span className="truncate" title={u.organization_name || "—"}>{u.organization_name || "—"}</span>
          </span>
        ),
      },
      {
        key: "plan",
        label: "Plan",
        hideBelow: "lg",
        render: (u) =>
          u.subscription_plan_code ? (
            <span>
              <span className="block font-medium text-slate-700">
                {u.subscription_plan_name || u.subscription_plan_code}
              </span>
              <span className="block text-xs text-slate-500">{u.subscription_status}</span>
            </span>
          ) : (
            <span className="text-xs text-slate-400">No plan assigned</span>
          ),
      },
      {
        key: "derived_status",
        label: "Status",
        render: (u) => (
          <StatusBadge
            status={u.derived_status || (u.is_active ? "active" : "suspended")}
            options={DERIVED_STATUS_OPTIONS}
            fallbackColor="bg-slate-100 text-slate-600"
          />
        ),
      },
      {
        key: "login_created",
        label: "Login / Created",
        hideBelow: "xl",
        render: (u) => {
          const formatted = formatDateTimeSafe(u.last_login_at);
          return (
            <span className="block text-xs text-slate-500 leading-5">
              <span className="block" title="Last login">{formatted || "Never"}</span>
              <span className="block text-slate-400" title="Created">{new Date(u.created_at).toLocaleDateString()}</span>
            </span>
          );
        },
      },
      {
        key: "actions",
        label: "",
        width: 56,
        render: (u) => {
          const busy = busyId === u.id;
          const items = [
            {
              label: u.is_active ? "Deactivate account" : "Activate account",
              icon: Power,
              disabled: busy || (me && me.id === u.id),
              onClick: () => openStatus(u),
            },
            ...(u.derived_status === "invited"
              ? [{ label: "Resend invitation email", icon: Mail, disabled: busy, onClick: () => resendInvite(u) }]
              : []),
            { label: "Move to another organization", icon: GitBranch, disabled: busy, onClick: () => openMembership(u) },
            { label: "Send password reset link", icon: KeyRound, disabled: busy, onClick: () => resetPassword(u) },
            ...(u.organization_id
              ? [{
                  label: "Delete organization permanently",
                  icon: Trash2,
                  danger: true,
                  separated: true,
                  disabled: busy,
                  onClick: () => openPurge(u),
                }]
              : []),
          ];
          return (
            <div className="flex justify-end">
              <RowActionsMenu label={`Actions for ${u.email}`} items={items} />
            </div>
          );
        },
      },
    ],
    [busyId, me]
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Trial Period Overview — per-org remaining trial days derived from the
  // current page's user rows (trial_ends_at lives on the org's subscription).
  // Most urgent first; all bars rendered blue.
  const trialChartData = useMemo(() => {
    const byOrg = new Map();
    for (const u of users) {
      if (!u.organization_name || !u.trial_ends_at) continue;
      if (u.subscription_status !== "trialing" && u.subscription_status !== "pending") continue;
      const end = new Date(u.trial_ends_at);
      if (Number.isNaN(end.getTime())) continue;
      const days = Math.max(0, Math.ceil((end.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
      if (!byOrg.has(u.organization_name)) {
        byOrg.set(u.organization_name, {
          org: u.organization_name,
          days,
          color: "#3B82F6",
        });
      }
    }
    return Array.from(byOrg.values()).sort((a, b) => a.days - b.days);
  }, [users]);

  return (
    <div className="min-w-0 max-w-full space-y-6 overflow-x-hidden">
      <PageHeader
        crumbs={[{ label: "Platform" }, { label: "Organization Admins" }]}
        title="Organization Admins"
        description="Every organization admin across all tenants — their organization's selected plan, remaining free-trial time, and evidence-based account status."
        icon={UsersIcon}
        meta={`${total} organization admin(s)`}
        actions={
          <Button variant="primary" icon={UserPlus} onClick={openInvite}>
            Invite Organization Admin
          </Button>
        }
      />

      {notice && <div className="mt-4"><SuccessMessage message={notice} onDismiss={() => setNotice("")} /></div>}
      {error && (
        <div className="mt-4 rounded-2xl border border-red-200 bg-white">
          <ErrorState message={error} onRetry={load} title="Unable to load platform users" />
        </div>
      )}

      {!error && (
        <>
          <div className="mt-6">
            <ListToolbar
              key={toolbarResetKey}
              search={search}
              onSearchChange={resetToFirstPage}
              searchPlaceholder="Search email, name or organization…"
              showFilters={false}
              onRefresh={load}
              refreshing={loading}
            >
              <Select value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={STATUS_OPTIONS} placeholder="All statuses" className="w-40" aria-label="Filter users by status" />
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
            </ListToolbar>
          </div>

          {trialChartData.length > 0 && (
            <div className="mt-6">
              <DashboardChartCard
                title="Trial Period Overview"
                action={<span className="text-xs text-slate-400">{trialChartData.length} org(s) on trial</span>}
              >
                <div className="h-64 w-full" aria-label="Remaining trial days per organization">
                  <DashboardChartErrorBoundary>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={trialChartData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                        <XAxis dataKey="org" tick={{ fontSize: 11, fill: "#64748B" }} interval={0} angle={-25} textAnchor="end" height={56} />
                        <YAxis tick={{ fontSize: 11, fill: "#64748B" }} allowDecimals={false} />
                        <Tooltip formatter={(value) => [`${value} day(s)`, "Trial remaining"]} />
                        <Bar dataKey="days" radius={[6, 6, 0, 0]}>
                          {trialChartData.map((d, i) => (
                            <Cell key={i} fill={d.color} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </DashboardChartErrorBoundary>
                </div>
              </DashboardChartCard>
            </div>
          )}

          <div className="mt-2">
            <DataTable
              columns={columns}
              data={users}
              loading={loading}
              rowKey={(u) => u.id}
              emptyTitle="No organization admins found"
              emptyMessage={hasActiveFilters ? "No organization admins match your current filters." : "Organization admins will appear here once organizations are provisioned."}
              emptyAction={
                hasActiveFilters ? (
                  <Button variant="secondary" size="sm" icon={X} onClick={clearFilters}>Clear filters</Button>
                ) : null
              }
              minWidth={0}
              tableClassName="table-fixed"
            />
          </div>

          <div className="mt-4">
            <Pagination page={page} totalPages={totalPages} onPageChange={setPage}>
              {total} organization admin(s)
            </Pagination>
          </div>
        </>
      )}
      {/* ── Phase 3B mutation modals ───────────────────────────────────── */}

      {statusTarget && (
        <ReasonModal
          open
          onClose={() => setStatusTarget(null)}
          title={statusTarget.is_active ? "Deactivate user" : "Reactivate user"}
          icon={Power}
          description={`${statusTarget.email} will ${statusTarget.is_active ? "immediately lose access to the platform" : "regain access"} as soon as the change is saved.`}
          busy={busyId === statusTarget.id}
          error={modalError}
          submitLabel={statusTarget.is_active ? "Deactivate" : "Activate"}
          onSubmit={handleStatusSubmit}
        />
      )}

      {membershipTarget && (
        <MembershipMoveModal
          user={membershipTarget}
          organizations={organizations}
          busy={busyId === membershipTarget.id}
          error={modalError}
          onClose={() => setMembershipTarget(null)}
          onSubmit={handleMembershipSubmit}
          ReasonShell={ReasonModal}
        />
      )}

      {purgeTarget && (
        <PurgeOrganizationModal
          target={purgeTarget}
          busy={busyId === purgeTarget.id}
          error={modalError}
          onClose={() => setPurgeTarget(null)}
          onSubmit={handlePurgeSubmit}
        />
      )}

      {inviteOpen && (
        <InviteUserModal
          organizations={organizations}
          onClose={() => setInviteOpen(false)}
          onInvited={(msg) => {
            setInviteOpen(false);
            setNotice(msg);
            load();
          }}
        />
      )}
    </div>
  );
}

/** Permanent, irreversible tenant hard-delete. Confirmed by typing the
 * exact organization code; the backend re-validates it before deleting. */
function PurgeOrganizationModal({ target, busy, error, onClose, onSubmit }) {
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const code = target.organization_code || "";
  const confirmed = code !== "" && confirmation.trim() === code;

  return (
    <Modal open onClose={onClose} title="Delete organization permanently" icon={Trash2} size="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (confirmed) onSubmit(reason, confirmation);
        }}
        className="space-y-4"
      >
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          This permanently deletes{" "}
          <strong>{target.organization_name || `organization #${target.organization_id}`}</strong>
          {code ? ` (${code})` : ""} and <strong>every record that belongs to it</strong> — all users,
          invoices, payments, subscriptions, billing history and AI data. This cannot be undone.
        </p>
        <Field label="Reason" htmlFor="purge-reason" required hint="Stored verbatim in the platform audit trail.">
          <textarea
            id="purge-reason"
            required
            minLength={3}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        <Field
          label={`Type ${code || "the organization code"} to confirm`}
          htmlFor="purge-confirm"
          required
          hint="Must match the organization code exactly."
        >
          <input
            id="purge-confirm"
            required
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm focus:border-red-300 focus:outline-none focus:ring-2 focus:ring-red-100"
          />
        </Field>
        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="danger" loading={busy} disabled={!confirmed || reason.trim().length < 3}>
            Delete organization
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function MembershipMoveModal({ user, organizations, busy, error, onClose, onSubmit }) {
  const [orgValue, setOrgValue] = useState(user.organization_id ? String(user.organization_id) : "__none__");

  return (
    <ReasonModal
      open
      onClose={onClose}
      title="Move membership"
      icon={GitBranch}
      description={`Moves ${user.email} into another organization, or strips tenant membership entirely. Platform accounts can never be moved.`}
      busy={busy}
      error={error}
      submitLabel="Apply move"
      submitDisabled={orgValue === String(user.organization_id)}
      onSubmit={(reason) => onSubmit(orgValue, reason)}
    >
      <Field label="Target organization" htmlFor="membership-org" required>
        <OrgSelect id="membership-org" value={orgValue} onChange={setOrgValue} organizations={organizations} allowNone />
      </Field>
    </ReasonModal>
  );
}

function InviteUserModal({ organizations, onClose, onInvited }) {
  const EMPTY_FORM = {
    organization_id: "",
    email: "",
    first_name: "",
    last_name: "",
    phone: "",
    role: "org_admin",
    send_invite: true,
  };
  const [form, setForm] = useState(EMPTY_FORM);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const setValue = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  // Read the input synchronously, outside the state updater.
  const set = (key) => (e) => setValue(key, e.target.type === "checkbox" ? e.target.checked : e.target.value);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await apiFetch("/api/super-admin/users/invite", {
        method: "POST",
        body: {
          organization_id: Number(form.organization_id),
          email: form.email,
          first_name: form.first_name,
          last_name: form.last_name,
          phone: form.phone,
          role: form.role,
          send_invite: form.send_invite,
        },
      });
      // P14 fix: report the real SMTP outcome (invite_email_sent) instead of
      // always claiming the invitation was sent — a 2xx here only means the
      // user row was created.
      if (!form.send_invite) {
        onInvited(`${form.email} was added. No invitation email was sent.`);
      } else if (created.invite_email_sent === false) {
        onInvited(`${form.email} was added, but the invitation email could not be delivered. Use the Resend Invite action on this list to try again.`);
      } else {
        onInvited(`Invitation sent to ${form.email}.`);
      }
    } catch (err) {
      setError(err?.message || "Failed to create invitation.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Invite tenant administrator" icon={UserPlus} size="md">
      <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Organization" htmlFor="invite-org" required>
            <OrgSelect id="invite-org" value={form.organization_id} onChange={(value) => setValue("organization_id", value)} organizations={organizations} />
          </Field>
        </div>
        <Field label="Email" htmlFor="invite-email" required>
          <input id="invite-email" type="email" required value={form.email} onChange={set("email")} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100" />
        </Field>
        <Field label="Phone" htmlFor="invite-phone">
          <input id="invite-phone" value={form.phone} onChange={set("phone")} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100" />
        </Field>
        <Field label="First name" htmlFor="invite-first">
          <input id="invite-first" value={form.first_name} onChange={set("first_name")} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100" />
        </Field>
        <Field label="Last name" htmlFor="invite-last">
          <input id="invite-last" value={form.last_name} onChange={set("last_name")} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100" />
        </Field>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 sm:col-span-2">
          Role: <strong>Organization Admin</strong>. Segregation of duties: Super Admins create org admins platform-wide; billing,
          finance and auditor roles are invited by the tenant's own administrators. The invite reuses the standard single-use token flow.
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2">
          <input type="checkbox" checked={form.send_invite} onChange={set("send_invite")} className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-200" />
          Send invitation email now
        </label>
        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 sm:col-span-2">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 sm:col-span-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>Create invitation</Button>
        </div>
      </form>
    </Modal>
  );
}
