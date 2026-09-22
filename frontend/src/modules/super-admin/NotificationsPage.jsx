import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, AlertTriangle, ScrollText, HelpCircle } from "lucide-react";
import { getTriageSummary } from "../../service/commandCenterService";
import { PageHeader } from "../../components/billing-ui";
import { ErrorState, Spinner, StatusBadge } from "../../components/billing-shared";
import { formatDateTime } from "./constants";

const SEVERITY_BADGES = {
  p0: { label: "P0", color: "bg-red-100 text-red-700" },
  p1: { label: "P1", color: "bg-orange-100 text-orange-700" },
  p2: { label: "P2", color: "bg-amber-100 text-amber-700" },
  p3: { label: "P3", color: "bg-slate-100 text-slate-600" },
};

function SeverityBadge({ value }) {
  const option = SEVERITY_BADGES[value] || { label: (value || "").toUpperCase(), color: "bg-slate-100 text-slate-600" };
  return <StatusBadge status={value} options={[{ value, ...option }]} />;
}

// Real Command Center signals only — the same AttentionItem rows and
// PlatformAuditLog entries Triage & Attention / Audit & Evidence already
// show, composed as a feed. No separate notification store, no invented
// "unread" state (ORG-01) — this page is a read-only projection.
export default function NotificationsPage() {
  const navigate = useNavigate();
  const [openItems, setOpenItems] = useState([]);
  const [criticalEvents, setCriticalEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    getTriageSummary()
      .then((summary) => {
        setOpenItems(summary?.incidents?.top_items || []);
        setCriticalEvents(summary?.critical_events || []);
      })
      .catch((e) => {
        if (e?.status === 403 || /does not include/i.test(e?.message || "")) {
          setForbidden(true);
        } else {
          setError(e?.message || "Failed to load notifications.");
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const hasNotifications = openItems.length > 0 || criticalEvents.length > 0;

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Notifications"
        description="Open attention items and recent platform audit events — the same real signals Triage & Attention and Audit & Evidence surface, composed as one feed."
        icon={Bell}
      />

      <div className="mt-6">
        {loading ? (
          <Spinner />
        ) : forbidden ? (
          <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm">
            <HelpCircle size={18} className="mt-0.5 shrink-0 text-amber-500" />
            <p className="text-amber-800">
              Not available — your platform role does not include the triage.read capability. Ask a Platform
              Administrator for access.
            </p>
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-red-200 bg-white">
            <ErrorState message={error} onRetry={load} title="Unable to load notifications" />
          </div>
        ) : !hasNotifications ? (
          <div className="rounded-3xl border border-dashed border-slate-200 bg-white p-10 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-slate-50">
              <Bell className="h-8 w-8 text-slate-300" />
            </div>
            <h3 className="mb-2 text-lg font-bold text-slate-800">No Notifications</h3>
            <p className="mx-auto max-w-md text-[13px] text-slate-500">
              No open attention items and nothing new in the platform audit trail.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {openItems.map((item) => (
              <div
                key={`attn-${item.id}`}
                onClick={() => navigate("/super-admin/triage")}
                className="flex items-start gap-3 rounded-3xl border border-slate-200 bg-white p-4 transition-shadow hover:shadow-[0_4px_20px_rgba(0,0,0,0.03)] cursor-pointer"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600">
                  <AlertTriangle className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-[13px] font-semibold text-slate-800">
                    {item.title}
                    <SeverityBadge value={item.severity} />
                  </p>
                  <p className="mt-0.5 text-[12px] text-slate-500">
                    {item.description || "—"} · opened {formatDateTime(item.opened_at)}
                    {item.occurrence_count > 1 && ` · ${item.occurrence_count} occurrences`}
                  </p>
                </div>
              </div>
            ))}

            {criticalEvents.map((e) => (
              <div
                key={`evt-${e.id}`}
                onClick={() => navigate("/super-admin/audit-logs")}
                className="flex items-start gap-3 rounded-3xl border border-slate-200 bg-white p-4 transition-shadow hover:shadow-[0_4px_20px_rgba(0,0,0,0.03)] cursor-pointer"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-50 text-slate-600">
                  <ScrollText className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-slate-800">
                    {e.action} · {e.entity_type}{e.entity_id != null ? ` #${e.entity_id}` : ""}
                  </p>
                  <p className="mt-0.5 text-[12px] text-slate-500">
                    {e.actor_email || "System"} · {formatDateTime(e.created_at)}
                    {e.reason && ` · ${e.reason}`}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
