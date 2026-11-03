import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, AlertTriangle, ScrollText, HelpCircle, RefreshCw, ArrowRight } from "lucide-react";
import { getTriageSummary } from "../../service/commandCenterService";
import { PageHeader, Button } from "../../components/billing-ui";
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

// The API serializes naive UTC datetimes (no "Z"); read them as UTC so the
// times shown here aren't shifted by the viewer's UTC offset.
function parseServerDate(value) {
  if (!value) return null;
  const text = String(value);
  return new Date(/([zZ]|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`);
}

// "set_default" -> "Set default"
function humanize(value) {
  const text = String(value || "").replace(/_/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "—";
}

const ROW_CLASS =
  "flex w-full items-start gap-3 rounded-3xl border border-slate-200 bg-white p-4 text-left transition-shadow hover:shadow-[0_4px_20px_rgba(0,0,0,0.03)] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40";

function FeedHeading({ title, children }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 px-1">
      <h2 className="text-sm font-bold uppercase tracking-wider text-slate-600">{title}</h2>
      <span className="h-px flex-1 bg-slate-200/70" />
      {children}
    </div>
  );
}

// Real Command Center signals only — the same AttentionItem rows and
// PlatformAuditLog entries Triage & Attention / Audit & Evidence already
// show, composed as a feed. No separate notification store, no invented
// "unread" state (ORG-01) — this page is a read-only projection.
export default function NotificationsPage() {
  const navigate = useNavigate();
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [forbidden, setForbidden] = useState(false);
  const seqRef = useRef(0);

  const load = useCallback(() => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    setForbidden(false);
    getTriageSummary()
      .then((res) => {
        if (seq === seqRef.current) setSummary(res);
      })
      .catch((e) => {
        if (seq !== seqRef.current) return;
        if (e?.status === 403 || /does not include/i.test(e?.message || "")) {
          setForbidden(true);
        } else {
          setError(e?.message || "Failed to load notifications.");
        }
      })
      .finally(() => {
        if (seq === seqRef.current) setLoading(false);
      });
  }, []);

  useEffect(() => { load(); }, [load]);

  const openItems = summary?.incidents?.top_items || [];
  const criticalEvents = summary?.critical_events || [];
  // The summary carries only the top 10 open items; total_open is the real
  // queue size. Showing the list alone silently hid everything past 10.
  const totalOpen = summary?.incidents?.counts?.total_open ?? openItems.length;
  const hiddenOpen = Math.max(0, totalOpen - openItems.length);
  const hasNotifications = openItems.length > 0 || criticalEvents.length > 0;

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Notifications"
        description="Open attention items and recent platform audit events — the same real signals Triage & Attention and Audit & Evidence surface, composed as one feed."
        icon={Bell}
        meta={summary ? `${totalOpen} open attention item${totalOpen === 1 ? "" : "s"} · ${criticalEvents.length} recent audit event${criticalEvents.length === 1 ? "" : "s"}` : null}
        actions={
          <Button variant="secondary" icon={RefreshCw} onClick={() => load()} loading={loading && Boolean(summary)} disabled={loading}>
            Refresh
          </Button>
        }
      />

      <div className="mt-6">
        {loading && !summary ? (
          <Spinner />
        ) : forbidden ? (
          <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm">
            <HelpCircle size={18} className="mt-0.5 shrink-0 text-amber-500" />
            <p className="text-amber-800">
              Not available — your platform role does not include the triage.read capability. Ask a Platform
              Administrator for access.
            </p>
          </div>
        ) : error && !summary ? (
          <div className="rounded-2xl border border-red-200 bg-white">
            <ErrorState message={error} onRetry={() => load()} title="Unable to load notifications" />
          </div>
        ) : (
          <>
            {error && (
              <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
                Couldn't refresh: {error} Showing the last loaded feed.
              </p>
            )}
            {!hasNotifications ? (
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
              <div className="space-y-8">
                {openItems.length > 0 && (
                  <section aria-label="Open attention items">
                    <FeedHeading title="Open attention items" />
                    <div className="space-y-3">
                      {openItems.map((item) => (
                        <button
                          type="button"
                          key={`attn-${item.id}`}
                          onClick={() => navigate("/super-admin/triage")}
                          className={ROW_CLASS}
                        >
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600">
                            <AlertTriangle className="h-4 w-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-slate-800">
                              {item.title}
                              <SeverityBadge value={item.severity} />
                              <span className="text-[11px] font-medium text-slate-500">{humanize(item.status)}</span>
                            </span>
                            <span className="mt-0.5 block text-[12px] text-slate-500">
                              {item.description || "No description"} · opened {formatDateTime(parseServerDate(item.opened_at))}
                              {item.occurrence_count > 1 && ` · ${item.occurrence_count} occurrences`}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                    {hiddenOpen > 0 && (
                      <button
                        type="button"
                        onClick={() => navigate("/super-admin/triage")}
                        className="mt-3 inline-flex items-center gap-1 px-1 text-sm font-semibold text-brand-600 hover:text-brand-700"
                      >
                        Showing the {openItems.length} highest-priority of {totalOpen} open items — view all in Triage & Attention
                        <ArrowRight size={14} />
                      </button>
                    )}
                  </section>
                )}

                {criticalEvents.length > 0 && (
                  <section aria-label="Recent audit events">
                    <FeedHeading title="Recent audit events" />
                    <div className="space-y-3">
                      {criticalEvents.map((e) => (
                        <button
                          type="button"
                          key={`evt-${e.id}`}
                          onClick={() => navigate("/super-admin/audit-logs")}
                          className={ROW_CLASS}
                        >
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-50 text-slate-600">
                            <ScrollText className="h-4 w-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] font-semibold text-slate-800">
                              {humanize(e.action)} · {e.entity_type}{e.entity_id != null ? ` #${e.entity_id}` : ""}
                            </span>
                            <span className="mt-0.5 block text-[12px] text-slate-500">
                              {e.actor_email || "System"} · {formatDateTime(parseServerDate(e.created_at))}
                              {e.reason && ` · ${e.reason}`}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
