import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../../context/AuthContext";
import {
  listUsers,
  inviteUser,
  updateUser,
  deactivateUser,
  resendInvite,
} from "../../service/userManagementService";
import ConfirmDialog from "../../components/ConfirmDialog";
import { ROLE_LABELS } from "../../config/roles";
import {
  X,
  CheckCircle,
  AlertTriangle,
  Plus,
  Search,
  Mail,
  Pencil,
  Ban,
} from "lucide-react";

const styles = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,500&family=Inter:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500&display=swap');

  .org-dash{
    --bg:#F7F5F1;
    --glass: rgba(255,255,255,0.72);
    --glass-solid:#FFFFFF;
    --glass-border: rgba(28,24,40,0.08);
    --ink:#1C1826;
    --ink-soft:#635C72;
    --ink-faint:#9D96AB;
    --violet:#6E5AE6;
    --violet-deep:#4B3BB0;
    --violet-soft: rgba(110,90,230,0.10);
    --amber:#D9791E;
    --amber-deep:#B8600F;
    --amber-soft: rgba(217,121,30,0.12);
    --success:#178A50;
    --success-soft:rgba(23,138,80,0.11);
    --danger:#D6304C;
    --danger-soft:rgba(214,48,76,0.10);
    --radius:18px;

    position:relative;
    background:var(--bg);
    color:var(--ink);
    font-family:'Inter', sans-serif;
    -webkit-font-smoothing:antialiased;
    min-height:100vh;
    overflow-x:clip;
    isolation:isolate;
  }
  .org-dash *{ box-sizing:border-box; }

  .org-dash .orb{ position:absolute; border-radius:50%; filter:blur(100px); z-index:0; pointer-events:none; }
  .org-dash .orb-1{ width:560px; height:560px; top:-220px; right:-160px; background:radial-gradient(circle, rgba(110,90,230,0.16), transparent 70%); }
  .org-dash .orb-2{ width:480px; height:480px; bottom:-200px; left:-160px; background:radial-gradient(circle, rgba(217,121,30,0.14), transparent 70%); }

  .org-dash .page{ position:relative; z-index:2; max-width:1180px; margin:0 auto; padding:44px 32px 90px; }

  @keyframes org-rise{ from{ opacity:0; transform:translateY(14px);} to{ opacity:1; transform:translateY(0);} }
  .org-dash .rise{ animation:org-rise .6s cubic-bezier(.2,.7,.3,1) both; }
  @media (prefers-reduced-motion: reduce){ .org-dash .rise{ animation:none; } }

  .org-dash .hero{
    display:flex; align-items:center; justify-content:space-between; gap:24px;
    margin-bottom:22px; flex-wrap:wrap;
  }
  .org-dash h1.title{
    font-family:'Fraunces', serif; font-weight:600; font-size:52px; line-height:1.2;
    margin:0 0 12px; letter-spacing:-0.015em;
    background:linear-gradient(100deg, var(--ink) 25%, var(--amber-deep) 62%, var(--violet-deep) 100%);
    -webkit-background-clip:text; background-clip:text; color:transparent;
  }
  @media (max-width:640px){ .org-dash h1.title{ font-size:38px; } }
  .org-dash .subtitle{ color:var(--ink-soft); font-size:15px; margin:0; max-width:520px; }
  .org-dash .head-actions{ display:flex; gap:10px; flex:none; }

  .org-dash .btn{
    font-family:'Inter', sans-serif; font-size:13.5px; font-weight:600;
    padding:12px 20px; border-radius:11px; cursor:pointer;
    display:inline-flex; align-items:center; gap:8px; border:1px solid transparent;
    transition:transform .18s ease, box-shadow .18s ease, background .18s ease, border-color .18s ease;
    white-space:nowrap;
  }
  .org-dash .btn:hover{ transform:translateY(-2px); }
  .org-dash .btn-primary{
    background:linear-gradient(120deg, var(--amber), var(--violet));
    color:#fff; box-shadow:0 10px 26px -10px rgba(110,90,230,0.5);
  }
  .org-dash .btn-primary:hover{ box-shadow:0 14px 32px -10px rgba(110,90,230,0.65); }
  .org-dash .btn-ghost{ background:var(--glass-solid); color:var(--ink); border-color:var(--glass-border); box-shadow:0 1px 2px rgba(28,24,40,0.04); }
  .org-dash .btn-ghost:hover{ border-color:rgba(28,24,40,0.18); background:#fff; }
  .org-dash .btn[disabled]{ opacity:0.5; cursor:not-allowed; transform:none; }

  .org-dash .glass{
    background:var(--glass); border:1px solid var(--glass-border); border-radius:var(--radius);
    backdrop-filter:blur(18px); -webkit-backdrop-filter:blur(18px);
    box-shadow:0 1px 0 rgba(255,255,255,0.6) inset, 0 20px 40px -26px rgba(28,24,40,0.16);
  }

  .org-dash .search-bar{
    display:flex; align-items:center; gap:10px; padding:14px 18px; margin-bottom:20px;
  }
  .org-dash .search-bar input{
    flex:1; border:none; outline:none; background:transparent; font-size:13.5px; color:var(--ink);
    font-family:'Inter', sans-serif;
  }
  .org-dash .search-bar svg{ color:var(--ink-faint); flex:none; }

  .org-dash table{ width:100%; border-collapse:collapse; }
  .org-dash thead th{
    text-align:left; font-size:11px; letter-spacing:0.06em; text-transform:uppercase;
    color:var(--ink-faint); padding:14px 20px; border-bottom:1px solid var(--glass-border);
  }
  .org-dash tbody td{ padding:14px 20px; border-bottom:1px solid rgba(28,24,40,0.055); font-size:13.5px; vertical-align:middle; }
  .org-dash tbody tr:last-child td{ border-bottom:none; }
  .org-dash .user-cell{ display:flex; align-items:center; gap:12px; }
  .org-dash .avatar{
    width:34px; height:34px; border-radius:10px; flex:none; display:flex; align-items:center;
    justify-content:center; font-family:'Fraunces', serif; font-weight:600; font-size:13px; color:#fff;
    background:linear-gradient(135deg, var(--violet), var(--violet-deep));
  }
  .org-dash .user-name{ font-weight:600; color:var(--ink); }
  .org-dash .user-email{ color:var(--ink-faint); font-size:12px; }
  .org-dash .role-pill{
    display:inline-flex; align-items:center; font-size:12px; font-weight:600; padding:3px 10px;
    border-radius:100px; background:var(--violet-soft); color:var(--violet-deep);
    border:1px solid rgba(110,90,230,0.22);
  }
  .org-dash .status-pill{
    display:inline-flex; align-items:center; gap:6px; font-size:12.5px; font-weight:600;
    padding:3px 10px 3px 8px; border-radius:100px;
  }
  .org-dash .status-pill .dot{ width:6px; height:6px; border-radius:100px; background:currentColor; }
  .org-dash .row-actions{ display:flex; gap:6px; justify-content:flex-end; }
  .org-dash .icon-btn{
    width:32px; height:32px; border-radius:9px; border:1px solid var(--glass-border); background:var(--glass-solid);
    display:flex; align-items:center; justify-content:center; cursor:pointer; color:var(--ink-soft);
  }
  .org-dash .icon-btn:hover{ border-color:rgba(28,24,40,0.18); color:var(--ink); }
  .org-dash .icon-btn.danger:hover{ color:var(--danger); border-color:rgba(214,48,76,0.3); }
  .org-dash .empty-row{ padding:50px 20px; text-align:center; color:var(--ink-faint); font-size:13.5px; }

  .org-dash .modal-overlay{
    position:fixed; inset:0; z-index:60; display:flex; align-items:center; justify-content:center;
    background:rgba(28,24,40,0.45); backdrop-filter:blur(6px); padding:16px;
  }
  .org-dash .modal{ width:100%; max-width:560px; max-height:88vh; display:flex; flex-direction:column; overflow:hidden; }
  .org-dash .modal-head{
    display:flex; align-items:flex-start; justify-content:space-between; gap:12px;
    padding:22px 26px 18px; border-bottom:1px solid var(--glass-border);
  }
  .org-dash .modal-title{ font-family:'Fraunces', serif; font-weight:600; font-size:20px; margin:0 0 3px; color:var(--ink); }
  .org-dash .modal-sub{ font-size:12px; color:var(--ink-faint); margin:0; }
  .org-dash .modal-close{
    width:32px; height:32px; border-radius:10px; border:1px solid var(--glass-border);
    background:var(--glass-solid); color:var(--ink-soft); cursor:pointer; flex:none;
    display:flex; align-items:center; justify-content:center;
  }
  .org-dash .modal-body{ padding:20px 26px; overflow-y:auto; display:flex; flex-direction:column; gap:16px; }
  .org-dash .form-grid{ display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  .org-dash .form-field label{ display:block; font-size:11.5px; font-weight:600; color:var(--ink-soft); margin-bottom:6px; letter-spacing:0.02em; }
  .org-dash .form-field input, .org-dash .form-field select{
    width:100%; font-family:'Inter', sans-serif; font-size:13.5px; color:var(--ink);
    background:var(--glass-solid); border:1px solid var(--glass-border); border-radius:11px;
    padding:11px 14px; outline:none;
  }
  .org-dash .form-field input:focus, .org-dash .form-field select:focus{
    border-color:rgba(110,90,230,0.5); box-shadow:0 0 0 3px var(--violet-soft);
  }
  .org-dash .checkbox-row{ display:flex; align-items:center; gap:8px; font-size:13px; color:var(--ink-soft); }
  .org-dash .modal-foot{
    display:flex; justify-content:flex-end; gap:10px; padding:16px 26px;
    border-top:1px solid var(--glass-border); background:rgba(28,24,40,0.025);
  }
  .org-dash .field-error{ font-size:12px; color:var(--danger); margin-top:-6px; }

  .org-dash .toast{
    position:fixed; bottom:26px; right:26px; z-index:70;
    display:flex; align-items:center; gap:10px; padding:14px 18px; border-radius:14px;
    font-size:13.5px; font-weight:600; color:#fff; box-shadow:0 18px 40px -14px rgba(28,20,40,0.4);
    animation:org-rise .4s cubic-bezier(.2,.7,.3,1) both;
  }
  .org-dash .toast-success{ background:var(--success); }
  .org-dash .toast-danger{ background:var(--danger); }
  .org-dash .toast button{ background:transparent; border:none; color:#fff; cursor:pointer; padding:2px; display:flex; }
`;

const STATUS_STYLES = {
  active: { bg: "rgba(23,138,80,0.11)", color: "#178A50" },
  pending: { bg: "rgba(217,121,30,0.12)", color: "#B8600F" },
  inactive: { bg: "rgba(28,24,40,0.07)", color: "#635C72" },
};

function StatusPill({ active, verified }) {
  if (!active) {
    return (
      <span className="status-pill" style={{ background: STATUS_STYLES.inactive.bg, color: STATUS_STYLES.inactive.color }}>
        <span className="dot" />
        Deactivated
      </span>
    );
  }
  if (!verified) {
    return (
      <span className="status-pill" style={{ background: STATUS_STYLES.pending.bg, color: STATUS_STYLES.pending.color }}>
        <span className="dot" />
        Pending
      </span>
    );
  }
  return (
    <span className="status-pill" style={{ background: STATUS_STYLES.active.bg, color: STATUS_STYLES.active.color }}>
      <span className="dot" />
      Active
    </span>
  );
}

function initials(first, last) {
  return `${(first || "?")[0] || ""}${(last || "")[0] || ""}`.toUpperCase();
}

const EMPTY_FORM = { first_name: "", last_name: "", email: "", phone: "", role: "billing_admin", send_invite: true };

export default function OrgAdminUserManagementPage() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState({ msg: null, type: "success" });

  const [showInvite, setShowInvite] = useState(false);
  const [inviteForm, setInviteForm] = useState(EMPTY_FORM);
  const [editUser, setEditUser] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [confirmDeactivate, setConfirmDeactivate] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  const fetchUsers = useCallback((searchTerm) => {
    setLoading(true);
    listUsers({ search: searchTerm })
      .then((res) => {
        setUsers(res.users || []);
        setTotal(res.total || 0);
        setError(null);
      })
      .catch((err) => setError(err.message || "Failed to load users."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => fetchUsers(search), 300);
    return () => clearTimeout(t);
  }, [search, fetchUsers]);

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
      fetchUsers(search);
    } catch (err) {
      setFormError(err.message || "Failed to invite user.");
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = (u) => {
    setEditUser(u);
    setEditForm({ first_name: u.first_name, last_name: u.last_name, phone: u.phone || "", role: u.role, is_active: u.is_active });
    setFormError(null);
  };

  const submitEdit = async () => {
    setFormError(null);
    setSubmitting(true);
    try {
      await updateUser(editUser.id, editForm);
      setEditUser(null);
      showToast("User updated successfully.");
      fetchUsers(search);
    } catch (err) {
      setFormError(err.message || "Failed to update user.");
    } finally {
      setSubmitting(false);
    }
  };

  const doDeactivate = async () => {
    setSubmitting(true);
    try {
      await deactivateUser(confirmDeactivate.id);
      setConfirmDeactivate(null);
      showToast("User deactivated.");
      fetchUsers(search);
    } catch (err) {
      showToast(err.message || "Failed to deactivate user.", "error");
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

  return (
    <div className="org-dash">
      <style>{styles}</style>
      <div className="orb orb-1" />
      <div className="orb orb-2" />

      <div className="page">
        <div className="hero rise" style={{ animationDelay: ".05s" }}>
          <div>
            <h1 className="title">User Management</h1>
            <p className="subtitle">Invite and manage the people who have access to your organization.</p>
          </div>
          <div className="head-actions">
            <button className="btn btn-primary" onClick={openInvite}>
              <Plus className="w-4 h-4" /> Invite user
            </button>
          </div>
        </div>

        {error && (
          <div className="glass rise" style={{ padding: 16, marginBottom: 20, color: "var(--danger)", fontSize: 13.5 }}>
            {error}
          </div>
        )}

        <div className="glass search-bar rise" style={{ animationDelay: ".1s" }}>
          <Search className="w-4 h-4" />
          <input
            placeholder="Search by name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="glass rise" style={{ animationDelay: ".15s", overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={4} className="empty-row">Loading users…</td></tr>
                ) : users.length === 0 ? (
                  <tr><td colSpan={4} className="empty-row">No users found.</td></tr>
                ) : (
                  users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <div className="user-cell">
                          <div className="avatar">{initials(u.first_name, u.last_name)}</div>
                          <div>
                            <div className="user-name">{u.first_name} {u.last_name}</div>
                            <div className="user-email">{u.email}</div>
                          </div>
                        </div>
                      </td>
                      <td><span className="role-pill">{ROLE_LABELS[u.role] || u.role}</span></td>
                      <td><StatusPill active={u.is_active} verified={u.is_verified} /></td>
                      <td>
                        <div className="row-actions">
                          {!u.is_verified && (
                            <button className="icon-btn" title="Resend invite" onClick={() => doResendInvite(u)}>
                              <Mail className="w-4 h-4" />
                            </button>
                          )}
                          <button className="icon-btn" title="Edit" onClick={() => openEdit(u)}>
                            <Pencil className="w-4 h-4" />
                          </button>
                          {u.is_verified && (
                            <button
                              className="icon-btn danger"
                              title="Deactivate"
                              disabled={u.id === currentUser?.id}
                              onClick={() => setConfirmDeactivate(u)}
                            >
                              <Ban className="w-4 h-4" />
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
        </div>

        {!loading && total > 0 && (
          <p style={{ marginTop: 14, fontSize: 12.5, color: "var(--ink-faint)" }}>
            Showing {users.length} of {total} user{total === 1 ? "" : "s"}
          </p>
        )}
      </div>

      {toast.msg && (
        <div className={`toast ${toast.type === "success" ? "toast-success" : "toast-danger"}`}>
          {toast.type === "success" ? <CheckCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {toast.msg}
          <button onClick={() => setToast({ msg: null })}><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {showInvite && (
        <div className="modal-overlay" onClick={() => setShowInvite(false)}>
          <div className="glass modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h2 className="modal-title">Invite user</h2>
                <p className="modal-sub">They'll receive an email to set up their password.</p>
              </div>
              <button className="modal-close" onClick={() => setShowInvite(false)}><X className="w-4 h-4" /></button>
            </div>
            <div className="modal-body">
              {formError && <p className="field-error">{formError}</p>}
              <div className="form-grid">
                <div className="form-field">
                  <label>First name</label>
                  <input value={inviteForm.first_name} onChange={(e) => setInviteForm({ ...inviteForm, first_name: e.target.value })} />
                </div>
                <div className="form-field">
                  <label>Last name</label>
                  <input value={inviteForm.last_name} onChange={(e) => setInviteForm({ ...inviteForm, last_name: e.target.value })} />
                </div>
              </div>
              <div className="form-field">
                <label>Email</label>
                <input type="email" value={inviteForm.email} onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })} />
              </div>
              <div className="form-grid">
                <div className="form-field">
                  <label>Phone (optional)</label>
                  <input value={inviteForm.phone} onChange={(e) => setInviteForm({ ...inviteForm, phone: e.target.value })} />
                </div>
                <div className="form-field">
                  <label>Role</label>
                  <select value={inviteForm.role} disabled>
                    <option value="billing_admin">{ROLE_LABELS.billing_admin}</option>
                  </select>
                </div>
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={inviteForm.send_invite}
                  onChange={(e) => setInviteForm({ ...inviteForm, send_invite: e.target.checked })}
                />
                Send invitation email now
              </label>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setShowInvite(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={submitInvite} disabled={submitting}>
                {submitting ? "Inviting…" : "Send invite"}
              </button>
            </div>
          </div>
        </div>
      )}

      {editUser && (
        <div className="modal-overlay" onClick={() => setEditUser(null)}>
          <div className="glass modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h2 className="modal-title">Edit user</h2>
                <p className="modal-sub">{editUser.email}</p>
              </div>
              <button className="modal-close" onClick={() => setEditUser(null)}><X className="w-4 h-4" /></button>
            </div>
            <div className="modal-body">
              {formError && <p className="field-error">{formError}</p>}
              <div className="form-grid">
                <div className="form-field">
                  <label>First name</label>
                  <input value={editForm.first_name} onChange={(e) => setEditForm({ ...editForm, first_name: e.target.value })} />
                </div>
                <div className="form-field">
                  <label>Last name</label>
                  <input value={editForm.last_name} onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })} />
                </div>
              </div>
              <div className="form-field">
                <label>Phone</label>
                <input value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} />
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={editForm.is_active}
                  onChange={(e) => setEditForm({ ...editForm, is_active: e.target.checked })}
                />
                Active
              </label>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setEditUser(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={submitEdit} disabled={submitting}>
                {submitting ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDeactivate && (
        <ConfirmDialog
          title="Deactivate user"
          message={`${confirmDeactivate.first_name} ${confirmDeactivate.last_name} will lose access immediately. This can be reversed by editing the user later.`}
          confirmLabel="Deactivate"
          busy={submitting}
          onConfirm={doDeactivate}
          onClose={() => setConfirmDeactivate(null)}
        />
      )}
    </div>
  );
}
