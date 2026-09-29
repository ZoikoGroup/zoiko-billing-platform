import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Save, Settings, ShieldAlert, KeyRound, ShieldCheck, Mail, AlertTriangle } from "lucide-react";

import { apiFetch } from "../api/client";
import { PageHeader, DataTable, Modal, Field, Button } from "../components/billing-ui";
import { PageSkeleton, ErrorState, EmptyState, SuccessMessage } from "../components/billing-shared";

const CATEGORY_LABELS = {
  general: "Platform Configuration",
  email: "Operational Configuration (Email)",
};

// B6 — changing either of these without also updating SMTP_PASSWORD in the
// environment (which is NEVER read from the DB, by design — see
// email_service.py's header comment) silently breaks outbound mail until
// someone notices a failure. Warn once, at the moment of save, rather than
// only after the fact via the Email Delivery page.
const SMTP_WARNING_KEYS = new Set(["smtp_host", "smtp_username"]);

function ConfirmSmtpChangeModal({ open, settingKey, onCancel, onConfirm, busy }) {
  return (
    <Modal open={open} onClose={onCancel} title="Confirm SMTP configuration change" icon={AlertTriangle} size="sm">
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          You are changing <span className="font-mono text-xs font-semibold text-slate-800">{settingKey}</span>.
          The SMTP password (<span className="font-mono text-xs">SMTP_PASSWORD</span>) is always read from the
          environment only, never from this settings table — so it will <strong>not</strong> update automatically.
        </p>
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          If this host/username belongs to a different mail provider or account, update{" "}
          <span className="font-mono">SMTP_PASSWORD</span> in the environment to match — otherwise outbound email
          will start failing authentication immediately. Recent failures (including this one, if it happens) are
          visible on the Email Delivery page.
        </p>
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={onConfirm}>Save anyway</Button>
        </div>
      </div>
    </Modal>
  );
}

function SendTestEmailModal({ open, onClose }) {
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setRecipient("");
      setResult(null);
      setError("");
    }
  }, [open]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!recipient) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await apiFetch("/api/super-admin/settings/email/test", {
        method: "POST",
        body: { recipient_email: recipient },
      });
      setResult(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Send test email" icon={Mail} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-slate-600">
          Sends a real email synchronously, right now, using the current effective SMTP settings (environment
          defaults plus any overrides saved below) — this is the fastest way to confirm host/username/password
          still work together after a change.
        </p>
        <Field label="Recipient email" htmlFor="smtp-test-recipient" required>
          <input
            id="smtp-test-recipient"
            type="email"
            required
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
        )}
        {result && (
          <p
            role="status"
            className={`rounded-lg border px-3 py-2 text-xs ${
              result.success ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"
            }`}
          >
            {result.message}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Close</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!recipient}>Send test email</Button>
        </div>
      </form>
    </Modal>
  );
}

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

// ── Super Admin MFA (step-up factor) ────────────────────────────────────────
// ZB-SA-CMD-003 v3.0: login never asks for MFA. This card manages the TOTP
// factor that the platform enforces as a step-up at the moment of
// privileged actions (tenant-access activation, circuit-breaker changes,
// approval decisions). Enrollment happens here, from an authenticated
// session — not at login.

function MfaSetupModal({ open, onClose, onEnabled }) {
  const [stage, setStage] = useState("start"); // start | confirm | codes
  const [secret, setSecret] = useState("");
  const [otpauthUrl, setOtpauthUrl] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [reusedPending, setReusedPending] = useState(false);

  // Opening the setup screen must never invalidate a key the operator has
  // already entered. /start is idempotent server-side (it replays an
  // unconfirmed enrollment), so this is safe to run on every open; a new key
  // is only minted by the explicit "get a new key" action.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setStage("start");
    setCode("");
    setRecoveryCodes([]);
    setError("");
    setLoadError("");
    setReusedPending(false);
    apiFetch("/api/auth/mfa/setup/start", { method: "POST" })
      .then((data) => {
        if (cancelled) return;
        setSecret(data.secret || "");
        setOtpauthUrl(data.otpauth_url || "");
        setReusedPending(Boolean(data.reused_pending));
      })
      .catch((err) => { if (!cancelled) setLoadError(err.message); });
    return () => { cancelled = true; };
  }, [open]);

  // Explicitly discard a key and issue another, for when the one in the app is
  // genuinely wrong (mistyped, wrong device, phone reset).
  async function regenerate() {
    setBusy(true);
    setError("");
    setLoadError("");
    try {
      const data = await apiFetch("/api/auth/mfa/setup/start?regenerate=true", { method: "POST" });
      setSecret(data.secret || "");
      setOtpauthUrl(data.otpauth_url || "");
      setReusedPending(false);
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await apiFetch("/api/auth/mfa/setup/verify", {
        method: "POST",
        body: { code: code.replace(/\s/g, "") },
      });
      setRecoveryCodes(data.recovery_codes || []);
      setStage("codes");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    onEnabled();
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Enable MFA step-up" icon={ShieldCheck} size="sm">
      {loadError && (
        <div className="mb-4">
          <ErrorState message={loadError} onRetry={regenerate} title="Unable to start MFA enrollment" />
        </div>
      )}

      {stage === "start" && !loadError && (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Add the account to your authenticator app using the key below (choose &ldquo;Enter a setup key&rdquo;),
            then confirm with a 6-digit code.
          </p>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-600">Secret key</p>
            <p className="break-all rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-800">
              {secret || "…"}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Transcribe carefully — a single wrong character produces a code the server will never accept.
            </p>
            {reusedPending && (
              <p className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                This is the same key from your last attempt. If you already added it to your authenticator app,
                it is still valid — just enter a fresh code.
              </p>
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!secret} onClick={() => setStage("confirm")}>
              I&apos;ve added it — continue
            </Button>
          </div>
        </div>
      )}

      {stage === "confirm" && (
        <form onSubmit={handleVerify} className="space-y-4">
          <Field label="6-digit authenticator code" htmlFor="mfa-code" required>
            <input
              id="mfa-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              value={code}
              // A TOTP code is exactly 6 digits. maxLength alone does not clamp
              // pasted or autofilled values (one-time-code autofill is a real
              // path here), so bound the state itself.
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-center font-mono text-lg tracking-widest focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
            />
          </Field>
          {error && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <p>{error}</p>
              <p className="mt-1.5">
                Codes change every 30s, so wait for the next one. If it keeps failing, the key in your app
                does not match the one above.
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-2"
                loading={busy}
                onClick={regenerate}
              >
                Get a new key
              </Button>
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setStage("start")}>Back</Button>
            <Button type="submit" variant="primary" loading={busy} disabled={code.length < 6}>Confirm &amp; enable</Button>
          </div>
        </form>
      )}

      {stage === "codes" && (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            MFA is enabled. Store these one-time recovery codes somewhere safe — each can be used once for
            step-up verification if you lose your device. They are shown <strong>only this once</strong>.
          </p>
          <ul className="grid grid-cols-2 gap-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-800">
            {recoveryCodes.map((c) => <li key={c}>{c}</li>)}
          </ul>
          <div className="flex items-center justify-end">
            <Button variant="primary" onClick={finish}>Done</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function MfaDisableModal({ open, onClose, onDisabled }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setPassword("");
      setError("");
    }
  }, [open]);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await apiFetch("/api/auth/mfa/disable", {
        method: "POST",
        body: { current_password: password },
      });
      onDisabled();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Disable MFA step-up" icon={ShieldAlert} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-slate-600">
          Disabling MFA means privileged actions will refuse step-up verification until you enroll again.
          Confirm with your current password.
        </p>
        <Field label="Current password" htmlFor="mfa-disable-password" required>
          <input
            id="mfa-disable-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!password}>Disable MFA</Button>
        </div>
      </form>
    </Modal>
  );
}

function SuperAdminMfaCard() {
  const [enabled, setEnabled] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [setupOpen, setSetupOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);

  const load = useCallback(() => {
    setLoadError("");
    apiFetch("/api/auth/mfa/status")
      .then((data) => setEnabled(Boolean(data.enabled)))
      .catch((err) => setLoadError(err.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section aria-labelledby="mfa-stepup-heading" className="rounded-2xl border border-slate-200 bg-white p-5">
      <h2 id="mfa-stepup-heading" className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-600">
        <ShieldCheck size={13} className="text-brand-500" />
        Security — MFA step-up
      </h2>
      <p className="mt-2 text-sm text-slate-500">
        Signing in never requires MFA. Instead, the platform asks for a fresh one-time code when you perform a
        privileged action (tenant access activation, circuit-breaker changes, approval decisions).
      </p>
      {loadError ? (
        <div className="mt-4"><ErrorState message={loadError} onRetry={load} title="Unable to load MFA status" /></div>
      ) : enabled === null ? (
        <p className="mt-4 text-sm text-slate-500">Checking status…</p>
      ) : (
        <>
          {notice && <div className="mt-4"><SuccessMessage message={notice} onDismiss={() => setNotice("")} /></div>}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${enabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
              {enabled ? "Enabled — step-up enforced" : "Not enrolled"}
            </span>
            {enabled ? (
              <Button size="sm" variant="secondary" icon={ShieldAlert} onClick={() => setDisableOpen(true)}>Disable</Button>
            ) : (
              <Button size="sm" variant="primary" icon={ShieldCheck} onClick={() => setSetupOpen(true)}>Enable MFA</Button>
            )}
          </div>
        </>
      )}
      <MfaSetupModal
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        onEnabled={() => { setEnabled(true); setNotice("MFA step-up is now enforced on your account."); }}
      />
      <MfaDisableModal
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        onDisabled={() => { setEnabled(false); setNotice("MFA has been disabled on your account."); }}
      />
    </section>
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
  // B6 — one-time confirmation before saving a changed smtp_host/smtp_username
  // (see SMTP_WARNING_KEYS above), plus the "Send test email" action.
  const [pendingSmtpKey, setPendingSmtpKey] = useState(null);
  const [smtpConfirmBusy, setSmtpConfirmBusy] = useState(false);
  const [testEmailOpen, setTestEmailOpen] = useState(false);

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

  async function performSave(key) {
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

  // B6 — smtp_host/smtp_username changing value gets a one-time warning
  // (SMTP_PASSWORD is env-only and will NOT follow along) before the PUT
  // actually fires; every other setting saves immediately, unchanged.
  function save(key) {
    const current = settings.find((s) => s.key === key);
    const changed = (current?.value || "") !== (edits[key] ?? "");
    if (changed && current?.category === "email" && SMTP_WARNING_KEYS.has(key)) {
      setPendingSmtpKey(key);
      return;
    }
    performSave(key);
  }

  async function confirmSmtpChange() {
    setSmtpConfirmBusy(true);
    await performSave(pendingSmtpKey);
    setSmtpConfirmBusy(false);
    setPendingSmtpKey(null);
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
    {
      // Phase 4 (G-02) — evidence of who last changed each setting. Rows that
      // predate audit coverage show UNKNOWN rather than a fabricated name.
      key: "updated_by",
      label: "Last Changed By",
      render: (s) =>
        s.updated_by_email ? (
          <span className="text-xs font-medium text-slate-700">{s.updated_by_email}</span>
        ) : (
          <span
            className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500"
            title="No recorded actor exists — this row's last change predates settings audit coverage."
          >
            UNKNOWN
          </span>
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
        <SuperAdminMfaCard />
      </div>

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
                <h2 className="mb-3 flex flex-wrap items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-600">
                  {categorySettings.some((s) => s.is_sensitive) && <ShieldAlert size={13} className="text-amber-500" />}
                  {categoryLabel(category)}
                  {category === "email" && (
                    <Button size="sm" variant="secondary" icon={Mail} className="ml-auto normal-case" onClick={() => setTestEmailOpen(true)}>
                      Send test email
                    </Button>
                  )}
                </h2>
                {category === "email" && (
                  <p className="mb-3 text-xs text-slate-500">
                    Changing <span className="font-mono">smtp_host</span> or <span className="font-mono">smtp_username</span> will
                    ask you to confirm — <span className="font-mono">SMTP_PASSWORD</span> is environment-only and never follows a
                    settings change automatically.
                  </p>
                )}
                {categorySettings.some((s) => s.is_sensitive) && (
                  <p className="mb-3 text-xs text-slate-500">
                    Sensitive values in this section are masked and cannot be read back — this platform has no
                    secret-reveal mechanism. Use "Update" to set a new value.
                  </p>
                )}
                <DataTable
                  columns={columnsFor(categorySettings)}
                  data={categorySettings}
                  rowKey={(s) => s.key}
                  minWidth={900}
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
      <ConfirmSmtpChangeModal
        open={Boolean(pendingSmtpKey)}
        settingKey={pendingSmtpKey}
        busy={smtpConfirmBusy}
        onCancel={() => setPendingSmtpKey(null)}
        onConfirm={confirmSmtpChange}
      />
      <SendTestEmailModal open={testEmailOpen} onClose={() => setTestEmailOpen(false)} />
    </div>
  );
}
