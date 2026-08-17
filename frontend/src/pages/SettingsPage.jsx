import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Save, Settings, ShieldAlert, KeyRound } from "lucide-react";

import { apiFetch } from "../api/client";
import { PageHeader, DataTable, Modal, Field, Button } from "../components/billing-ui";
import { PageSkeleton, ErrorState, EmptyState, SuccessMessage } from "../components/billing-shared";

const CATEGORY_LABELS = {
  general: "Platform Configuration",
  email: "Operational Configuration (Email)",
};

function categoryLabel(category) {
  return CATEGORY_LABELS[category] || `${category.charAt(0).toUpperCase()}${category.slice(1)} Configuration`;
}

function UpdateSensitiveValueModal({ open, settingKey, onClose, onSaved }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setValue("");
      setError(null);
    }
  }, [open]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/super-admin/settings/${settingKey}`, {
        method: "PUT",
        body: { value },
      });
      onSaved(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Update sensitive value" icon={KeyRound} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-slate-600">
          The current value of <span className="font-mono text-xs font-semibold text-slate-800">{settingKey}</span> is
          masked and cannot be read back. Enter a new value to replace it — this platform has no secret-reveal
          mechanism, so there is no way to recover the previous value once saved.
        </p>
        <Field label="New value" htmlFor="sensitive-value" required>
          <input
            id="sensitive-value"
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
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
          <Button type="submit" variant="primary" loading={busy} disabled={!value}>Save new value</Button>
        </div>
      </form>
    </Modal>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState([]);
  const [edits, setEdits] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyKey, setBusyKey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [updatingSensitiveKey, setUpdatingSensitiveKey] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    apiFetch("/api/super-admin/settings")
      .then((data) => {
        setSettings(data);
        setEdits(Object.fromEntries(data.filter((s) => !s.is_sensitive).map((s) => [s.key, s.value || ""])));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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

  const groups = useMemo(() => {
    const map = new Map();
    for (const s of settings) {
      const key = s.category || "general";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(s);
    }
    // "general" (platform configuration) leads; the rest follow alphabetically.
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === "general") return -1;
      if (b === "general") return 1;
      return a.localeCompare(b);
    });
  }, [settings]);

  const columnsFor = (categorySettings) => [
    { key: "key", label: "Key", render: (s) => <span className="font-mono text-xs text-slate-700">{s.key}</span> },
    { key: "description", label: "Description", render: (s) => <span className="text-slate-500">{s.description || "—"}</span> },
    {
      key: "value",
      label: "Value",
      render: (s) =>
        s.is_sensitive ? (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 font-mono text-xs text-slate-600">
              <ShieldAlert size={12} className="text-amber-500" />
              {s.value || "••••••••••"}
            </span>
          </div>
        ) : (
          <input
            value={edits[s.key] ?? ""}
            onChange={(e) => setEdits((d) => ({ ...d, [s.key]: e.target.value }))}
            className="w-64 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        ),
    },
    { key: "is_public", label: "Public", render: (s) => <span className="text-slate-500">{s.is_public ? "Yes" : "No"}</span> },
    {
      key: "actions",
      label: "",
      width: 140,
      render: (s) =>
        s.is_sensitive ? (
          <Button size="sm" variant="secondary" icon={KeyRound} onClick={() => setUpdatingSensitiveKey(s.key)}>
            Update
          </Button>
        ) : (
          <Button size="sm" variant="secondary" icon={Save} loading={busyKey === s.key} onClick={() => save(s.key)}>
            Save
          </Button>
        ),
    },
  ];

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Platform Settings"
        description="Platform-wide configuration — distinct from an organization's own billing settings."
        icon={Settings}
      />

      {notice && <div className="mt-4"><SuccessMessage message={notice} onDismiss={() => setNotice("")} /></div>}

      <div className="mt-6">
        {loading && settings.length === 0 ? (
          <PageSkeleton rows={4} />
        ) : error ? (
          <div className="rounded-2xl border border-slate-200 bg-white">
            <ErrorState message={error} onRetry={load} title="Unable to load platform settings" />
          </div>
        ) : settings.length === 0 ? (
          <EmptyState icon={Settings} title="No settings configured" message="Platform configuration keys will appear here once they are seeded." />
        ) : (
          <div className="space-y-8">
            {groups.map(([category, categorySettings]) => (
              <section key={category}>
                <h2 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-500">
                  {categorySettings.some((s) => s.is_sensitive) && <ShieldAlert size={13} className="text-amber-500" />}
                  {categoryLabel(category)}
                </h2>
                {categorySettings.some((s) => s.is_sensitive) && (
                  <p className="mb-3 text-xs text-slate-400">
                    Sensitive values in this section are masked and cannot be read back — this platform has no
                    secret-reveal mechanism. Use "Update" to set a new value.
                  </p>
                )}
                <DataTable
                  columns={columnsFor(categorySettings)}
                  data={categorySettings}
                  rowKey={(s) => s.key}
                  minWidth={780}
                />
              </section>
            ))}
          </div>
        )}
      </div>

      <UpdateSensitiveValueModal
        open={Boolean(updatingSensitiveKey)}
        settingKey={updatingSensitiveKey}
        onClose={() => setUpdatingSensitiveKey(null)}
        onSaved={(res) => {
          setSettings((list) => list.map((s) => (s.key === res.key ? res : s)));
          setNotice(`Setting "${res.key}" updated.`);
          setUpdatingSensitiveKey(null);
        }}
      />
    </div>
  );
}
