import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ClipboardCheck, Clock, RefreshCw } from "lucide-react";
import { getProductionAcceptanceReport } from "../../service/commercialService";
import { Button, PageHeader, SectionCard } from "../../components/billing-ui";
import { ErrorState, Spinner, StatusBadge } from "../../components/billing-shared";
import { ACCEPTANCE_STATUS_OPTIONS, formatDateTime } from "./constants";

/** FAIL first — the blocking criteria must never be scrolled past. */
const STATUS_ORDER = { FAIL: 0, WARNING: 1, NOT_CONFIGURED: 2, PASS: 3, NOT_APPLICABLE: 4 };

/** Same rationale: point-in-time assessment, not live monitoring. */
const STALE_AFTER_MS = 60 * 60 * 1000;

// The server recomputes every criterion on each request, so the page keeps
// itself current instead of asking the operator to reload: it re-runs on a
// timer while the tab is visible and as soon as the tab regains focus.
export const AUTO_REFRESH_MS = 5 * 60 * 1000;

const FILTERS = [
  { key: "ALL", label: "All", match: () => true },
  { key: "BLOCKING", label: "Blocking", match: (s) => s === "FAIL" },
  { key: "ATTENTION", label: "Needs attention", match: (s) => s === "WARNING" || s === "NOT_CONFIGURED" },
  { key: "CLEAR", label: "Passing", match: (s) => s === "PASS" },
  { key: "NA", label: "Not applicable", match: (s) => s === "NOT_APPLICABLE" },
];

// What an empty filter means. Zero blocking criteria is the good outcome, so
// that filter stays clickable and says so instead of greying out.
const EMPTY_FILTER_MESSAGES = {
  BLOCKING: "Nothing is blocking go-live — no criterion is failing.",
  ATTENTION: "No criteria need attention.",
  CLEAR: "No criteria are passing yet.",
  NA: "No criteria are marked not applicable.",
};

function describeAge(generatedAt) {
  const ts = new Date(generatedAt).getTime();
  if (Number.isNaN(ts)) return null;
  const elapsed = Date.now() - ts;
  if (elapsed < 0) return { text: "just now", stale: false };
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return { text: "just now", stale: false };
  if (minutes < 60) return { text: `${minutes} min ago`, stale: elapsed > STALE_AFTER_MS };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { text: `${hours} h ago`, stale: true };
  return { text: `${Math.floor(hours / 24)} d ago`, stale: true };
}

function CriteriaCard({ item }) {
  return (
    <li className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-xs font-semibold text-slate-500">{item.id}</p>
          <p className="mt-1 text-sm font-semibold leading-6 text-slate-800">{item.criterion}</p>
        </div>
        <StatusBadge status={item.status} options={ACCEPTANCE_STATUS_OPTIONS} />
      </div>
      {/*
        Evidence is the entire justification for a verdict, and several entries
        are 1000+ characters of run-on prose. It used to be squeezed into a
        table cell as 10px grey text, which made the most important field the
        least legible on the page. It gets its own readable block now, verbatim.
      */}
      <div className="mt-3 border-t border-slate-100 pt-3">
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Evidence</p>
        <p className="mt-1.5 text-sm leading-7 text-slate-600">{item.evidence}</p>
      </div>
    </li>
  );
}

/**
 * `embedded` drops this page's own PageHeader when it is mounted as a tab of
 * the System Health hub, which renders the tab-aware header itself; leaving it
 * on stacks two headers. The standalone route
 * (/super-admin/production-readiness) keeps the header.
 */
export default function ProductionAcceptancePage({ embedded = false } = {}) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("ALL");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(null);
  // Re-renders the "N min ago" label without refetching.
  const [, setClock] = useState(0);
  const inFlight = useRef(false);

  // First load shows a spinner; later re-runs keep the current report on
  // screen and only mark it as refreshing, so the checklist never blanks out.
  const load = useCallback((background = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (background) setRefreshing(true);
    else {
      setLoading(true);
      setError(null);
    }
    setRefreshError(null);
    getProductionAcceptanceReport()
      .then(setReport)
      .catch((e) => {
        const message = e?.message || "Failed to load the production acceptance report.";
        if (background) setRefreshError(message);
        else setError(message);
      })
      .finally(() => {
        inFlight.current = false;
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const rerun = () => {
      if (document.visibilityState === "visible") load(true);
    };
    const timer = setInterval(rerun, AUTO_REFRESH_MS);
    const tick = setInterval(() => setClock((n) => n + 1), 60 * 1000);
    document.addEventListener("visibilitychange", rerun);
    return () => {
      clearInterval(timer);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", rerun);
    };
  }, [load]);

  const items = useMemo(() => report?.items ?? [], [report]);

  const counts = useMemo(() => {
    const tally = { PASS: 0, WARNING: 0, FAIL: 0, NOT_CONFIGURED: 0, NOT_APPLICABLE: 0 };
    for (const item of items) if (item.status in tally) tally[item.status] += 1;
    return tally;
  }, [items]);

  const ordered = useMemo(
    () => [...items].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)),
    [items]
  );

  const visible = useMemo(() => {
    const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
    return ordered.filter((item) => active.match(item.status));
  }, [ordered, filter]);

  const age = report?.generated_at ? describeAge(report.generated_at) : null;

  return (
    <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
      {!embedded && (
        <PageHeader
          title="Production Readiness"
          description="ZB-COM-BILL-001 §26 Mandatory Production Acceptance Checklist — an architecture assessment re-checked automatically while this page is open. GO-01 (signed acceptance) remains a governance action this report cannot certify."
          icon={ClipboardCheck}
          meta={report ? `Generated ${formatDateTime(report.generated_at)}` : null}
          accent="teal"
        />
      )}

      {embedded && (
        <p className="mb-4 text-xs text-slate-500">
          An architecture assessment against the go-live checklist, re-checked automatically while this page is
          open. GO-01 (signed acceptance) is a governance action this report cannot certify.
        </p>
      )}

      <div className={embedded ? "" : "mt-6"}>
        {loading ? (
          <Spinner />
        ) : error ? (
          <ErrorState message={error} onRetry={load} title="Unable to load the production acceptance report" />
        ) : (
          <>
            <SectionCard variant="standard">
              {/* Reordering the tiles so FAIL leads: previously every status got
                  an identical prominent card, which let "Not Applicable" — the
                  least actionable state — carry the same visual weight as a
                  blocking failure. */}
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
                {["FAIL", "WARNING", "NOT_CONFIGURED", "PASS", "NOT_APPLICABLE"].map((status) => {
                  const opt = ACCEPTANCE_STATUS_OPTIONS.find((o) => o.value === status);
                  if (!opt) return null;
                  return (
                    <div
                      key={opt.value}
                      className={`rounded-2xl border bg-white p-4 text-center shadow-[0_4px_20px_rgba(0,0,0,0.02)] ${
                        counts[status] > 0 && status === "FAIL" ? "border-red-200 bg-red-50/40" : "border-slate-200"
                      }`}
                    >
                      <p className="text-2xl font-extrabold text-slate-800">{counts[status]}</p>
                      <p className="mt-1 text-xs font-semibold uppercase tracking-wider text-slate-600">{opt.label}</p>
                    </div>
                  );
                })}
              </div>

              {age && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <p
                    className={`flex items-center gap-1.5 text-xs ${
                      age.stale ? "font-semibold text-amber-700" : "text-slate-500"
                    }`}
                  >
                    <Clock size={13} />
                    Assessed {formatDateTime(report.generated_at)} ({age.text}) · re-checks automatically every{" "}
                    {AUTO_REFRESH_MS / 60000} min while this page is open.
                    {age.stale ? " The last automatic re-check did not complete — re-run it now." : ""}
                  </p>
                  <Button size="sm" variant="secondary" icon={RefreshCw} loading={refreshing} onClick={() => load(true)}>
                    {refreshing ? "Re-running…" : "Re-run now"}
                  </Button>
                </div>
              )}
              {refreshError && (
                <p role="alert" className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  Re-run failed: {refreshError}. Showing the previous assessment.
                </p>
              )}

              <div className="mt-6 flex flex-wrap items-center gap-2" role="group" aria-label="Filter acceptance criteria">
                {FILTERS.map((f) => {
                  const total = items.filter((item) => f.match(item.status)).length;
                  const active = filter === f.key;
                  return (
                    <button
                      key={f.key}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setFilter(f.key)}
                      className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                        active
                          ? "border-slate-800 bg-slate-800 text-white"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                      }`}
                    >
                      {f.label}
                      <span className="ml-1.5 font-mono opacity-70">{total}</span>
                    </button>
                  );
                })}
              </div>

              {visible.length === 0 ? (
                <div className="mt-4 flex items-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
                  <CheckCircle2 size={16} className="shrink-0 text-emerald-600" />
                  {EMPTY_FILTER_MESSAGES[filter] || "No criteria in this view."}
                </div>
              ) : (
                <ul className="mt-4 space-y-3">
                  {visible.map((item) => (
                    <CriteriaCard key={item.id} item={item} />
                  ))}
                </ul>
              )}
            </SectionCard>
          </>
        )}
      </div>
    </div>
  );
}
