import React, { useEffect, useState } from "react";
import { Save, RefreshCw } from "lucide-react";

import { apiFetch } from "../api/client";

export default function SettingsPage() {
  const [settings, setSettings] = useState([]);
  const [edits, setEdits] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyKey, setBusyKey] = useState(null);

  function load() {
    apiFetch("/api/super-admin/settings")
      .then((data) => {
        setSettings(data);
        setEdits(Object.fromEntries(data.map((s) => [s.key, s.value || ""])));
      })
      .catch((err) => setError(err.message));
  }

  useEffect(load, []);

  async function save(key) {
    setBusyKey(key);
    setError("");
    setNotice("");
    try {
      const res = await apiFetch(`/api/super-admin/settings/${key}`, {
        method: "PUT",
        body: { value: edits[key] },
      });
      setSettings((list) => list.map((s) => (s.key === key ? res : s)));
      setNotice(`Setting "${key}" saved.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 mb-6">Platform Settings</h1>

      <div className="mb-4 flex items-center gap-2">
        <button
          onClick={load}
          className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
        >
          <RefreshCw size={15} />
          Refresh
        </button>
        {notice && <span className="text-sm text-green-600">{notice}</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-4 py-3">Key</th>
              <th className="px-4 py-3">Description</th>
              <th className="px-4 py-3">Value</th>
              <th className="px-4 py-3">Public</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {settings.map((s) => (
              <tr key={s.key} className="border-t border-slate-100">
                <td className="px-4 py-3 font-mono text-xs text-slate-700">{s.key}</td>
                <td className="px-4 py-3 text-slate-500">{s.description || "—"}</td>
                <td className="px-4 py-3">
                  <input
                    value={edits[s.key] ?? ""}
                    onChange={(e) => setEdits((d) => ({ ...d, [s.key]: e.target.value }))}
                    className="w-64 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </td>
                <td className="px-4 py-3 text-slate-500">{s.is_public ? "Yes" : "No"}</td>
                <td className="px-4 py-3">
                  <button
                    disabled={busyKey === s.key}
                    onClick={() => save(s.key)}
                    className="flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200 disabled:opacity-40"
                  >
                    <Save size={12} />
                    Save
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {settings.length === 0 && (
          <p className="px-4 py-6 text-sm text-slate-400">No settings configured.</p>
        )}
      </div>
    </div>
  );
}
