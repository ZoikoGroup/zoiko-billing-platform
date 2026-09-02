/**
 * components/executive-summary.jsx
 * ---------------------------------
 * ExecutiveSummary is extracted from billing-ui.jsx into its own module so
 * component chains that only need the insight strip (e.g. billing-shared.jsx,
 * which is imported by ~100+ pages) do not drag in the rest of billing-ui.
 *
 * It renders nothing heavier than a few lucide icons — it is kept recharts-free
 * by design. billing-ui.jsx re-exports it for backward compatibility.
 */

import { Check } from "lucide-react";

const INSIGHT_TONES = {
  up: "bg-emerald-50 border-emerald-200 text-emerald-700",
  down: "bg-red-50 border-red-200 text-red-700",
  neutral: "bg-slate-50 border-slate-200 text-slate-600",
  warning: "bg-amber-50 border-amber-200 text-amber-700",
};

export function ExecutiveSummary({ items = [], className = "" }) {
  if (!items.length) return null;
  return (
    <section aria-label="Key insights" className={`rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)] ${className}`}>
      <div className="flex flex-wrap items-center gap-2.5">
        {items.map((item, idx) => {
          const Icon = item.icon || Check;
          const tone = INSIGHT_TONES[item.tone] || INSIGHT_TONES.neutral;
          return (
            <span key={idx} className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-semibold ${tone}`}>
              <Icon size={14} className="shrink-0" />
              <span className="whitespace-nowrap">{item.text}</span>
            </span>
          );
        })}
      </div>
    </section>
  );
}