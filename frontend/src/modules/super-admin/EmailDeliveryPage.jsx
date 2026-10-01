import React, { useCallback, useEffect, useState } from "react";
import { Mail, RefreshCw, Send, AlertTriangle } from "lucide-react";
import {
  getEmailDeliveryOverview,
  listEmailDeliveryFailures,
  resendEmailDeliveryFailure,
} from "../../service/commandCenterService";
import { PageHeader, DataTable, Button, SectionCard } from "../../components/billing-ui";
import { ErrorState, Spinner, EmptyState, StatusBadge, Pagination, SuccessMessage } from "../../components/billing-shared";

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
  healthy: { label: "Healthy", color: "bg-emerald-100 text-emerald-700" },
  degraded: { label: "Degraded", color: "bg-red-100 text-red-700" },
  unknown: { label: "Unknown", color: "bg-slate-100 text-slate-600" },
};

function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtPct(value) {
  return value == null ? "—" : `${value}%`;
}

function VolumeStatCard({ title, stats }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">{title}</h3>
      {!stats ? (
        <p className="mt-3 text-sm text-slate-400">Unavailable</p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>
            <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-400">Attempts</span>
            <strong className="text-lg text-slate-900">{stats.total_attempts}</strong>
          </div>
          <div>
            <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-400">Sent</span>
            <strong className="text-lg text-emerald-700">{stats.sent}</strong>
          </div>
          <div>
            <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-400">Failed</span>
            <strong className="text-lg text-red-600">{stats.failed}</strong>
          </div>
          <div>
            <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-400">Suppressed</span>
            <strong className="text-lg text-amber-700">{stats.suppressed}</strong>
          </div>
          <div>
            <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-400">Failure rate</span>
            <strong className={`text-lg ${stats.failure_rate_pct != null && stats.failure_rate_pct > 10 ? "text-red-600" : "text-slate-900"}`}>
              {fmtPct(stats.failure_rate_pct)}
            </strong>
          </div>
        </div>
      )}
    </div>
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
      setNotice(res?.message || `Resend triggered for ${row.recipient}.`);
      load();
    } catch (err) {
      setResendError(err.message || "Resend failed.");
    } finally {
      setResendingId(null);
    }
  }

  const totalPages = failures ? Math.max(1, Math.ceil(failures.total / PAGE_SIZE)) : 1;

  const columns = [
    { key: "recipient", label: "Recipient", render: (r) => <span className="font-medium text-slate-800">{r.recipient}</span> },
    {
      key: "organization",
      label: "Organization",
      render: (r) => <span className="text-slate-600">{r.organization_name || (r.organization_id ? `Org #${r.organization_id}` : "Platform (no org)")}</span>,
    },
    { key: "template_id", label: "Template", render: (r) => <span className="font-mono text-xs text-slate-600">{r.template_id}</span> },
    { key: "event_name", label: "Event", render: (r) => <span className="text-xs text-slate-500">{r.event_name}</span> },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} options={EMAIL_STATUS_OPTIONS} /> },
    {
      key: "reason",
      label: "Error / Reason",
      render: (r) => (
        <span className="text-xs text-slate-600" title={r.error_message || r.suppression_reason || ""}>
          {(r.error_message || r.suppression_reason || "—").slice(0, 140)}
        </span>
      ),
    },
    { key: "sent_at", label: "When", render: (r) => <span className="text-xs text-slate-500">{formatDateTime(r.sent_at)}</span> },
    {
      key: "actions",
      label: "",
      width: 160,
      render: (r) =>
        r.resendable ? (
          <Button
            size="sm"
            variant="secondary"
            icon={Send}
            loading={resendingId === r.id}
            onClick={() => handleResend(r)}
          >
            Resend
          </Button>
        ) : (
          <span className="text-[11px] text-slate-400" title={r.resend_note || "Not resendable from here."}>
            Not resendable
          </span>
        ),
    },
  ];

  const health = overview?.smtp_health || "unknown";
  const healthMeta = HEALTH_META[health] || HEALTH_META.unknown;

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Email Delivery"
        description="Real operational visibility over every email send attempt (CommunicationAuditLog) — volume, failure rate, and a manual resend action where a proper business-record resend path exists."
        icon={Mail}
        accent="brand"
        meta={overview?.generated_at ? `Generated ${new Date(overview.generated_at).toLocaleString()}` : null}
        actions={
          <Button variant="secondary" icon={RefreshCw} onClick={load} loading={loading}>
            Refresh
          </Button>
        }
      />

      {notice && <div className="mt-4"><SuccessMessage message={notice} onDismiss={() => setNotice("")} /></div>}
      {resendError && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {resendError}
        </div>
      )}

      <div className="mt-6 space-y-6">
        {overviewError ? (
          <ErrorState title="Unable to load email delivery overview" message={overviewError} onRetry={load} />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <VolumeStatCard title="Last 24 hours" stats={overview?.last_24h} />
            <VolumeStatCard title="Last 7 days" stats={overview?.last_7d} />
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">SMTP health</h3>
              <div className="mt-3">
                <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-bold ${healthMeta.color}`}>
                  {healthMeta.label}
                </span>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                {health === "unknown"
                  ? "Not enough recent send attempts to judge health either way."
                  : health === "degraded"
                  ? "More than half of the last 20 tracked attempts failed — this is also reported to the Attention Queue (source: email_delivery)."
                  : "Recent send attempts are mostly succeeding."}
              </p>
            </div>
          </div>
        )}

        <SectionCard
          variant="standard"
          accent="brand"
          icon={Mail}
          title="Recent failed / suppressed sends"
          description="Most recent first. A row is resendable only when this codebase already has a proper resend code path for its record type (invoice, credit note, refund, write-off)."
        >
          {loading && !failures ? (
            <Spinner />
          ) : failuresError ? (
            <ErrorState title="Unable to load recent failures" message={failuresError} onRetry={load} />
          ) : (failures?.items || []).length === 0 ? (
            <EmptyState icon={Mail} title="No recent failures" message="Every tracked email send attempt has succeeded." />
          ) : (
            <>
              <DataTable columns={columns} data={failures.items} rowKey={(r) => r.id} minWidth={1000} />
              <div className="mt-4">
                <Pagination page={page} totalPages={totalPages} onPageChange={setPage}>
                  {failures.total} failure(s)
                </Pagination>
              </div>
            </>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
