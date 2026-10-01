import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardCheck, Clock, HelpCircle, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { getProductionAcceptanceReport } from "../../service/commercialService";
import { PageHeader, SectionCard } from "../../components/billing-ui";
import { ErrorState, Spinner, StatusBadge } from "../../components/billing-shared";
import { ACCEPTANCE_STATUS_OPTIONS, formatDateTime } from "./constants";

/** FAIL first — the blocking criteria must never be scrolled past. */
const STATUS_ORDER = { FAIL: 0, WARNING: 1, NOT_CONFIGURED: 2, PASS: 3, NOT_APPLICABLE: 4 };

const OVERALL_VERDICT_STYLES = {
  BLOCKED: {
    icon: ShieldAlert,
    wrapper: "border-red-200 bg-red-50 text-red-800",
    iconWrapper: "bg-red-100 text-red-600",
    label: "NOT READY FOR PRODUCTION — BLOCKED",
  },
  CONDITIONAL: {
    icon: ShieldQuestion,
    wrapper: "border-amber-200 bg-amber-50 text-amber-800",
    iconWrapper: "bg-amber-100 text-amber-600",
    label: "CONDITIONALLY READY",
  },
  READY: {
    icon: ShieldCheck,
    wrapper: "border-emerald-200 bg-emerald-50 text-emerald-800",
    iconWrapper: "bg-emerald-100 text-emerald-700",
    label: "READY",
  },
};

/**
 * Deliberately NOT a fallback to CONDITIONAL. A release gate that quietly
 * renders "CONDITIONALLY READY" for a verdict it does not recognise is worse
 * than one that renders nothing: it puts a plausible-looking answer on a
 * go-live decision. Say the verdict is unreadable instead.
 */
const UNRECOGNISED_VERDICT = {
  icon: HelpCircle,
  wrapper: "border-slate-300 bg-slate-100 text-slate-800",
  iconWrapper: "bg-slate-200 text-slate-600",
  label: "UNRECOGNISED VERDICT",
};

/** Same rationale: point-in-time assessment, not live monitoring. */
const STALE_AFTER_MS = 60 * 60 * 1000;

const FILTERS = [
  { key: "ALL", label: "All", match: () => true },
  { key: "BLOCKING", label: "Blocking", match: (s) => s === "FAIL" },
  { key: "ATTENTION", label: "Needs attention", match: (s) => s === "WARNING" || s === "NOT_CONFIGURED" },
  { key: "CLEAR", label: "Passing", match: (s) => s === "PASS" },
  { key: "NA", label: "Not applicable", match: (s) => s === "NOT_APPLICABLE" },
];

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

function VerdictBanner({ overallStatus, summary }) {
  const verdict = OVERALL_VERDICT_STYLES[overallStatus] || UNRECOGNISED_VERDICT;
  const Icon = verdict.icon;
  return (
    <div className={`mb-6 flex items-start gap-4 rounded-3xl border p-5 ${verdict.wrapper}`} role="alert">
      <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${verdict.iconWrapper}`}>
        <Icon size={22} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold uppercase tracking-wider">Overall verdict</p>
        <h2 className="mt-1 text-lg font-extrabold">{verdict.label}</h2>
        {overallStatus && !OVERALL_VERDICT_STYLES[overallStatus] ? (
          <p className="mt-1.5 text-sm leading-6">
            This report returned the verdict <code className="rounded bg-white/70 px-1 font-mono">{overallStatus}</code>,
            which this page does not recognise. Treat the checklist below as unverified and do not read it as an
            approval.
          </p>
        ) : (
          <p className="mt-1.5 text-sm leading-6">{summary}</p>
        )}
      </div>
    </div>
  );
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

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getProductionAcceptanceReport()
      .then(setReport)
      .catch((e) => setError(e?.message || "Failed to load the production acceptance report."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
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

  // Reset to All if a filter would otherwise show an empty list that looks
  // like the report has no criteria.
  useEffect(() => {
    if (!loading && filter !== "ALL" && visible.length === 0) setFilter("ALL");
  }, [loading, filter, visible.length]);

  const age = report?.generated_at ? describeAge(report.generated_at) : null;

  return (
    <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
      {!embedded && (
        <PageHeader
          title="Production Readiness"
          description="ZB-COM-BILL-001 §26 Mandatory Production Acceptance Checklist — a point-in-time architecture assessment, not live monitoring. GO-01 (signed acceptance) remains a governance action this report cannot certify."
          icon={ClipboardCheck}
          meta={report ? `Generated ${formatDateTime(report.generated_at)}` : null}
          accent="teal"
        />
      )}

      {embedded && (
        <p className="mb-4 text-xs text-slate-500">
          A point-in-time architecture assessment, not live monitoring. GO-01 (signed acceptance) is a governance
          action this report cannot certify.
        </p>
      )}

      <div className={embedded ? "" : "mt-6"}>
        {loading ? (
          <Spinner />
        ) : error ? (
          <ErrorState message={error} onRetry={load} title="Unable to load the production acceptance report" />
        ) : (
          <>
            {report?.overall_status ? (
              <VerdictBanner overallStatus={report.overall_status} summary={report.summary} />
            ) : null}

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
                <p
                  className={`mt-3 flex items-center gap-1.5 text-xs ${
                    age.stale ? "font-semibold text-amber-700" : "text-slate-500"
                  }`}
                >
                  <Clock size={13} />
                  Generated {formatDateTime(report.generated_at)} ({age.text}).
                  {age.stale
                    ? " This assessment is a snapshot and nothing here re-checks itself — reload before relying on it."
                    : ""}
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
                      disabled={total === 0 && !active}
                      onClick={() => setFilter(f.key)}
                      className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                        active
                          ? "border-slate-800 bg-slate-800 text-white"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
                      }`}
                    >
                      {f.label}
                      <span className="ml-1.5 font-mono opacity-70">{total}</span>
                    </button>
                  );
                })}
              </div>

              <ul className="mt-4 space-y-3">
                {visible.map((item) => (
                  <CriteriaCard key={item.id} item={item} />
                ))}
              </ul>
            </SectionCard>
          </>
        )}
      </div>
    </div>
  );
}
