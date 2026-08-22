import React, { useEffect, useState, useCallback, useMemo } from "react";
import { KeyRound, Power, UserCog, ShieldCheck, ShieldOff, UserPlus, GitBranch, Building2 } from "lucide-react";

import { apiFetch } from "../api/client";
import { PageHeader, DataTable, SearchInput, Select, Modal, Field, Button } from "../components/billing-ui";
import { ErrorState, SuccessMessage, Pagination, StatusBadge, useConfirmationDialog } from "../components/billing-shared";

const ROLE_OPTIONS = [
  { value: "org_admin", label: "Org Admin" },
  { value: "billing_admin", label: "Billing Admin" },
];

const STATUS_OPTIONS = [
  { value: "true", label: "Active" },
  { value: "false", label: "Inactive" },
];

// ZB-SA-P3 (Phase 3B) — evidence-based derived account status computed by
// the backend. Labels/colors only; the server is authoritative.
const DERIVED_STATUS_BADGES = {
  active: { label: "Active", color: "bg-emerald-100 text-emerald-700" },
  invited: { label: "Invited (not yet accepted)", color: "bg-indigo-100 text-indigo-700" },
  suspended: { label: "Suspended", color: "bg-red-100 text-red-700" },
  locked: { label: "Locked (MFA)", color: "bg-amber-100 text-amber-700" },
};

const DERIVED_STATUS_OPTIONS = Object.entries(DERIVED_STATUS_BADGES).map(([value, badge]) => ({
  value,
  ...badge,
}));

// §25 SoD: super admins create ORG ADMINS platform-wide; billing/finance/
// auditor roles stay under the tenant org admin's authority.
const SA_INVITEABLE_ROLES = [{ value: "org_admin", label: "Organization Admin" }];

// ZB-SA-CMD-003 §26 — Super Admin platform-role scaffolding.
const PLATFORM_ROLE_OPTIONS = [
  { value: "platform_administrator", label: "Platform Administrator" },
  { value: "support_operator", label: "Support Operator" },
  { value: "security_operator", label: "Security Operator" },
  { value: "reliability_operator", label: "Reliability Operator" },
  { value: "auditor", label: "Auditor" },
  { value: "finance_readonly", label: "Finance (Read-Only)" },
];

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
  const [role, setRole] = useState("");
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
  const [roleTarget, setRoleTarget] = useState(null);
  const [membershipTarget, setMembershipTarget] = useState(null);
  const [modalError, setModalError] = useState("");

  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    apiFetch("/api/super-admin/users", {
      params: {
        search,
        role,
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
  }, [search, role, status, page]);

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

  function openStatus(u) {
    setModalError("");
    setStatusTarget(u);
  }

  function openRole(u) {
    setModalError("");
    setRoleTarget(u);
  }

  function openMembership(u) {
    setModalError("");
    ensureOrganizations();
    setMembershipTarget(u);
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

  async function handleRoleSubmit(newRole, reason) {
    const u = roleTarget;
    if (!u) return;
    setBusyId(u.id);
    try {
      await apiFetch(`/api/super-admin/users/${u.id}/role`, {
        method: "PUT",
        body: { role: newRole, reason },
      });
      setNotice(`Role for ${u.email} changed to ${newRole}.`);
      setRoleTarget(null);
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

  async function changePlatformRole(u, newRole) {
    setBusyId(u.id);
    setNotice("");
    setError("");
    try {
      await apiFetch(`/api/super-admin/users/${u.id}/platform-role`, {
        method: "PUT",
        params: { platform_role: newRole },
      });
      setNotice(`Platform role for ${u.email} set to ${newRole.replace(/_/g, " ")}.`);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function resetMfa(u) {
    const ok = await confirm({
      title: "Reset MFA?",
      message:
        `This disables two-factor authentication on ${u.email} and clears their recovery codes. ` +
        "They will be required to re-enroll from scratch on their next sign-in. This is an administrative " +
        "disaster-recovery action and is audited.",
      confirmLabel: "Reset MFA",
      tone: "danger",
    });
    if (!ok) return;
    setBusyId(u.id);
    setNotice("");
    setError("");
    try {
      await apiFetch(`/api/super-admin/users/${u.id}/mfa/reset`, { method: "PUT" });
      setNotice(`MFA reset for ${u.email}. They will be asked to re-enroll on their next sign-in.`);
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
        label: "User",
        render: (u) => (
          <span>
            <span className="block font-medium text-slate-800">{u.first_name} {u.last_name}</span>
            <span className="block text-xs text-slate-500">{u.email}</span>
          </span>
        ),
      },
      {
        key: "role",
        label: "Role",
        render: (u) => (
          <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
            {u.role}
          </span>
        ),
      },
      { key: "organization", label: "Organization", render: (u) => <span className="text-slate-500">{u.organization_name || (u.role === "super_admin" ? "Platform" : "—")}</span> },
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
        key: "last_login_at",
        label: "Last Login",
        render: (u) => {
          const formatted = formatDateTimeSafe(u.last_login_at);
          return (
            <span className="text-xs text-slate-500" title={formatted ? undefined : "No successful login recorded"}>
              {formatted || "Never"}
            </span>
          );
        },
      },
      {
        key: "mfa",
        label: "MFA",
        render: (u) =>
          u.role !== "super_admin" ? (
            <span className="text-xs text-slate-500">—</span>
          ) : u.mfa_enabled ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
              <ShieldCheck size={12} /> Enabled
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
              <ShieldOff size={12} /> Not enrolled
            </span>
          ),
      },
      {
        key: "platform_role",
        label: "Platform Role",
        render: (u) => {
          if (u.role !== "super_admin") return <span className="text-xs text-slate-500">—</span>;
          const canManage = me && (!me.platform_role || me.platform_role === "platform_administrator");
          const current = u.platform_role || "platform_administrator";
          if (!canManage) {
            return (
              <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                {PLATFORM_ROLE_OPTIONS.find((o) => o.value === current)?.label || current}
              </span>
            );
          }
          return (
            <select
              aria-label={`Change platform role for ${u.email}`}
              value={current}
              disabled={busyId === u.id}
              onChange={(e) => changePlatformRole(u, e.target.value)}
              className="rounded-lg border border-slate-200 px-2 py-1 text-xs focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
            >
              {PLATFORM_ROLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          );
        },
      },
      { key: "created_at", label: "Created", render: (u) => <span className="text-xs text-slate-500">{new Date(u.created_at).toLocaleDateString()}</span> },
      {
        key: "actions",
        label: "Actions",
        width: 330,
        render: (u) => (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={u.is_active ? "danger" : "secondary"}
              icon={Power}
              disabled={busyId === u.id || (me && me.id === u.id)}
              onClick={() => openStatus(u)}
            >
              {u.is_active ? "Deactivate" : "Activate"}
            </Button>
            {u.role !== "super_admin" && (
              <>
                <Button size="sm" variant="secondary" icon={UserCog} disabled={busyId === u.id} onClick={() => openRole(u)}>
                  Role
                </Button>
                <Button size="sm" variant="secondary" icon={Building2} disabled={busyId === u.id} onClick={() => openMembership(u)}>
                  Move
                </Button>
              </>
            )}
            <Button size="sm" variant="secondary" icon={KeyRound} disabled={busyId === u.id} onClick={() => resetPassword(u)}>
              Reset PW
            </Button>
            {u.role === "super_admin" && u.mfa_enabled && (
              <Button size="sm" variant="secondary" icon={ShieldOff} disabled={busyId === u.id} onClick={() => resetMfa(u)}>
                Reset MFA
              </Button>
            )}
          </div>
        ),
      },
    ],
    [busyId, me]
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Administrators & Users"
        description="Every org admin and billing admin across all tenants — with evidence-based status and real last-login recency."
        icon={UserCog}
        meta={`${total} user(s)`}
        actions={
          <button
            type="button"
            onClick={openInvite}
            className="inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
          >
            <UserPlus size={15} />
            Invite User
          </button>
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
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <SearchInput value={search} onChange={resetToFirstPage} placeholder="Search email or name…" />
            <Select value={role} onChange={(v) => { setRole(v); setPage(1); }} options={ROLE_OPTIONS} placeholder="All roles" aria-label="Filter users by role" />
            <Select value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={STATUS_OPTIONS} placeholder="All statuses" aria-label="Filter users by status" />
          </div>

          <div className="mt-4">
            <DataTable
              columns={columns}
              data={users}
              loading={loading}
              rowKey={(u) => u.id}
              emptyTitle="No users found"
              emptyMessage={search || role || status ? "No users match your current filters." : "Users will appear here once organizations are provisioned."}
              minWidth={1080}
            />
          </div>

          <div className="mt-4">
            <Pagination page={page} totalPages={totalPages} onPageChange={setPage}>
              {total} user(s)
            </Pagination>
          </div>
        </>
      )}
      {ConfirmationDialog}

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

      {roleTarget && (
        <ReasonModal
          open
          onClose={() => setRoleTarget(null)}
          title="Change role"
          icon={UserCog}
          description={`Current role: ${roleTarget.role}. Per segregation-of-duties rules, Super Admins grant Organization Admin platform-wide; billing/finance/auditor roles are managed by each tenant's own administrators.`}
          busy={busyId === roleTarget.id}
          error={modalError}
          submitLabel="Apply role change"
          onSubmit={(reason) => handleRoleSubmit("org_admin", reason)}
        >
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            New role: <strong>Organization Admin</strong> (the only tenant role grantable by a Super Admin).
          </div>
        </ReasonModal>
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

  const set = (key) => (e) =>
    setForm((f) => ({ ...f, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/super-admin/users/invite", {
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
      onInvited(`Invitation created for ${form.email}.`);
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
            <OrgSelect id="invite-org" value={form.organization_id} onChange={set("organization_id")} organizations={organizations} />
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
