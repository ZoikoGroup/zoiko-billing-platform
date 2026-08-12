import React, { useEffect, useState, useCallback } from "react";
import { Plus, Trash2, Power, RefreshCw } from "lucide-react";

import { apiFetch } from "../api/client";
import ConfirmDialog from "../components/ConfirmDialog";

const EMPTY_ORG = {
  organization_name: "",
  industry: "",
  address: "",
  email: "",
  phone: "",
  tax_no: "",
  registration_number: "",
};

export default function OrganizationsPage() {
  const [orgs, setOrgs] = useState([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_ORG);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    apiFetch("/api/organizations", { params: { search, limit: 200 } })
      .then((data) => setOrgs(data.organizations))
      .catch((err) => setError(err.message));
  }, [search]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleStatus(org) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/api/organizations/${org.id}/status`, {
        method: "PATCH",
        params: { is_active: !org.is_active },
      });
      setNotice(`Organization "${org.organization_name}" ${org.is_active ? "suspended" : "activated"}.`);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/api/organizations/${deleting.id}`, { method: "DELETE" });
      setNotice(`Organization "${deleting.organization_name}" and all of its data deleted.`);
      setDeleting(null);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await apiFetch("/api/organizations", { method: "POST", body: form });
      setNotice(`Organization "${form.organization_name}" created.`);
      setCreating(false);
      setForm(EMPTY_ORG);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const INPUT =
    "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500";

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Organizations</h1>
        <div className="flex items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or code…"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
          <button
            onClick={load}
            className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            <RefreshCw size={15} />
            Refresh
          </button>
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-2 rounded-lg bg-orange-500 px-3 py-2 text-sm font-medium text-white hover:bg-orange-600"
          >
            <Plus size={16} />
            New Organization
          </button>
        </div>
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {notice && <p className="mb-3 text-sm text-green-600">{notice}</p>}

      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Code</th>
              <th className="px-4 py-3">Industry</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((org) => (
              <tr key={org.id} className="border-t border-slate-100">
                <td className="px-4 py-3 font-medium text-slate-800">{org.organization_name}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-500">{org.organization_code}</td>
                <td className="px-4 py-3 text-slate-500">{org.industry || "—"}</td>
                <td className="px-4 py-3 text-slate-600">{org.email || "—"}</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      org.is_active ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                    }`}
                  >
                    {org.is_active ? "Active" : "Suspended"}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-500">
                  {new Date(org.created_at).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <button
                      disabled={busy}
                      onClick={() => toggleStatus(org)}
                      className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${
                        org.is_active
                          ? "bg-red-50 text-red-600 hover:bg-red-100"
                          : "bg-green-50 text-green-700 hover:bg-green-100"
                      }`}
                    >
                      <Power size={12} />
                      {org.is_active ? "Suspend" : "Activate"}
                    </button>
                    <button
                      onClick={() => setDeleting(org)}
                      className="flex items-center gap-1 rounded-lg bg-red-50 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-100"
                    >
                      <Trash2 size={12} />
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {orgs.length === 0 && (
          <p className="px-4 py-6 text-sm text-slate-400">No organizations found.</p>
        )}
      </div>

      {creating && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h3 className="text-lg font-semibold text-slate-900 mb-4">New Organization</h3>
            <form onSubmit={handleCreate} className="grid grid-cols-2 gap-4">
              <label className="block col-span-2">
                <span className="text-xs font-medium text-slate-600">Name *</span>
                <input className={INPUT} required value={form.organization_name} onChange={set("organization_name")} />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Industry</span>
                <input className={INPUT} value={form.industry} onChange={set("industry")} />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Email</span>
                <input className={INPUT} type="email" value={form.email} onChange={set("email")} />
              </label>
              <label className="block col-span-2">
                <span className="text-xs font-medium text-slate-600">Address</span>
                <input className={INPUT} value={form.address} onChange={set("address")} />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Phone</span>
                <input className={INPUT} value={form.phone} onChange={set("phone")} />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Tax No</span>
                <input className={INPUT} value={form.tax_no} onChange={set("tax_no")} />
              </label>
              <label className="block col-span-2">
                <span className="text-xs font-medium text-slate-600">Registration Number</span>
                <input className={INPUT} value={form.registration_number} onChange={set("registration_number")} />
              </label>
              <div className="col-span-2 flex justify-end gap-3 mt-2">
                <button
                  type="button"
                  onClick={() => setCreating(false)}
                  disabled={busy}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 disabled:opacity-50"
                >
                  {busy ? "Creating…" : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete Organization"
          message={`Hard-delete "${deleting.organization_name}" (${deleting.organization_code}) and ALL of its data — users, customers, invoices, payments? This is permanent.`}
          busy={busy}
          onConfirm={handleDelete}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
