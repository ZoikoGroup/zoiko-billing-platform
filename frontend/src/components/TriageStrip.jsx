import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Building2, CheckCircle2, HelpCircle } from "lucide-react";
import { useCommandCenter } from "../context/CommandCenterContext";

/**
 * Persistent compact Attention strip (ZB-SA-CMD-003 §9/§10.2) — visible on
 * every /super-admin/* route via BillingShell, not just the Governance lens.
 * Carries three always-on context signals:
 *   - severity counts (Attention Engine),
 *   - the active privileged-access tenant scope chip (§6 — "you are acting
 *     in the context of tenant X" must be visible everywhere, not one page),
 *   - the worst-freshness rollup across tracked jobs (§10.2).
 * Collapses to a one-line healthy state when there is nothing open, per
 * §15.3's empty-state law ("a true zero is useful, never hidden as if it
 * proves nothing needs building").
 */

const FRESHNESS_CHIP = {
  fresh: { className: "text-emerald-700", icon: CheckCircle2, label: "Jobs fresh" },
  stale: { className: "text-amber-700", icon: AlertTriangle, label: "Jobs stale" },
  unknown: { className: "text-slate-500", icon: HelpCircle, label: "Job freshness unknown" },
};

export default function TriageStrip() {
  const { attentionCounts, activeGrant, worstFreshness } = useCommandCenter();

  // §15.3 — a NEW P0 must be impossible to miss: the count chip pulses for
  // two seconds when the observed P0 count rises. The global
  // prefers-reduced-motion rule in index.css disables the animation for
  // operators who need stillness; the red chip itself remains.
  const [pulseP0, setPulseP0] = useState(false);
  const prevP0Ref = useRef(attentionCounts?.p0 ?? 0);
  useEffect(() => {
    const next = attentionCounts?.p0 ?? 0;
    const grew = next > prevP0Ref.current;
    prevP0Ref.current = next;
    if (!grew) return;
    setPulseP0(true);
    const t = setTimeout(() => setPulseP0(false), 2000);
    return () => clearTimeout(t);
  }, [attentionCounts?.p0]);

  if (!attentionCounts) return null;

  const { p0, p1, p2, p3, total_open: totalOpen, sla_breaches: slaBreaches } = attentionCounts;
  const freshness = worstFreshness ? FRESHNESS_CHIP[worstFreshness] : null;
  const FreshnessIcon = freshness?.icon;

  const scopeChip = activeGrant ? (
    <span
      className="flex items-center gap-1.5 rounded-full bg-indigo-100 px-2 py-0.5 text-indigo-800"
      title={`Privileged access to organization #${activeGrant.organization_id} is ACTIVE until ${new Date(activeGrant.expires_at).toLocaleTimeString()}`}
    >
      <Building2 size={12} />
      Scope: org #{activeGrant.organization_id}
    </span>
  ) : null;

  if (totalOpen === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3 border-b border-emerald-200 bg-emerald-50 px-4 py-1.5 text-xs font-medium text-emerald-700 sm:px-6">
        <span>No active P0/P1 — 0 open attention items</span>
        {scopeChip}
        {freshness && FreshnessIcon && (
          <span className={`ml-auto flex items-center gap-1.5 ${freshness.className}`}>
            <FreshnessIcon size={13} /> {freshness.label}
          </span>
        )}
      </div>
    );
  }

  return (
    <Link
      to="/super-admin/governance"
      className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs font-semibold text-amber-800 transition hover:bg-amber-100 sm:px-6"
    >
      <span className="flex items-center gap-1.5">
        <AlertTriangle size={13} /> ATTENTION
      </span>
      {p0 > 0 && (
        <span
          className={`rounded-full bg-red-600 px-2 py-0.5 text-white ${pulseP0 ? "animate-pulse" : ""}`}
        >
          P0 {p0}
        </span>
      )}
      {p1 > 0 && <span className="rounded-full bg-orange-500 px-2 py-0.5 text-white">P1 {p1}</span>}
      {p2 > 0 && <span className="rounded-full bg-amber-400 px-2 py-0.5 text-slate-900">P2 {p2}</span>}
      {p3 > 0 && <span className="rounded-full bg-slate-400 px-2 py-0.5 text-slate-900">P3 {p3}</span>}
      {slaBreaches > 0 && <span className="text-red-700">{slaBreaches} SLA breach{slaBreaches === 1 ? "" : "es"}</span>}
      {scopeChip}
      {freshness && FreshnessIcon && (
        <span className={`ml-auto flex items-center gap-1.5 ${freshness.className}`}>
          <FreshnessIcon size={13} /> {freshness.label}
        </span>
      )}
      <span className={`${freshness ? "" : "ml-auto"} text-amber-700 underline decoration-dotted`}>Open queue →</span>
    </Link>
  );
}
