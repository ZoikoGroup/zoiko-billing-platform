import React from "react";
import { Calendar, ChevronDown, RefreshCw } from "lucide-react";
import { useCommandCenter } from "../context/CommandCenterContext";

// Domain selection drives the active lens — the only cross-domain navigation
// primitive the platform actually has (Domain A = Commercial plane, Domain C =
// telemetry/reliability plane).
const DOMAIN_LENS_MAP = {
  "Global Operations": "triage",
  "Domain A (Commercial)": "commercial",
  "Domain C (Telemetry)": "reliability",
};

export default function CommandCenterContextBar() {
  const { contextScope, updateContextScope, setActiveLens, lastRefreshedAt, requestRefresh, environmentVerified } = useCommandCenter();

  const formattedTime = lastRefreshedAt
    ? new Date(lastRefreshedAt).toUTCString().replace("GMT", "UTC").slice(5, 22)
    : "Live";

  function handleDomainChange(value) {
    updateContextScope("domain", value);
    const lens = DOMAIN_LENS_MAP[value];
    if (lens) setActiveLens(lens);
  }

  // §21 — environment identity comes from the backend configuration
  // inventory (derived from the DEBUG flag). Until that fetch succeeds the
  // badge reads UNVERIFIED rather than asserting a production identity the
  // client cannot prove.
  const envLabel = environmentVerified ? contextScope.environment : "ENV UNVERIFIED";
  const envDotClass = !environmentVerified
    ? "bg-slate-400"
    : contextScope.environment === "PRODUCTION"
      ? "bg-emerald-500"
      : "bg-amber-500";

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* Environment — single-environment platform today. A locked badge rather
            than a selector implying a SANDBOX that does not exist (audit finding
            D-10: decorative controls must not imply capabilities the product
            disclaims). */}
        <div
          className="bg-white border border-slate-200 rounded px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-slate-700 flex items-center gap-1 shadow-sm"
          title={
            environmentVerified
              ? `Deployment environment reported by the platform configuration inventory: ${contextScope.environment}`
              : "Environment could not be verified from the configuration inventory"
          }
        >
          <span className={`w-2 h-2 rounded-full mr-1 ${envDotClass}`} />
          <span>{envLabel}</span>
        </div>

        {/* Domain — switches the active command-center lens */}
        <div className="bg-white border border-slate-200 rounded px-2.5 py-1 text-xs font-medium text-slate-700 flex items-center gap-1 shadow-sm hover:bg-slate-50">
          <select
            value={contextScope.domain}
            onChange={(e) => handleDomainChange(e.target.value)}
            className="bg-transparent font-medium text-slate-700 focus:outline-none cursor-pointer appearance-none pr-1"
            aria-label="Filter by domain"
          >
            <option value="Global Operations">Global Operations</option>
            <option value="Domain A (Commercial)">Domain A (Commercial)</option>
            <option value="Domain C (Telemetry)">Domain C (Telemetry)</option>
          </select>
          <ChevronDown className="w-3 h-3 text-slate-400" />
        </div>

        {/* Period — real window: bounds date_from on period-windowed queries.
            Legal Entity / Region / Reporting Currency selectors were removed:
            no legal-entity model, no platform region dimension and no FX
            conversion engine exist server-side (finding D-10). */}
        <div className="bg-white border border-slate-200 rounded px-2.5 py-1 text-xs font-medium text-slate-700 flex items-center gap-1 shadow-sm hover:bg-slate-50">
          <Calendar className="w-3 h-3 mr-0.5 text-slate-500" />
          <select
            value={contextScope.period}
            onChange={(e) => updateContextScope("period", e.target.value)}
            className="bg-transparent font-medium text-slate-700 focus:outline-none cursor-pointer appearance-none pr-1"
            aria-label="Select reporting period"
          >
            <option value="Last 30 Days">Last 30 Days</option>
            <option value="Last 7 Days">Last 7 Days</option>
            <option value="Month to Date">Month to Date</option>
            <option value="Quarter to Date">Quarter to Date</option>
          </select>
          <ChevronDown className="w-3 h-3 text-slate-400" />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[10px] text-slate-400">Data as of {formattedTime}</span>
        <button
          type="button"
          onClick={requestRefresh}
          title="Refresh Command Center"
          aria-label="Refresh Command Center"
          className="inline-flex items-center gap-1 bg-white border border-slate-200 rounded px-2.5 py-1 text-xs font-medium text-slate-600 shadow-sm hover:bg-slate-50 hover:text-slate-900"
        >
          <RefreshCw className="w-3 h-3" />
          <span>Refresh</span>
        </button>
      </div>
    </div>
  );
}
