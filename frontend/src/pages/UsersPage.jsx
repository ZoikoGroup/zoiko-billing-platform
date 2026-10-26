import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { ArrowRightLeft, KeyRound, Power, RefreshCw, UserPlus, Building2, Mail, Users as UsersIcon, Trash2, X } from "lucide-react";

import { apiFetch } from "../api/client";
import { PageHeader, DataTable, SearchInput, Modal, Field, Button } from "../components/billing-ui";
import { ErrorState, SuccessMessage, Pagination } from "../components/billing-shared";
import { formatTrialRemaining, TrialProgressBar } from "../modules/super-admin/constants";

// This page is scoped to Organization Admins only — one tenant-facing
// administrator role per organization. Billing/finance/auditor roles are
// invited by each tenant's own org admin, and Super Admin accounts have
// their own platform-role tooling; neither belongs in this roster.
const FIXED_ROLE = "org_admin";

function initialsOf(firstName, lastName, email) {
  const first = (firstName || "").trim();
  const last = (lastName || "").trim();
  if (first || last) return `${first[0] || ""}${last[0] || ""}`.toUpperCase();
  return (email || "?").slice(0, 2).toUpperCase();
}

// ZB-SA-P3 (Phase 3B) — evidence-based derived account status computed by
// the backend (UserAdminService.derived_status). The tiles filter and count
// by the same value server-side (?derived_status=, status_counts).
const ACCOUNT_STATUS = {
  active: { label: "Active", hint: "Signed up and can log in", dot: "bg-emerald-500", badge: "bg-emerald-100 text-emerald-700" },
  invited: { label: "Invited", hint: "Invitation not accepted yet", dot: "bg-indigo-500", badge: "bg-indigo-100 text-indigo-700" },
  suspended: { label: "Deactivated", hint: "Access removed by a Super Admin", dot: "bg-slate-400", badge: "bg-slate-200 text-slate-600" },
};
const ACCOUNT_STATUS_ORDER = ["active", "invited", "suspended"];

function AccountStatusBadge({ value }) {
  const meta = ACCOUNT_STATUS[value] || { label: value || "Unknown", dot: "bg-slate-300", badge: "bg-slate-100 text-slate-600" };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${meta.badge}`} title={meta.hint}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function relativeTime(value) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return null;
  const minutes = Math.floor((Date.now() - ts) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

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
 * One row action as a visible icon button. The name is the accessible label
 * and a tooltip on hover/focus — rendered position:fixed from the button's
 * rectangle so the table's overflow box can't clip it (first/last rows).
 */
function ActionIconButton({ label, icon: Icon, onClick, disabled = false, danger = false }) {
  const ref = useRef(null);
  const [tip, setTip] = useState(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect?.();
    if (r) setTip({ left: r.left + r.width / 2, top: r.top - 8 });
  };
  const hide = () => setTip(null);
  useEffect(() => {
    if (!tip) return undefined;
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, [tip]);
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          hide();
          onClick();
        }}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200 disabled:cursor-not-allowed disabled:opacity-40 ${
          danger
            ? "border-red-100 bg-white text-red-500 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
            : "border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-800"
        }`}
      >
        <Icon size={15} />
      </button>
      {tip && (
        <span
          role="tooltip"
          style={{ position: "fixed", left: tip.left, top: tip.top, transform: "translate(-50%, -100%)" }}
          className="pointer-events-none z-50 whitespace-nowrap rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-lg"
        >
          {label}
        </span>
      )}
    </>
  );
}

/** Clickable status tiles: roster-wide counts that double as the filter. */
function AccountStatusTiles({ counts, selected, onSelect }) {
  const total = counts ? ACCOUNT_STATUS_ORDER.reduce((sum, key) => sum + (counts[key] || 0), 0) : null;
  const tiles = [{ key: "", label: "All admins", hint: "Every organization admin", count: total, dot: "bg-slate-800" }].concat(
    ACCOUNT_STATUS_ORDER.map((key) => ({ key, ...ACCOUNT_STATUS[key], count: counts ? counts[key] ?? 0 : null }))
  );
  return (
    <div role="group" aria-label="Filter by account status" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((tile) => {
        const active = selected === tile.key;
        return (
          <button
            key={tile.key || "all"}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(tile.key)}
            className={`rounded-2xl border p-4 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
              active ? "border-brand-500 bg-brand-50 shadow-sm" : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm"
            } ${tile.key && tile.count === 0 && !active ? "opacity-60" : ""}`}
          >
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <span className={`h-2 w-2 rounded-full ${tile.dot}`} aria-hidden="true" />
              {tile.label}
            </span>
            <span className={`mt-1.5 block text-2xl font-extrabold ${active ? "text-brand-700" : "text-slate-800"}`}>
              {tile.count == null ? "—" : tile.count.toLocaleString()}
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-slate-400">{tile.hint}</span>
          </button>
        );
      })}
    </div>
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
  const [statusCounts, setStatusCounts] = useState(null);
  // A failed row action (reset link, resend invite). Separate from `error`
  // (a failed LOAD), which replaces the table — an action failure must not.
  const [actionError, setActionError] = useState("");

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
        derived_status: status || undefined,
        skip: (page - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
      },
    })
      .then((data) => {
        setUsers(data.users);
        setTotal(data.total ?? 0);
        if (data.status_counts) setStatusCounts(data.status_counts);
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
      .catch((err) => setActionError(`Couldn't load organizations: ${err.message}`));
  }, [organizations.length]);

  useEffect(() => {
    apiFetch("/api/auth/me").then(setMe).catch(() => {});
  }, []);

  const resetToFirstPage = useCallback((value) => {
    setSearch(value);
    setPage(1);
  }, []);

  // Bumped on clear to remount the search box, so text still inside its
  // debounce window is discarded instead of re-applying a moment later.
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
    setActionError("");
    try {
      await apiFetch(`/api/super-admin/users/${u.id}/reset-password`, { method: "PUT" });
      setNotice(`Reset link sent to ${u.email}.`);
    } catch (err) {
      setActionError(err.message);
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
    setActionError("");
    try {
      const res = await apiFetch(`/api/super-admin/users/${u.id}/resend-invite`, { method: "POST" });
      // Truthful outcome from the backend's email_sent field — never a
      // hardcoded "sent" string regardless of what actually happened.
      if (res.email_sent === false) {
        setActionError(res.message);
      } else {
        setNotice(res.message);
      }
      load();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  const selectStatus = useCallback((value) => {
    setStatus(value);
    setPage(1);
  }, []);

  const columns = useMemo(
    () => [
      {
        key: "user",
        label: "Organization admin",
        width: "28%",
        render: (u) => {
          const name = `${u.first_name || ""} ${u.last_name || ""}`.trim();
          return (
            <span className="flex min-w-0 items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-brand to-brand-hover text-xs font-bold text-white shadow-sm" aria-hidden="true">
                {initialsOf(u.first_name, u.last_name, u.email)}
              </span>
              <span className="min-w-0">
                <span className="line-clamp-2 break-words text-sm font-semibold leading-snug text-slate-900" title={name || u.email}>
                  {name || u.email}
                </span>
                <span className="block truncate text-xs text-slate-500" title={u.email}>{u.email}</span>
              </span>
            </span>
          );
        },
      },
      {
        key: "organization",
        label: "Organization",
        hideBelow: "md",
        render: (u) =>
          u.organization_name ? (
            <span className="flex min-w-0 items-start gap-1.5">
              <Building2 size={14} className="mt-0.5 shrink-0 text-slate-400" />
              <span className="min-w-0">
                <span className="line-clamp-2 break-words text-sm font-medium text-slate-700" title={u.organization_name}>
                  {u.organization_name}
                </span>
                {u.organization_code && <span className="block text-[11px] text-slate-400">{u.organization_code}</span>}
              </span>
            </span>
          ) : (
            <span className="text-xs text-slate-400">No organization</span>
          ),
      },
      {
        key: "plan",
        label: "Plan",
        hideBelow: "lg",
        render: (u) =>
          u.subscription_plan_code ? (
            <span className="block min-w-0">
              <span className="block truncate font-medium text-slate-700" title={u.subscription_plan_name || u.subscription_plan_code}>
                {u.subscription_plan_name || u.subscription_plan_code}
              </span>
              {u.subscription_status === "trialing" || u.subscription_status === "trial_recovery" ? (
                <span className="mt-1 block">
                  <TrialProgressBar trial={formatTrialRemaining(u.trial_ends_at, u.subscription_status, u.recovery_ends_at)} />
                </span>
              ) : (
                <span className="block text-xs capitalize text-slate-500">{(u.subscription_status || "").replace(/_/g, " ")}</span>
              )}
            </span>
          ) : (
            <span className="text-xs text-slate-400">No plan</span>
          ),
      },
      {
        key: "derived_status",
        label: "Status",
        width: 130,
        render: (u) => <AccountStatusBadge value={u.derived_status || (u.is_active ? "active" : "suspended")} />,
      },
      {
        key: "last_login",
        label: "Last login",
        width: 120,
        hideBelow: "xl",
        render: (u) => (
          <span className="block text-xs leading-5">
            <span className="block font-medium text-slate-700" title={formatDateTimeSafe(u.last_login_at) || undefined}>
              {relativeTime(u.last_login_at) || <span className="font-normal text-slate-400">Never</span>}
            </span>
            <span className="block text-slate-400" title={formatDateTimeSafe(u.created_at) || undefined}>
              Joined {relativeTime(u.created_at) || "—"}
            </span>
          </span>
        ),
      },
      {
        key: "actions",
        label: "Actions",
        width: 200,
        render: (u) => {
          const busy = busyId === u.id;
          return (
            <div className="flex items-center justify-end gap-1.5">
              <ActionIconButton
                label={u.is_active ? "Deactivate account" : "Activate account"}
                icon={Power}
                disabled={busy || (me && me.id === u.id)}
                onClick={() => openStatus(u)}
              />
              {u.derived_status === "invited" && (
                <ActionIconButton label="Resend invitation email" icon={Mail} disabled={busy} onClick={() => resendInvite(u)} />
              )}
              <ActionIconButton label="Move to another organization" icon={ArrowRightLeft} disabled={busy} onClick={() => openMembership(u)} />
              <ActionIconButton label="Send password reset link" icon={KeyRound} disabled={busy} onClick={() => resetPassword(u)} />
              {u.organization_id && (
                <>
                  <span className="mx-0.5 h-5 w-px bg-slate-200" aria-hidden="true" />
                  <ActionIconButton
                    label={`Delete organization "${u.organization_name || u.organization_id}" permanently`}
                    icon={Trash2}
                    danger
                    disabled={busy}
                    onClick={() => openPurge(u)}
                  />
                </>
              )}
            </div>
          );
        },
      },
    ],
    [busyId, me]
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rosterTotal = statusCounts ? ACCOUNT_STATUS_ORDER.reduce((sum, key) => sum + (statusCounts[key] || 0), 0) : null;

  return (
    <div className="min-w-0 max-w-full space-y-6 overflow-x-hidden">
      <PageHeader
        crumbs={[{ label: "Platform" }, { label: "Organization Admins" }]}
        title="Organization Admins"
        description="The administrator of every organization on the platform — their account status, organization, plan and trial time."
        icon={UsersIcon}
        meta={rosterTotal != null ? `${rosterTotal} organization admin(s)` : undefined}
        actions={
          <Button variant="primary" icon={UserPlus} onClick={openInvite}>
            Invite Organization Admin
          </Button>
        }
      />

      {notice && <SuccessMessage message={notice} onDismiss={() => setNotice("")} />}
      {actionError && (
        <div role="alert" className="flex items-start justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError("")} className="text-xs font-semibold underline">Dismiss</button>
        </div>
      )}

      <AccountStatusTiles counts={statusCounts} selected={status} onSelect={selectStatus} />

      <section className="min-w-0 rounded-3xl border border-slate-200 bg-white shadow-[0_4px_20px_rgba(0,0,0,0.02)]" aria-label="Organization admins">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <SearchInput
            key={toolbarResetKey}
            value={search}
            onChange={resetToFirstPage}
            placeholder="Search email, name or organization…"
            className="w-full min-w-0 flex-1 sm:max-w-sm"
          />
          <span className="text-xs text-slate-500" aria-live="polite">
            {loading ? "Loading…" : `${total} result${total === 1 ? "" : "s"}`}
            {status && ` · ${ACCOUNT_STATUS[status]?.label || status}`}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={load}
              disabled={loading}
              aria-label="Refresh"
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
            </button>
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

        <div className="p-2 sm:p-3">
          {error ? (
            <ErrorState message={error} onRetry={load} title="Unable to load organization admins" />
          ) : (
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
                ) : (
                  <Button variant="primary" size="sm" icon={UserPlus} onClick={openInvite}>Invite Organization Admin</Button>
                )
              }
              minWidth={0}
              tableClassName="table-fixed"
              // One scroll: the page (no nested 560px table scroll box).
              stickyHeader={false}
            />
          )}
        </div>

        {!error && totalPages > 1 && (
          <div className="border-t border-slate-100 px-4 py-3">
            <Pagination page={page} totalPages={totalPages} onPageChange={setPage}>
              {total} organization admin(s)
            </Pagination>
          </div>
        )}
      </section>

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
      icon={ArrowRightLeft}
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
