import { useState, useEffect } from "react";
import { getOrganizationDetails, updateOrganizationDetails } from "../../service/orgAdminService";
import { X, CheckCircle, AlertTriangle } from "lucide-react";

// Palette + type match the Login page: Inter/JetBrains Mono, blue/navy primary,
// emerald success, red danger, slate ink. See src/pages/LoginPage.jsx.
const styles = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;600;700&display=swap');

  .org-dash{
    --bg:#F8FAFC;
    --glass: rgba(255,255,255,0.85);
    --glass-solid:#FFFFFF;
    --glass-border: #E5E7EB;
    --ink:#0F172A;
    --ink-soft:#374151;
    --ink-faint:#9CA3AF;
    --primary:#2563EB;
    --primary-deep:#1D4ED8;
    --primary-soft: rgba(37,99,235,0.08);
    --accent:#60A5FA;
    --success:#059669;
    --success-soft:rgba(5,150,105,0.10);
    --danger:#DC2626;
    --danger-soft:#FEF2F2;
    --radius:14px;

    position:relative;
    background:var(--bg);
    color:var(--ink);
    font-family:'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    -webkit-font-smoothing:antialiased;
    min-height:100vh;
    overflow-x:clip;
    isolation:isolate;
  }
  .org-dash *{ box-sizing:border-box; }

  .org-dash .orb{ position:absolute; border-radius:50%; filter:blur(100px); z-index:0; pointer-events:none; }
  .org-dash .orb-1{ width:560px; height:560px; top:-220px; right:-160px; background:radial-gradient(circle, rgba(37,99,235,0.08), transparent 70%); }
  .org-dash .orb-2{ width:480px; height:480px; bottom:-200px; left:-160px; background:radial-gradient(circle, rgba(37,99,235,0.06), transparent 70%); }

  .org-dash .page{ position:relative; z-index:2; max-width:1180px; margin:0 auto; padding:44px 32px 90px; }

  @keyframes org-rise{ from{ opacity:0; transform:translateY(14px);} to{ opacity:1; transform:translateY(0);} }
  .org-dash .rise{ animation:org-rise .6s cubic-bezier(.2,.7,.3,1) both; }
  @media (prefers-reduced-motion: reduce){ .org-dash .rise{ animation:none; } }

  .org-dash .hero{
    display:flex; align-items:center; justify-content:space-between; gap:24px;
    margin-bottom:22px; flex-wrap:wrap;
  }
  .org-dash h1.title{
    font-family:'Inter', sans-serif; font-weight:800; font-size:32px; line-height:1.2;
    margin:0 0 12px; letter-spacing:-0.5px; color:var(--ink);
  }
  @media (max-width:640px){ .org-dash h1.title{ font-size:26px; } }
  .org-dash .subtitle{ color:var(--ink-soft); font-size:15px; margin:0; max-width:520px; }
  .org-dash .head-actions{ display:flex; gap:10px; flex:none; }

  .org-dash .btn{
    font-family:'Inter', sans-serif; font-size:13.5px; font-weight:600;
    padding:12px 22px; border-radius:50px; cursor:pointer;
    display:inline-flex; align-items:center; gap:8px; border:1px solid transparent;
    transition:transform .18s ease, box-shadow .18s ease, background .18s ease, border-color .18s ease;
    white-space:nowrap;
  }
  .org-dash .btn:hover{ transform:translateY(-2px); }
  .org-dash .btn-primary{
    background:linear-gradient(135deg, var(--primary), var(--primary-deep));
    color:#fff; box-shadow:0 4px 16px rgba(37,99,235,0.35);
  }
  .org-dash .btn-primary:hover{ box-shadow:0 8px 22px rgba(37,99,235,0.45); }
  .org-dash .btn-ghost{ background:var(--glass-solid); color:var(--ink-soft); border-color:var(--glass-border); border-radius:8px; }
  .org-dash .btn-ghost:hover{ border-color:#D1D5DB; background:#F9FAFB; }
  .org-dash .btn[disabled]{ opacity:0.5; cursor:not-allowed; transform:none; }

  .org-dash .glass{
    background:var(--glass-solid); border:1.5px solid var(--glass-border); border-radius:var(--radius);
    box-shadow:0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10);
    transition:border-color .2s ease, transform .2s ease, box-shadow .2s ease;
  }
  .org-dash .glass:hover{ border-color:#D1D5DB; }

  .org-dash .id-card{
    padding:26px 30px; display:flex; align-items:center; justify-content:space-between;
    gap:24px; margin:30px 0 20px; flex-wrap:wrap; position:relative; overflow:hidden;
  }
  .org-dash .id-left{ display:flex; align-items:center; gap:18px; }
  .org-dash .org-mark{
    width:60px; height:60px; border-radius:16px; flex:none; position:relative;
    background:linear-gradient(135deg, var(--primary), var(--primary-deep));
    display:flex; align-items:center; justify-content:center;
    box-shadow:0 4px 16px rgba(37,99,235,0.35);
  }
  .org-dash .org-mark svg{ width:27px; height:27px; }
  .org-dash .org-name{ font-family:'Inter', sans-serif; font-weight:800; font-size:22px; margin:0 0 8px; color:var(--ink); letter-spacing:-0.3px; }
  .org-dash .org-meta{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; font-size:13px; color:var(--ink-soft); }
  .org-dash .code-tag{
    font-family:'JetBrains Mono', monospace; font-size:11.5px; letter-spacing:0.03em;
    background:var(--primary-soft); color:var(--primary-deep); border:1px solid rgba(37,99,235,0.22);
    padding:3px 9px; border-radius:6px;
  }
  .org-dash .status-pill{
    display:inline-flex; align-items:center; gap:6px; font-size:12.5px; font-weight:600;
    padding:3px 10px 3px 8px; border-radius:100px; background:var(--success-soft); color:var(--success);
    border:1px solid rgba(5,150,105,0.22);
  }
  .org-dash .status-pill .dot{ width:6px; height:6px; border-radius:100px; background:currentColor; box-shadow:0 0 6px currentColor; }
  .org-dash .dim{ color:var(--ink-faint); }

  .org-dash .banner{
    display:flex; align-items:flex-start; gap:14px; padding:17px 20px; margin-bottom:32px;
    border-radius:8px; background:var(--danger-soft); border:1px solid #FECACA;
  }
  .org-dash .banner-icon{
    width:30px; height:30px; border-radius:9px; background:rgba(220,38,38,0.12);
    border:1px solid rgba(220,38,38,0.3); display:flex; align-items:center; justify-content:center;
    flex:none; color:var(--danger); font-weight:700; font-size:15px;
  }
  .org-dash .banner-text{ font-size:13.5px; line-height:1.6; color:#7F1D1D; }
  .org-dash .banner-text b{ color:var(--danger); }

  .org-dash .stat-strip{ display:grid; grid-template-columns:repeat(3, 1fr); gap:16px; margin-bottom:20px; }
  @media (max-width:860px){ .org-dash .stat-strip{ grid-template-columns:repeat(1, 1fr); } }
  .org-dash .stat-tile{ padding:22px 22px 20px; position:relative; overflow:hidden; }
  .org-dash .stat-tile .glow{
    position:absolute; width:120px; height:120px; border-radius:50%; filter:blur(44px);
    top:-40px; right:-30px; opacity:0.18; pointer-events:none;
  }
  .org-dash .stat-label{ font-size:11.5px; letter-spacing:0.06em; text-transform:uppercase; color:var(--ink-faint); margin:0 0 12px; }
  .org-dash .stat-value{ font-family:'Inter', sans-serif; font-size:30px; font-weight:800; margin:0; line-height:1; color:var(--ink); letter-spacing:-0.01em; }
  .org-dash .stat-sub{ font-size:12px; color:var(--ink-faint); margin-top:8px; }

  .org-dash .grid{ display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px; }
  @media (max-width:860px){ .org-dash .grid{ grid-template-columns:1fr; } }

  .org-dash .panel-head{
    display:flex; align-items:center; gap:12px; padding:20px 24px; border-bottom:1px solid var(--glass-border);
  }
  .org-dash .panel-icon{
    width:34px; height:34px; border-radius:10px; flex:none;
    display:flex; align-items:center; justify-content:center;
  }
  .org-dash .icon-violet{ background:var(--primary-soft); color:var(--primary-deep); border:1px solid rgba(37,99,235,0.2); }
  .org-dash .icon-amber{ background:var(--primary-soft); color:var(--primary-deep); border:1px solid rgba(37,99,235,0.2); }
  .org-dash .panel-title{ font-size:14.5px; font-weight:600; margin:0 0 2px; color:var(--ink); }
  .org-dash .panel-sub{ font-size:12px; color:var(--ink-faint); margin:0; }

  .org-dash .rows{ padding:6px 24px 18px; }
  .org-dash .row{
    display:flex; align-items:center; justify-content:space-between;
    padding:13px 0; border-bottom:1px solid #F3F4F6;
    font-size:13.5px;
  }
  .org-dash .row:last-child{ border-bottom:none; }
  .org-dash .row .label{ color:var(--ink-soft); }
  .org-dash .row .value{ font-weight:600; color:var(--ink); text-align:right; }
  .org-dash .row .value.mono{ font-family:'JetBrains Mono', monospace; font-weight:500; font-size:13px; }
  .org-dash .row .value.faint{ color:var(--ink-faint); font-weight:500; }

  .org-dash .modal-overlay{
    position:fixed; inset:0; z-index:60; display:flex; align-items:center; justify-content:center;
    background:rgba(15,23,42,0.45); padding:16px;
  }
  .org-dash .modal{
    width:100%; max-width:560px; max-height:88vh; display:flex; flex-direction:column; overflow:hidden;
  }
  .org-dash .modal-head{
    display:flex; align-items:flex-start; justify-content:space-between; gap:12px;
    padding:22px 26px 18px; border-bottom:1px solid var(--glass-border);
  }
  .org-dash .modal-title{ font-family:'Inter', sans-serif; font-weight:800; font-size:19px; margin:0 0 3px; color:var(--ink); letter-spacing:-0.3px; }
  .org-dash .modal-sub{ font-size:12px; color:var(--ink-faint); margin:0; }
  .org-dash .modal-close{
    width:32px; height:32px; border-radius:8px; border:1px solid var(--glass-border);
    background:var(--glass-solid); color:var(--ink-soft); cursor:pointer; flex:none;
    display:flex; align-items:center; justify-content:center;
  }
  .org-dash .modal-close:hover{ color:var(--ink); border-color:#D1D5DB; }
  .org-dash .modal-body{ padding:20px 26px; overflow-y:auto; display:flex; flex-direction:column; gap:16px; }
  .org-dash .form-grid{ display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  .org-dash .form-field label{ display:block; font-size:13px; font-weight:500; color:var(--ink-soft); margin-bottom:6px; }
  .org-dash .form-field input, .org-dash .form-field textarea{
    width:100%; font-family:'Inter', sans-serif; font-size:14px; color:#111827;
    background:#fff; border:1.5px solid var(--glass-border); border-radius:8px;
    padding:11px 14px; outline:none; transition:border-color .18s ease, box-shadow .18s ease;
  }
  .org-dash .form-field input:focus, .org-dash .form-field textarea:focus{
    border-color:var(--primary); box-shadow:0 0 0 3px var(--primary-soft);
  }
  .org-dash .form-field .mono{ font-family:'JetBrains Mono', monospace; font-size:13px; }
  .org-dash .modal-foot{
    display:flex; justify-content:flex-end; gap:10px; padding:16px 26px;
    border-top:1px solid var(--glass-border); background:#F9FAFB;
  }

  .org-dash .toast{
    position:fixed; bottom:26px; right:26px; z-index:70;
    display:flex; align-items:center; gap:10px; padding:14px 18px; border-radius:8px;
    font-size:13.5px; font-weight:600; color:#fff; box-shadow:0 18px 40px -14px rgba(15,23,42,0.4);
    animation:org-rise .4s cubic-bezier(.2,.7,.3,1) both;
  }
  .org-dash .toast-success{ background:var(--success); }
  .org-dash .toast-danger{ background:var(--danger); }
  .org-dash .toast button{
    background:transparent; border:none; color:#fff; cursor:pointer; padding:2px; display:flex; align-items:center;
    border-radius:6px; margin-left:2px;
  }
  .org-dash .toast button:hover{ background:rgba(255,255,255,0.18); }
`;

const STATUS_STYLES = {
  active: { bg: "rgba(5,150,105,0.10)", color: "#059669", border: "rgba(5,150,105,0.22)" },
  deactivated: { bg: "#F3F4F6", color: "#374151", border: "#E5E7EB" },
};

function StatusPill({ status }) {
  if (!status) return <span className="dim">—</span>;
  const s = STATUS_STYLES[status] || STATUS_STYLES.deactivated;
  return (
    <span className="status-pill" style={{ background: s.bg, color: s.color, borderColor: s.border }}>
      <span className="dot" />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

const DetailRow = ({ label, value, mono, faint, pill }) => (
  <div className="row">
    <span className="label">{label}</span>
    {pill ? (
      <span className="value"><StatusPill status={value} /></span>
    ) : (
      <span className={`value ${mono ? "mono" : ""} ${faint ? "faint" : ""}`}>{value || "—"}</span>
    )}
  </div>
);

const StatTile = ({ glowColor, label, value, sub, valueColor }) => (
  <div className="glass stat-tile">
    <div className="glow" style={{ background: glowColor }} />
    <p className="stat-label">{label}</p>
    <p className="stat-value" style={valueColor ? { color: valueColor } : undefined}>{value}</p>
    <p className="stat-sub">{sub}</p>
  </div>
);

export default function OrgAdminOrganizationPage() {
  const [org, setOrg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showEdit, setShowEdit] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState({ msg: null, type: "success" });

  const fetchOrg = () => {
    setLoading(true);
    getOrganizationDetails()
      .then(setOrg)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchOrg(); }, []);

  const openEdit = () => {
    setEditForm({
      name: org.name || "",
      industry: org.industry || "",
      address: org.address || "",
      timezone: org.timezone || "UTC",
      currency: org.currency,
    });
    setShowEdit(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateOrganizationDetails(editForm);
      setShowEdit(false);
      setToast({ msg: "Organization updated successfully.", type: "success" });
      fetchOrg();
    } catch (err) {
      setToast({ msg: err.message || "Failed to update.", type: "error" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="org-dash">
        <style>{styles}</style>
        <div className="orb orb-1" />
        <div className="orb orb-2" />
        <div className="page">
          <div className="glass" style={{ padding: 60, textAlign: "center" }}>
            <div className="dim">Loading organization details...</div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="org-dash">
        <style>{styles}</style>
        <div className="orb orb-1" />
        <div className="orb orb-2" />
        <div className="page">
          <div className="banner">
            <div className="banner-icon">!</div>
            <div className="banner-text"><b>{error}</b></div>
          </div>
        </div>
      </div>
    );
  }

  const totalCustomers = org.total_customers || 0;
  const activeCustomers = org.active_customers || 0;
  const billingAdmins = org.billing_admins || 0;
  const currency = org.currency;
  const regDate = org.created_at ? new Date(org.created_at).toLocaleDateString() : "—";

  const EditField = ({ label, value, onChange, textarea, mono }) => {
    const Tag = textarea ? "textarea" : "input";
    return (
      <div className="form-field">
        <label>{label}</label>
        <Tag
          type="text"
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          rows={textarea ? 3 : undefined}
          className={mono ? "mono" : undefined}
        />
      </div>
    );
  };

  return (
    <div className="org-dash">
      <style>{styles}</style>
      <div className="orb orb-1" />
      <div className="orb orb-2" />

      <div className="page">

        <div className="hero rise" style={{ animationDelay: ".05s" }}>
          <div>
            <h1 className="title">My Organization</h1>
            <p className="subtitle">A live record of your organization's identity and billing activity.</p>
          </div>
          <div className="head-actions">
            <button className="btn btn-primary" onClick={openEdit}>Edit organization</button>
          </div>
        </div>

        <div className="id-card glass rise" style={{ animationDelay: ".1s" }}>
          <div className="id-left">
            <div className="org-mark">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 21V7L12 3L20 7V21H4Z" stroke="#fff" strokeWidth="1.7" strokeLinejoin="round" />
                <path d="M9 21V14H15V21" stroke="#fff" strokeWidth="1.7" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <p className="org-name">{org.name}</p>
              <div className="org-meta">
                <span className="code-tag">{org.code}</span>
                <StatusPill status={org.status} />
                <span className="dim">·</span>
                <span>Admin&nbsp;<b style={{ color: "var(--ink)" }}>{org.admin_name || "—"}</b></span>
                <span className="dim">·</span>
                <span>{org.admin_email || "—"}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="stat-strip rise" style={{ animationDelay: ".2s" }}>
          <StatTile glowColor="var(--primary)" label="Total Customers" value={totalCustomers} sub="Across your organization" />
          <StatTile glowColor="var(--success)" label="Active Customers" value={activeCustomers} sub={`${Math.round((activeCustomers / Math.max(totalCustomers, 1)) * 100)}% of customer base`} valueColor="var(--success)" />
          <StatTile glowColor="var(--accent)" label="Billing Admins" value={billingAdmins} sub="Users with billing access" valueColor="var(--primary-deep)" />
        </div>

        <div className="grid rise" style={{ animationDelay: ".25s" }}>
          <div className="glass">
            <div className="panel-head">
              <div className="panel-icon icon-violet">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 7h16M4 12h16M4 17h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </div>
              <div>
                <p className="panel-title">Organization details</p>
                <p className="panel-sub">Core identity information</p>
              </div>
            </div>
            <div className="rows">
              <DetailRow label="Organization Name" value={org.name} />
              <DetailRow label="Organization Code" value={org.code} mono />
              <DetailRow label="Organization Admin" value={org.admin_name} />
              <DetailRow label="Admin Email" value={org.admin_email} />
              <DetailRow label="Organization Status" value={org.status} pill />
            </div>
          </div>

          <div className="glass">
            <div className="panel-head">
              <div className="panel-icon icon-amber">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.8" /><path d="M3 10h18" stroke="currentColor" strokeWidth="1.8" /></svg>
              </div>
              <div>
                <p className="panel-title">Billing settings</p>
                <p className="panel-sub">Defaults used across invoices and subscriptions</p>
              </div>
            </div>
            <div className="rows">
              <DetailRow label="Industry" value={org.industry} />
              <DetailRow label="Address" value={org.address} />
              <DetailRow label="Currency" value={currency} mono />
              <DetailRow label="Timezone" value={org.timezone || "UTC"} mono />
              <DetailRow label="Registration Date" value={regDate} mono />
            </div>
          </div>
        </div>

      </div>

      {toast.msg && (
        <div className={`toast ${toast.type === "success" ? "toast-success" : "toast-danger"}`}>
          {toast.type === "success" ? <CheckCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {toast.msg}
          <button onClick={() => setToast({ msg: null })}><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {showEdit && (
        <div className="modal-overlay" onClick={() => setShowEdit(false)}>
          <div className="glass modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h2 className="modal-title">Edit Organization</h2>
                <p className="modal-sub">Update your organization details</p>
              </div>
              <button className="modal-close" onClick={() => setShowEdit(false)}><X className="w-4 h-4" /></button>
            </div>
            <div className="modal-body">
              <EditField label="Organization Name" value={editForm.name} onChange={(v) => setEditForm({ ...editForm, name: v })} />
              <EditField label="Industry" value={editForm.industry} onChange={(v) => setEditForm({ ...editForm, industry: v })} />
              <EditField label="Address" value={editForm.address} onChange={(v) => setEditForm({ ...editForm, address: v })} textarea />
              <div className="form-grid">
                <EditField label="Currency" value={editForm.currency} onChange={(v) => setEditForm({ ...editForm, currency: v })} mono />
                <EditField label="Timezone" value={editForm.timezone} onChange={(v) => setEditForm({ ...editForm, timezone: v })} mono />
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setShowEdit(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
