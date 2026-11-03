import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, HelpCircle, Mail, RefreshCw, Send, XCircle } from "lucide-react";
import {
  getEmailDeliveryOverview,
  listEmailDeliveryFailures,
  resendEmailDeliveryFailure,
  sendSmtpTestEmail,
} from "../../service/commandCenterService";
import { PageHeader, DataTable, Button, SectionCard, Modal, Field, FORM_CONTROL_CLASS } from "../../components/billing-ui";
import { ErrorState, EmptyState, StatusBadge, Pagination, SuccessMessage } from "../../components/billing-shared";
import { formatDateTime } from "./constants";

/**
 * B3 — real operational visibility into email/SMTP delivery health.
 *
 * Data source: CommunicationAuditLog (every send attempt is logged there —
 * see email_delivery_service.py). Known limitation, surfaced here rather
 * than hidden: the audit log does not store the full render context of a
 * send, so "resend" only works for template families this codebase already
 * has a proper business-record resend path for (invoice / credit note /
 * refund / write-off). Everything else shows as "not resendable from here".
 */

const PAGE_SIZE = 20;

const EMAIL_STATUS_OPTIONS = [
  { value: "FAILED", label: "Failed", color: "bg-red-100 text-red-700" },
  { value: "SUPPRESSED", label: "Suppressed", color: "bg-amber-100 text-amber-700" },
];

const HEALTH_META = {
  healthy: {
    label: "Healthy",
    icon: CheckCircle2,
    card: "border-emerald-200 bg-emerald-50/60",
    text: "text-emerald-700",
    detail: "Recent send attempts are mostly succeeding.",
  },
  degraded: {
    label: "Degraded",
    icon: XCircle,
    card: "border-red-200 bg-red-50/60",
    text: "text-red-700",
    detail: "More than half of the last 20 tracked attempts failed. This is also raised in the Attention Queue.",
  },
  unknown: {
    label: "Not enough data",
    icon: HelpCircle,
    card: "border-slate-200 bg-white",
    text: "text-slate-600",
    detail: "Too few recent send attempts to judge health either way. Send a test email to check SMTP now.",
  },
};

function fmtPct(value) {
  return value == null ? "—" : `${value}%`;
}

function Metric({ label, value, tone = "text-slate-900" }) {
  return (
    <div>
      <span className="block text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</span>
      <strong className={`text-lg ${tone}`}>{value}</strong>
    </div>
  );
}

function VolumeStatCard({ title, stats }) {
  const highFailure = stats?.failure_rate_pct != null && stats.failure_rate_pct > 10;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        {stats && (
          <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${highFailure ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600"}`}>
            {fmtPct(stats.failure_rate_pct)} failure
          </span>
        )}
      </div>
      {!stats ? (
        <p className="mt-3 text-sm text-slate-500">Unavailable</p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Attempts" value={stats.total_attempts} />
            <Metric label="Sent" value={stats.sent} tone="text-emerald-700" />
            <Metric label="Failed" value={stats.failed} tone={stats.failed > 0 ? "text-red-600" : "text-slate-900"} />
            <Metric label="Suppressed" value={stats.suppressed} tone={stats.suppressed > 0 ? "text-amber-700" : "text-slate-900"} />
          </div>
          {(stats.queued > 0 || stats.duplicate > 0 || stats.superseded > 0) && (
            <p className="mt-3 text-xs text-slate-500">
              Also {stats.queued} queued · {stats.duplicate} duplicate · {stats.superseded} superseded
            </p>
          )}
        </>
      )}
    </div>
  );
}

function TestEmailModal({ open, onClose }) {
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (open) setResult(null);
  }, [open]);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const res = await sendSmtpTestEmail(recipient.trim());
      setResult({ ok: Boolean(res?.success), message: res?.message || (res?.success ? "Test email sent." : "Test email failed.") });
    } catch (err) {
      setResult({ ok: false, message: err?.message || "Test email failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Send a test email"
      description="Sends one message right now using the platform's current SMTP settings."
      icon={Send}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Close</Button>
          <Button type="submit" form="smtp-test-form" variant="primary" icon={Send} loading={busy} disabled={!recipient.trim()}>
            Send test
          </Button>
        </>
      }
    >
      <form id="smtp-test-form" onSubmit={handleSubmit} className="space-y-4">
        <Field label="Recipient email" htmlFor="smtp-test-recipient" required>
          <input
            id="smtp-test-recipient"
            type="email"
            required
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="you@example.com"
            className={FORM_CONTROL_CLASS}
          />
        </Field>
        {result && (
          <div
            role={result.ok ? "status" : "alert"}
            className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
              result.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-700"
            }`}
          >
            {result.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
            <span className="break-words">{result.message}</span>
          </div>
        )}
      </form>
    </Modal>
  );
}

function FailureDetailModal({ row, onClose, onResend, resending }) {
  if (!row) return null;
  const reason = row.error_message || row.suppression_reason;
  return (
    <Modal
      open
      onClose={onClose}
      title="Failed send"
      description={row.recipient}
      icon={Mail}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          {row.resendable && (
            <Button variant="primary" icon={Send} loading={resending} onClick={() => onResend(row)}>
              Resend
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 rounded-2xl border border-slate-100 bg-slate-50 p-4 text-xs sm:grid-cols-2">
          <div>
            <dt className="font-semibold text-slate-500">Status</dt>
            <dd className="mt-1"><StatusBadge status={row.status} options={EMAIL_STATUS_OPTIONS} /></dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-500">When</dt>
            <dd className="mt-1 text-slate-800">{formatDateTime(row.sent_at)}</dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-500">Organization</dt>
            <dd className="mt-1 text-slate-800">{row.organization_name || (row.organization_id ? `Org #${row.organization_id}` : "Platform (no org)")}</dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-500">Event</dt>
            <dd className="mt-1 text-slate-800">{row.event_name}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="font-semibold text-slate-500">Template</dt>
            <dd className="mt-1 break-all font-mono text-slate-800">{row.template_id}</dd>
          </div>
        </dl>
        <div>
          <p className="text-xs font-semibold text-slate-500">{row.error_message ? "Error" : "Suppression reason"}</p>
          <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-700">
            {reason || "No reason recorded."}
          </pre>
        </div>
        {!row.resendable && (
          <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {row.resend_note || "This email can't be resent from here — there is no resend path for its record type."}
          </p>
        )}
      </div>
    </Modal>
  );
}

export default function EmailDeliveryPage() {
  const [overview, setOverview] = useState(null);
  const [overviewError, setOverviewError] = useState(null);
  const [failures, setFailures] = useState(null);
  const [failuresError, setFailuresError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [resendingId, setResendingId] = useState(null);
  const [notice, setNotice] = useState("");
  const [resendError, setResendError] = useState("");
  const [selected, setSelected] = useState(null);
  const [testOpen, setTestOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.allSettled([
      getEmailDeliveryOverview(),
      listEmailDeliveryFailures((page - 1) * PAGE_SIZE, PAGE_SIZE),
    ]).then(([overviewRes, failuresRes]) => {
      if (overviewRes.status === "fulfilled") {
        setOverview(overviewRes.value);
        setOverviewError(null);
      } else {
        setOverviewError(overviewRes.reason?.message || "Failed to load email delivery overview.");
      }
      if (failuresRes.status === "fulfilled") {
        setFailures(failuresRes.value);
        setFailuresError(null);
      } else {
        setFailuresError(failuresRes.reason?.message || "Failed to load recent failures.");
      }
      setLoading(false);
    });
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleResend(row) {
    setResendingId(row.id);
    setResendError("");
    setNotice("");
    try {
      const res = await resendEmailDeliveryFailure(row.id);
      // A 200 with success:false is still a failed resend — never paint it green.
      if (res && res.success === false) {
        setResendError(res.message || `Resend to ${row.recipient} failed.`);
      } else {
        setNotice(res?.message || `Resend triggered for ${row.recipient}.`);
        setSelected(null);
        load();
      }
    } catch (err) {
      setResendError(err?.message || "Resend failed.");
    } finally {
      setResendingId(null);
    }
  }

  const totalPages = failures ? Math.max(1, Math.ceil(failures.total / PAGE_SIZE)) : 1;

  const columns = [
    {
      key: "recipient",
      label: "Recipient",
      render: (r) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium text-slate-800">{r.recipient}</span>
          <span className="block truncate text-[11px] text-slate-500">
            {r.organization_name || (r.organization_id ? `Org #${r.organization_id}` : "Platform (no org)")}
          </span>
        </span>
      ),
    },
    {
      key: "event_name",
      label: "Email",
      hideBelow: "lg",
      render: (r) => (
        <span className="block">
          <span className="block text-xs text-slate-700">{r.event_name}</span>
          <span className="block font-mono text-[11px] text-slate-500">{r.template_id}</span>
        </span>
      ),
    },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} options={EMAIL_STATUS_OPTIONS} /> },
    {
      key: "reason",
      label: "Reason",
      hideBelow: "md",
      render: (r) => (
        <span className="line-clamp-2 text-xs text-slate-600" title={r.error_message || r.suppression_reason || ""}>
          {r.error_message || r.suppression_reason || "—"}
        </span>
      ),
    },
    { key: "sent_at", label: "When", render: (r) => <span className="whitespace-nowrap text-xs text-slate-500">{formatDateTime(r.sent_at)}</span> },
    {
      key: "actions",
      label: "",
      width: 130,
      render: (r) =>
        r.resendable ? (
          <Button
            size="sm"
            variant="secondary"
            icon={Send}
            loading={resendingId === r.id}
            disabled={resendingId !== null}
            onClick={(e) => {
              e.stopPropagation();
              handleResend(r);
            }}
          >
            Resend
          </Button>
        ) : (
          <span className="text-[11px] text-slate-500" title={r.resend_note || "Not resendable from here."}>
            Not resendable
          </span>
        ),
    },
  ];

  const health = overview?.smtp_health || "unknown";
  const healthMeta = HEALTH_META[health] || HEALTH_META.unknown;
  const HealthIcon = healthMeta.icon;

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Email Delivery"
        description="Every email the platform tries to send — volume, failure rate, and the sends that didn't go out. Resend is available where the underlying record supports it."
        icon={Mail}
        accent="brand"
        meta={overview?.generated_at ? `Updated ${formatDateTime(overview.generated_at)}` : null}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={Send} onClick={() => setTestOpen(true)}>
              Send test email
            </Button>
            <Button variant="secondary" icon={RefreshCw} onClick={load} loading={loading}>
              Refresh
            </Button>
          </div>
        }
      />

      {notice && <div className="mt-4"><SuccessMessage message={notice} onDismiss={() => setNotice("")} /></div>}
      {resendError && (
        <div role="alert" className="mt-4 flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span className="flex items-start gap-2"><AlertTriangle size={16} className="mt-0.5 shrink-0" /> {resendError}</span>
          <button type="button" onClick={() => setResendError("")} className="shrink-0 text-xs font-semibold hover:text-red-900">
            Dismiss
          </button>
        </div>
      )}

      <div className="mt-6 space-y-6">
        {overviewError ? (
          <SectionCard variant="standard">
            <ErrorState title="Unable to load email delivery overview" message={overviewError} onRetry={load} />
          </SectionCard>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className={`rounded-2xl border p-5 ${healthMeta.card}`}>
              <h3 className="text-sm font-semibold text-slate-800">SMTP health</h3>
              {loading && !overview ? (
                <div className="mt-3 h-8 w-32 animate-pulse rounded-lg bg-slate-200/70" aria-hidden="true" />
              ) : (
                <p className={`mt-3 flex items-center gap-2 text-xl font-extrabold ${healthMeta.text}`}>
                  <HealthIcon size={22} /> {healthMeta.label}
                </p>
              )}
              <p className="mt-2 text-xs text-slate-600">{healthMeta.detail}</p>
            </div>
            <VolumeStatCard title="Last 24 hours" stats={overview?.last_24h} />
            <VolumeStatCard title="Last 7 days" stats={overview?.last_7d} />
          </div>
        )}

        <SectionCard
          variant="standard"
          accent="brand"
          icon={Mail}
          title="Failed and suppressed sends"
          description="Newest first. Select a row for the full error. Resend is offered only for invoices, credit notes, refunds and write-offs."
          actions={
            failures?.total > 0 ? (
              <span className="rounded-full bg-red-100 px-2.5 py-1 text-xs font-bold text-red-700">{failures.total} total</span>
            ) : null
          }
        >
          {failuresError ? (
            <ErrorState title="Unable to load recent failures" message={failuresError} onRetry={load} />
          ) : !loading && (failures?.items || []).length === 0 ? (
            <EmptyState icon={CheckCircle2} title="No failed sends" message="Every tracked email send attempt has succeeded." />
          ) : (
            <>
              <DataTable
                columns={columns}
                data={failures?.items || []}
                loading={loading}
                rowKey={(r) => r.id}
                onRowClick={(row) => setSelected(row)}
                minWidth={760}
              />
              {failures && failures.total > PAGE_SIZE && (
                <div className="mt-4">
                  <Pagination page={page} totalPages={totalPages} onPageChange={setPage}>
                    {failures.total} failure(s)
                  </Pagination>
                </div>
              )}
            </>
          )}
        </SectionCard>
      </div>

      <FailureDetailModal
        row={selected}
        onClose={() => setSelected(null)}
        onResend={handleResend}
        resending={selected ? resendingId === selected.id : false}
      />
      <TestEmailModal open={testOpen} onClose={() => setTestOpen(false)} />
    </div>
  );
}
