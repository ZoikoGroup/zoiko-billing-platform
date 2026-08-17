import React, { useEffect, useState, useCallback, useMemo } from "react";
import { KeyRound, Power, UserCog, ShieldCheck, ShieldOff } from "lucide-react";

import { apiFetch } from "../api/client";
import { PageHeader, DataTable, SearchInput, Select, Button } from "../components/billing-ui";
import { ErrorState, SuccessMessage, Pagination, StatusBadge, useConfirmationDialog } from "../components/billing-shared";

const ROLE_OPTIONS = [
  { value: "org_admin", label: "Org Admin" },
  { value: "billing_admin", label: "Billing Admin" },
];

const STATUS_OPTIONS = [
  { value: "true", label: "Active" },
  { value: "false", label: "Inactive" },
];

const USER_STATUS_BADGE_OPTIONS = [
  { value: true, label: "Active", color: "bg-emerald-100 text-emerald-700" },
  { value: false, label: "Inactive", color: "bg-red-100 text-red-700" },
];

const PAGE_SIZE = 25;

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
        setTotal(data.total);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [search, role, status, page]);

  useEffect(() => {
    load();
  }, [load]);

  // Reset to page 1 in the same event as the filter change (not a separate
  // effect) so only one request fires per change instead of two.
  const onSearchChange = useCallback((value) => {
    setSearch(value);
    setPage(1);
  }, []);

  const onRoleChange = useCallback((value) => {
    setRole(value);
    setPage(1);
  }, []);

  const onStatusChange = useCallback((value) => {
    setStatus(value);
    setPage(1);
  }, []);

  useEffect(() => {
    apiFetch("/api/auth/me").then(setMe).catch(() => {});
  }, []);

  async function toggleStatus(u) {
    setBusyId(u.id);
    setNotice("");
    setError("");
    try {
      await apiFetch(`/api/super-admin/users/${u.id}/status`, {
        method: "PUT",
        params: { is_active: !u.is_active },
      });
      setNotice(`User ${u.email} ${u.is_active ? "deactivated" : "activated"}.`);
      load();
    } catch (err) {
      setError(err.message);
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
            <span className="block text-xs text-slate-400">{u.email}</span>
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
      { key: "organization", label: "Organization", render: (u) => <span className="text-slate-500">{u.organization_name || "—"}</span> },
      { key: "status", label: "Status", render: (u) => <StatusBadge status={u.is_active} options={USER_STATUS_BADGE_OPTIONS} /> },
      {
        key: "mfa",
        label: "MFA",
        render: (u) =>
          u.role !== "super_admin" ? (
            <span className="text-xs text-slate-400">—</span>
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
      { key: "created_at", label: "Created", render: (u) => <span className="text-xs text-slate-500">{new Date(u.created_at).toLocaleDateString()}</span> },
      {
        key: "actions",
        label: "Actions",
        width: 280,
        render: (u) => (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={u.is_active ? "danger" : "secondary"}
              icon={Power}
              disabled={busyId === u.id || (me && me.id === u.id)}
              onClick={() => toggleStatus(u)}
            >
              {u.is_active ? "Deactivate" : "Activate"}
            </Button>
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
        title="Platform Users"
        description="Every org admin and billing admin across all organizations."
        icon={UserCog}
        meta={`${total} user(s)`}
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
            <SearchInput value={search} onChange={onSearchChange} placeholder="Search email or name…" />
            <Select value={role} onChange={onRoleChange} options={ROLE_OPTIONS} placeholder="All roles" />
            <Select value={status} onChange={onStatusChange} options={STATUS_OPTIONS} placeholder="All statuses" />
          </div>

          <div className="mt-4">
            <DataTable
              columns={columns}
              data={users}
              loading={loading}
              rowKey={(u) => u.id}
              emptyTitle="No users found"
              emptyMessage={search || role || status ? "No users match your current filters." : "Users will appear here once organizations are provisioned."}
              minWidth={860}
            />
          </div>

          <div className="mt-4">
            <Pagination page={page} totalPages={totalPages} onPageChange={setPage}>
              {total} user(s)
            </Pagination>
          </div>
        </>
      )}
      <ConfirmationDialog />
    </div>
  );
}
