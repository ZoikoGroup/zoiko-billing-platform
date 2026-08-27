import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../../context/AuthContext";
import {
  listUsers,
  getUserSummary,
  inviteUser,
  updateUser,
  deactivateUser,
  resendInvite,
} from "../../service/userManagementService";
import ConfirmDialog from "../../components/ConfirmDialog";
import { ROLE_LABELS, ROLES } from "../../config/roles";
import {
  X,
  CheckCircle,
  AlertTriangle,
  Plus,
  Search,
  Mail,
  Pencil,
  Ban,
  Play,
  UserPlus,
  Users,
  ChevronLeft,
  ChevronRight,
  Clock,
  Shield,
  Filter,
} from "lucide-react";

const INK = "#0F172A";
const INK_SOFT = "#374151";
const INK_FAINT = "#9CA3AF";
const PRIMARY = "#2563EB";
const SUCCESS = "#059669";
const DANGER = "#DC2626";
const WARNING = "#D97706";
const LINE = "#E5E7EB";

const STATUS_STYLES = {
  active: { bg: "#D1FAE5", color: "#059669", label: "Active" },
  invited: { bg: "#EDE9FE", color: "#7C3AED", label: "Invited" },
  inactive: { bg: "#F1F5F9", color: "#64748B", label: "Deactivated" },
};

const STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "invited", label: "Invited" },
  { key: "inactive", label: "Deactivated" },
];

const INVITABLE_ROLES = [
  ROLES.BILLING_ADMIN,
  ROLES.FINANCE_APPROVER,
  ROLES.AUDITOR,
];

const PAGE_SIZE = 15;

function getUserStatus(u) {
  if (!u.is_active) return "inactive";
  if (!u.is_verified) return "invited";
  return "active";
}

function StatusPill({ active, verified }) {
  const key = !active ? "inactive" : !verified ? "invited" : "active";
  const s = STATUS_STYLES[key];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: s.bg, color: s.color }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.color }} />
      {s.label}
    </span>
  );
}

function formatLastActive(iso) {
  if (!iso) return "Never";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function initials(first, last) {
  return `${(first || "?")[0] || ""}${(last || "")[0] || ""}`.toUpperCase();
}

const EMPTY_FORM = { first_name: "", last_name: "", email: "", phone: "", role: ROLES.BILLING_ADMIN, send_invite: true };

function SummaryCard({ icon: Icon, label, value, color, bg }) {
  return (
    <div className="rounded-xl border p-4 flex items-center gap-3" style={{ background: "#fff", borderColor: LINE }}>
      <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: bg }}>
        <Icon className="w-5 h-5" style={{ color }} />
      </div>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: INK_FAINT }}>{label}</p>
        <p className="text-xl font-bold tracking-tight leading-none mt-0.5" style={{ color: INK }}>{value}</p>
      </div>
    </div>
  );
}

function SkeletonRow() {
  return (
    <tr className="animate-pulse">
      <td className="px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-slate-100" />
          <div className="space-y-1.5">
            <div className="h-3.5 w-28 bg-slate-100 rounded" />
            <div className="h-3 w-36 bg-slate-50 rounded" />
          </div>
        </div>
      </td>
      <td className="px-5 py-4"><div className="h-5 w-20 bg-slate-100 rounded-full" /></td>
      <td className="px-5 py-4"><div className="h-5 w-20 bg-slate-100 rounded-full" /></td>
      <td className="px-5 py-4"><div className="h-4 w-14 bg-slate-100 rounded" /></td>
      <td className="px-5 py-4"><div className="h-5 w-5 bg-slate-100 rounded" /></td>
    </tr>
  );
}

export default function OrgAdminUserManagementPage() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState({ total: 0, active: 0, pending: 0, suspended: 0, invited: 0 });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState({ msg: null, type: "success" });

  const [showInvite, setShowInvite] = useState(false);
  const [inviteForm, setInviteForm] = useState(EMPTY_FORM);
  const [editUser, setEditUser] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [confirmAction, setConfirmAction] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  const fetchSummary = useCallback(() => {
    setSummaryLoading(true);
    getUserSummary()
      .then((res) => setSummary(res))
      .catch(() => {})
      .finally(() => setSummaryLoading(false));
  }, []);

  const fetchUsers = useCallback((searchTerm, skip) => {
    setLoading(true);
    listUsers({ search: searchTerm, skip, limit: PAGE_SIZE })
      .then((res) => {
        setUsers(res.users || []);
        setTotal(res.total || 0);
        setError(null);
      })
      .catch((err) => setError(err.message || "Failed to load users."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  useEffect(() => {
    setPage(0);
  }, [search]);

  useEffect(() => {
    const t = setTimeout(() => fetchUsers(search, page * PAGE_SIZE), 300);
    return () => clearTimeout(t);
  }, [search, page, fetchUsers]);

  const showToast = (msg, type = "success") => setToast({ msg, type });

  const openInvite = () => {
    setInviteForm(EMPTY_FORM);
    setFormError(null);
    setShowInvite(true);
  };

  const submitInvite = async () => {
    setFormError(null);
    if (!inviteForm.first_name || !inviteForm.last_name || !inviteForm.email) {
      setFormError("First name, last name, and email are required.");
      return;
    }
    setSubmitting(true);
    try {
      await inviteUser(inviteForm);
      setShowInvite(false);
      showToast(`Invitation sent to ${inviteForm.email}.`);
      fetchUsers(search, page * PAGE_SIZE);
      fetchSummary();
    } catch (err) {
      setFormError(err.message || "Failed to invite user.");
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = (u) => {
    setEditUser(u);
    setEditForm({
      first_name: u.first_name,
      last_name: u.last_name,
      phone: u.phone || "",
      role: u.role,
      is_active: u.is_active,
    });
    setFormError(null);
  };

  const submitEdit = async () => {
    setFormError(null);
    setSubmitting(true);
    try {
      await updateUser(editUser.id, editForm);
      setEditUser(null);
      showToast("User updated successfully.");
      fetchUsers(search, page * PAGE_SIZE);
      fetchSummary();
    } catch (err) {
      setFormError(err.message || "Failed to update user.");
    } finally {
      setSubmitting(false);
    }
  };

  const doDeactivate = async () => {
    setSubmitting(true);
    try {
      await deactivateUser(confirmAction.id);
      setConfirmAction(null);
      showToast("User deactivated successfully.");
      fetchUsers(search, page * PAGE_SIZE);
      fetchSummary();
    } catch (err) {
      showToast(err.message || "Failed to deactivate user.", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const doReactivate = async () => {
    setSubmitting(true);
    try {
      await updateUser(confirmAction.id, { is_active: true });
      setConfirmAction(null);
      showToast("User reactivated successfully.");
      fetchUsers(search, page * PAGE_SIZE);
      fetchSummary();
    } catch (err) {
      showToast(err.message || "Failed to reactivate user.", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const doResendInvite = async (u) => {
    try {
      await resendInvite(u.id);
      showToast(`Invite resent to ${u.email}.`);
    } catch (err) {
      showToast(err.message || "Failed to resend invite.", "error");
    }
  };

  const filteredUsers = users.filter((u) => {
    if (statusFilter !== "all") {
      const s = getUserStatus(u);
      if (s !== statusFilter) return false;
    }
    if (roleFilter !== "all" && u.role !== roleFilter) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const canPrev = page > 0;
  const canNext = page < totalPages - 1;

  return (
    <div className="font-['Inter',system-ui,sans-serif]" style={{ color: INK }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold tracking-tight" style={{ color: INK }}>User Management</h1>
          <p className="text-sm mt-0.5" style={{ color: INK_SOFT }}>Invite and manage the people who have access to your organization.</p>
        </div>
        <button
          onClick={openInvite}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold text-white transition-all hover:-translate-y-0.5 hover:shadow-lg"
          style={{ background: `linear-gradient(135deg, ${PRIMARY}, #1D4ED8)`, boxShadow: "0 4px 12px rgba(37,99,235,0.3)" }}
        >
          <Plus className="w-4 h-4" strokeWidth={2.5} />
          Invite User
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {summaryLoading ? (
          <>
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="rounded-xl border p-4 animate-pulse" style={{ background: "#fff", borderColor: LINE }}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-slate-100" />
                  <div className="space-y-1.5">
                    <div className="h-3 w-16 bg-slate-100 rounded" />
                    <div className="h-5 w-8 bg-slate-100 rounded" />
                  </div>
                </div>
              </div>
            ))}
          </>
        ) : (
          <>
            <SummaryCard icon={Users} label="Total" value={summary.total} color={PRIMARY} bg="#EFF6FF" />
            <SummaryCard icon={CheckCircle} label="Active" value={summary.active} color={SUCCESS} bg="#D1FAE5" />
            <SummaryCard icon={Mail} label="Invited" value={summary.invited} color="#7C3AED" bg="#EDE9FE" />
            <SummaryCard icon={Ban} label="Deactivated" value={summary.suspended} color={DANGER} bg="#FEF2F2" />
          </>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border p-4 text-sm flex items-center gap-2" style={{ background: "#FEF2F2", borderColor: "#FECACA", color: DANGER }}>
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
          <button onClick={() => fetchUsers(search, page * PAGE_SIZE)} className="ml-auto text-xs font-semibold underline" style={{ color: DANGER }}>Retry</button>
        </div>
      )}

      <div className="rounded-xl border overflow-hidden shadow-sm" style={{ background: "#fff", borderColor: LINE }}>
        <div className="flex flex-wrap items-center gap-3 px-5 py-3.5 border-b" style={{ borderColor: LINE }}>
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
            <Search className="w-4 h-4" style={{ color: INK_FAINT }} />
            <input
              placeholder="Search by name or email..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 bg-transparent outline-none text-sm"
              style={{ color: INK }}
            />
            {search && (
              <button onClick={() => setSearch("")} className="p-0.5 rounded hover:bg-slate-100 transition-colors">
                <X className="w-3.5 h-3.5" style={{ color: INK_FAINT }} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 p-0.5 rounded-lg" style={{ background: "#F8FAFC" }}>
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setStatusFilter(f.key)}
                  className="px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-all"
                  style={{
                    background: statusFilter === f.key ? "#fff" : "transparent",
                    color: statusFilter === f.key ? INK : INK_FAINT,
                    boxShadow: statusFilter === f.key ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="relative">
              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
                className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border appearance-none cursor-pointer outline-none transition-colors focus:border-blue-400"
                style={{ borderColor: LINE, color: roleFilter === "all" ? INK_FAINT : INK_SOFT, background: "#fff" }}
              >
                <option value="all">All Roles</option>
                {Object.values(ROLES).filter(r => r !== ROLES.SUPER_ADMIN).map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
              <Filter className="w-3 h-3 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: INK_FAINT }} />
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["User", "Role", "Status", "Last Active", "Actions"].map((h, i) => (
                  <th
                    key={h}
                    className="text-left text-[11px] font-bold uppercase tracking-wider px-5 py-3"
                    style={{
                      color: INK_SOFT,
                      borderBottom: `2px solid ${LINE}`,
                      ...(i === 4 ? { textAlign: "right" } : {}),
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <>
                  <SkeletonRow />
                  <SkeletonRow />
                  <SkeletonRow />
                  <SkeletonRow />
                  <SkeletonRow />
                </>
              ) : filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-16 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: "#EFF6FF" }}>
                        <UserPlus className="w-6 h-6" style={{ color: PRIMARY }} />
                      </div>
                      <div>
                        <p className="text-sm font-semibold" style={{ color: INK }}>{search ? "No users match your search" : "No users yet"}</p>
                        <p className="text-xs mt-0.5" style={{ color: INK_FAINT }}>{search ? "Try a different search term" : "Invite your first team member to get started."}</p>
                      </div>
                      {!search && (
                        <button onClick={openInvite} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold text-white transition-all hover:-translate-y-0.5" style={{ background: PRIMARY }}>
                          <Plus className="w-3.5 h-3.5" />
                          Invite User
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                filteredUsers.map((u) => (
                  <tr key={u.id} className="transition-colors hover:bg-slate-50/60">
                    <td className="px-5 py-3.5" style={{ borderBottom: `1px solid ${LINE}` }}>
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg flex items-center justify-center font-bold text-xs text-white flex-shrink-0" style={{ background: "linear-gradient(135deg, #2563EB, #1D4ED8)" }}>
                          {initials(u.first_name, u.last_name)}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold truncate" style={{ color: INK }}>{u.first_name} {u.last_name}</p>
                          <p className="text-xs truncate" style={{ color: INK_FAINT }}>{u.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5" style={{ borderBottom: `1px solid ${LINE}` }}>
                      <span className="inline-flex items-center text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: "#EFF6FF", color: "#2563EB" }}>
                        {ROLE_LABELS[u.role] || u.role}
                      </span>
                    </td>
                    <td className="px-5 py-3.5" style={{ borderBottom: `1px solid ${LINE}` }}>
                      <StatusPill active={u.is_active} verified={u.is_verified} />
                    </td>
                    <td className="px-5 py-3.5" style={{ borderBottom: `1px solid ${LINE}` }}>
                      <div className="flex items-center gap-1.5">
                        <Clock className="w-3 h-3" style={{ color: INK_FAINT }} />
                        <span className="text-xs" style={{ color: INK_SOFT }}>{formatLastActive(u.last_login_at)}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5" style={{ borderBottom: `1px solid ${LINE}` }}>
                      <div className="flex items-center justify-end gap-1.5">
                        {!u.is_verified && u.is_active && (
                          <button
                            className="p-1.5 rounded-lg border transition-colors hover:bg-amber-50"
                            style={{ borderColor: LINE, color: WARNING }}
                            title="Resend invitation"
                            onClick={() => doResendInvite(u)}
                          >
                            <Mail className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          className="p-1.5 rounded-lg border transition-colors hover:bg-slate-50"
                          style={{ borderColor: LINE, color: INK_SOFT }}
                          title="Edit user"
                          onClick={() => openEdit(u)}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        {u.is_verified && u.is_active && (
                          <button
                            className="p-1.5 rounded-lg border transition-colors hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
                            style={{ borderColor: LINE, color: DANGER }}
                            title="Deactivate"
                            disabled={u.id === currentUser?.id}
                            onClick={() => setConfirmAction({ ...u, action: "deactivate" })}
                          >
                            <Ban className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {u.is_verified && !u.is_active && (
                          <button
                            className="p-1.5 rounded-lg border transition-colors hover:bg-emerald-50"
                            style={{ borderColor: LINE, color: SUCCESS }}
                            title="Reactivate"
                            onClick={() => setConfirmAction({ ...u, action: "reactivate" })}
                          >
                            <Play className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {!loading && total > 0 && (
          <div className="flex items-center justify-between px-5 py-3 border-t" style={{ borderColor: LINE, background: "#FAFAFA" }}>
            <p className="text-xs" style={{ color: INK_FAINT }}>
              Showing <span className="font-semibold" style={{ color: INK_SOFT }}>{filteredUsers.length}</span> of <span className="font-semibold" style={{ color: INK_SOFT }}>{total}</span> user{total === 1 ? "" : "s"}
            </p>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={!canPrev}
                className="p-1.5 rounded-lg border transition-colors disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-50"
                style={{ borderColor: LINE, color: INK_SOFT }}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs font-semibold px-2" style={{ color: INK_SOFT }}>
                {page + 1} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={!canNext}
                className="p-1.5 rounded-lg border transition-colors disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-50"
                style={{ borderColor: LINE, color: INK_SOFT }}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {toast.msg && (
        <div
          className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl text-sm font-semibold text-white shadow-xl animate-[slideUp_0.3s_ease-out]"
          style={{ background: toast.type === "success" ? SUCCESS : DANGER }}
        >
          {toast.type === "success" ? <CheckCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {toast.msg}
          <button onClick={() => setToast({ msg: null })} className="ml-1 p-0.5 hover:opacity-70 transition-opacity">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {showInvite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setShowInvite(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[88vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-4 border-b" style={{ borderColor: LINE }}>
              <div>
                <h2 className="text-lg font-bold" style={{ color: INK }}>Invite User</h2>
                <p className="text-xs mt-0.5" style={{ color: INK_FAINT }}>They'll receive an email to set up their password.</p>
              </div>
              <button onClick={() => setShowInvite(false)} className="p-1.5 rounded-lg border hover:bg-slate-50 transition-colors" style={{ borderColor: LINE }}>
                <X className="w-4 h-4" style={{ color: INK_SOFT }} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4 overflow-y-auto">
              {formError && (
                <p className="text-xs font-medium px-3 py-2 rounded-lg" style={{ background: "#FEF2F2", color: DANGER }}>{formError}</p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: INK_SOFT }}>First name *</label>
                  <input
                    value={inviteForm.first_name}
                    onChange={(e) => setInviteForm({ ...inviteForm, first_name: e.target.value })}
                    className="w-full text-sm px-3 py-2.5 rounded-lg border outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    style={{ borderColor: LINE, color: INK }}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: INK_SOFT }}>Last name *</label>
                  <input
                    value={inviteForm.last_name}
                    onChange={(e) => setInviteForm({ ...inviteForm, last_name: e.target.value })}
                    className="w-full text-sm px-3 py-2.5 rounded-lg border outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    style={{ borderColor: LINE, color: INK }}
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: INK_SOFT }}>Email *</label>
                <input
                  type="email"
                  value={inviteForm.email}
                  onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })}
                  className="w-full text-sm px-3 py-2.5 rounded-lg border outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  style={{ borderColor: LINE, color: INK }}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: INK_SOFT }}>Phone (optional)</label>
                  <input
                    value={inviteForm.phone}
                    onChange={(e) => setInviteForm({ ...inviteForm, phone: e.target.value })}
                    className="w-full text-sm px-3 py-2.5 rounded-lg border outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    style={{ borderColor: LINE, color: INK }}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: INK_SOFT }}>Role</label>
                  <select
                    value={inviteForm.role}
                    onChange={(e) => setInviteForm({ ...inviteForm, role: e.target.value })}
                    className="w-full text-sm px-3 py-2.5 rounded-lg border outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100 bg-white"
                    style={{ borderColor: LINE, color: INK }}
                  >
                    {INVITABLE_ROLES.map((r) => (
                      <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                    ))}
                  </select>
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm" style={{ color: INK_SOFT }}>
                <input
                  type="checkbox"
                  checked={inviteForm.send_invite}
                  onChange={(e) => setInviteForm({ ...inviteForm, send_invite: e.target.checked })}
                  className="rounded"
                />
                Send invitation email now
              </label>
            </div>
            <div className="flex justify-end gap-2.5 px-6 py-4 border-t" style={{ borderColor: LINE, background: "#FAFAFA" }}>
              <button
                className="px-4 py-2 rounded-lg text-sm font-medium border transition-colors hover:bg-slate-50"
                style={{ borderColor: LINE, color: INK_SOFT }}
                onClick={() => setShowInvite(false)}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 rounded-lg text-sm font-semibold text-white transition-all disabled:opacity-50"
                style={{ background: PRIMARY }}
                onClick={submitInvite}
                disabled={submitting}
              >
                {submitting ? "Sending..." : "Send Invite"}
              </button>
            </div>
          </div>
        </div>
      )}

      {editUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setEditUser(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[88vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-4 border-b" style={{ borderColor: LINE }}>
              <div>
                <h2 className="text-lg font-bold" style={{ color: INK }}>Edit User</h2>
                <p className="text-xs mt-0.5" style={{ color: INK_FAINT }}>{editUser.email}</p>
              </div>
              <button onClick={() => setEditUser(null)} className="p-1.5 rounded-lg border hover:bg-slate-50 transition-colors" style={{ borderColor: LINE }}>
                <X className="w-4 h-4" style={{ color: INK_SOFT }} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4 overflow-y-auto">
              {formError && (
                <p className="text-xs font-medium px-3 py-2 rounded-lg" style={{ background: "#FEF2F2", color: DANGER }}>{formError}</p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: INK_SOFT }}>First name</label>
                  <input
                    value={editForm.first_name}
                    onChange={(e) => setEditForm({ ...editForm, first_name: e.target.value })}
                    className="w-full text-sm px-3 py-2.5 rounded-lg border outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    style={{ borderColor: LINE, color: INK }}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: INK_SOFT }}>Last name</label>
                  <input
                    value={editForm.last_name}
                    onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })}
                    className="w-full text-sm px-3 py-2.5 rounded-lg border outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    style={{ borderColor: LINE, color: INK }}
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: INK_SOFT }}>Phone</label>
                <input
                  value={editForm.phone}
                  onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                  className="w-full text-sm px-3 py-2.5 rounded-lg border outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  style={{ borderColor: LINE, color: INK }}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: INK_SOFT }}>Role</label>
                <select
                  value={editForm.role}
                  onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
                  className="w-full text-sm px-3 py-2.5 rounded-lg border outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100 bg-white"
                  style={{ borderColor: LINE, color: INK }}
                >
                  {Object.values(ROLES).filter(r => r !== ROLES.SUPER_ADMIN).map((r) => (
                    <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                  ))}
                </select>
              </div>
              {editUser.id !== currentUser?.id && (
                <label className="flex items-center gap-2 text-sm" style={{ color: INK_SOFT }}>
                  <input
                    type="checkbox"
                    checked={editForm.is_active}
                    onChange={(e) => setEditForm({ ...editForm, is_active: e.target.checked })}
                    className="rounded"
                  />
                  Active
                </label>
              )}
            </div>
            <div className="flex justify-end gap-2.5 px-6 py-4 border-t" style={{ borderColor: LINE, background: "#FAFAFA" }}>
              <button
                className="px-4 py-2 rounded-lg text-sm font-medium border transition-colors hover:bg-slate-50"
                style={{ borderColor: LINE, color: INK_SOFT }}
                onClick={() => setEditUser(null)}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 rounded-lg text-sm font-semibold text-white transition-all disabled:opacity-50"
                style={{ background: PRIMARY }}
                onClick={submitEdit}
                disabled={submitting}
              >
                {submitting ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmAction && (
        <ConfirmDialog
          title={confirmAction.action === "deactivate" ? "Deactivate User" : "Reactivate User"}
          message={
            confirmAction.action === "deactivate"
              ? `${confirmAction.first_name} ${confirmAction.last_name} will lose access immediately. This can be reversed by reactivating the user later.`
              : `${confirmAction.first_name} ${confirmAction.last_name} will regain access to the organization.`
          }
          confirmLabel={confirmAction.action === "deactivate" ? "Deactivate" : "Reactivate"}
          busy={submitting}
          onConfirm={confirmAction.action === "deactivate" ? doDeactivate : doReactivate}
          onClose={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}
