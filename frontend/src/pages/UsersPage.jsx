import React, { useEffect, useState, useCallback } from "react";
import { Search, KeyRound, RefreshCw } from "lucide-react";

import { apiFetch } from "../api/client";

const ROLES = ["org_admin", "billing_admin"];

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [me, setMe] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(() => {
    apiFetch("/api/super-admin/users", {
      params: { search, role, limit: 200 },
    })
      .then((data) => {
        setUsers(data.users);
        setTotal(data.total);
      })
      .catch((err) => setError(err.message));
  }, [search, role]);

  useEffect(() => {
    load();
  }, [load]);

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

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 mb-6">Platform Users</h1>

      <div className="flex flex-wrap gap-3 mb-4">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search email or name…"
            className="pl-9 pr-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
        >
          <option value="">All roles</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button
          onClick={load}
          className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
        >
          <RefreshCw size={15} />
          Refresh
        </button>
        <span className="text-sm text-slate-500 self-center">{total} user(s)</span>
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {notice && <p className="mb-3 text-sm text-green-600">{notice}</p>}

      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Organization</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-slate-100">
                <td className="px-4 py-3 font-medium text-slate-800">
                  {u.first_name} {u.last_name}
                </td>
                <td className="px-4 py-3 text-slate-600">{u.email}</td>
                <td className="px-4 py-3">
                  <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                    {u.role}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-500">{u.organization_name || "—"}</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      u.is_active ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                    }`}
                  >
                    {u.is_active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-500">
                  {new Date(u.created_at).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <button
                      disabled={busyId === u.id || (me && me.id === u.id)}
                      onClick={() => toggleStatus(u)}
                      className={`rounded-lg px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${
                        u.is_active
                          ? "bg-red-50 text-red-600 hover:bg-red-100"
                          : "bg-green-50 text-green-700 hover:bg-green-100"
                      }`}
                    >
                      {u.is_active ? "Deactivate" : "Activate"}
                    </button>
                    <button
                      disabled={busyId === u.id}
                      onClick={() => resetPassword(u)}
                      className="flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200 disabled:opacity-40"
                    >
                      <KeyRound size={12} />
                      Reset PW
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && (
          <p className="px-4 py-6 text-sm text-slate-400">No users found.</p>
        )}
      </div>
    </div>
  );
}
