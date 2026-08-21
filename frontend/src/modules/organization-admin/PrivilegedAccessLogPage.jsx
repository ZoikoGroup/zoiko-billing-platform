import React, { useCallback, useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api } from "../../service/api";
import { PageHeader } from "../../components/billing-ui";
import { ErrorState, Spinner, StatusBadge, EmptyState } from "../../components/billing-shared";

/**
 * ZB-SA-CMD-003 §19/§20 — tenant-visible privileged support-access log
 * (ISS-021, closed this session). Answers "has Zoiko support ever accessed
 * our billing data, when, and why?" Read-only, no Super Admin operator
 * identity is shown (matches the spec's own tenant-context chrome example,
 * which shows reason/ticket/duration — not the individual operator).
 */

const STATUS_OPTIONS = [
  { value: "active", label: "Currently Active", color: "bg-red-100 text-red-700" },
  { value: "exited", label: "Ended (by operator)", color: "bg-slate-100 text-slate-600" },
  { value: "expired", label: "Ended (expired)", color: "bg-slate-100 text-slate-600" },
  { value: "denied", label: "Denied / abandoned", color: "bg-amber-100 text-amber-700" },
  { value: "pending_step_up", label: "Pending verification", color: "bg-amber-100 text-amber-700" },
];

function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function PrivilegedAccessLogPage() {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.get("/api/organizations/me/privileged-access-log")
      .then((res) => setEntries(res.entries || []))
      .catch((e) => setError(e?.message || "Failed to load the access log."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Privileged Access Log"
        description="A record of every time Zoiko support was granted time-boxed, read-only access to your billing data, and why. Access is off by default and requires a reason and ticket reference every time."
        icon={ShieldCheck}
      />
      <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        {loading ? (
          <Spinner />
        ) : error ? (
          <ErrorState message={error} onRetry={load} title="Unable to load the access log" />
        ) : entries.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="No support access on record" message="Zoiko support has never requested privileged access to your organization's billing data." />
        ) : (
          <div className="space-y-2">
            {entries.map((e) => (
              <div key={e.correlation_id} className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 py-3 text-sm last:border-0">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-800">{e.reason}</p>
                  <p className="text-xs text-slate-500">
                    Ticket {e.ticket_reference} · requested {formatDateTime(e.requested_at)}
                    {e.activated_at ? ` · active ${formatDateTime(e.activated_at)}–${formatDateTime(e.ended_at)}` : ""}
                  </p>
                </div>
                <StatusBadge status={e.status} options={STATUS_OPTIONS} fallbackColor="bg-slate-100 text-slate-600" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
