import React from "react";
import { RefreshCw } from "lucide-react";
import { useCommandCenter } from "../context/CommandCenterContext";

export default function CommandCenterContextBar() {
  const { contextScope, updateContextScope, lastRefreshedAt, refresh } = useCommandCenter();

  const formattedTime = lastRefreshedAt
    ? new Date(lastRefreshedAt).toUTCString().replace("GMT", "UTC").slice(5, 22)
    : "Live";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
      <div className="flex flex-wrap items-center gap-3">
        {/* Environment Filter */}
        <div className="flex flex-col">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">Environment</span>
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
            <span className={`h-2 w-2 rounded-full ${contextScope.environment === "PRODUCTION" ? "bg-emerald-500" : "bg-amber-500"}`} />
            <select
              value={contextScope.environment}
              onChange={(e) => updateContextScope("environment", e.target.value)}
              className="bg-transparent font-bold text-slate-800 focus:outline-none cursor-pointer"
              aria-label="Select environment"
            >
              <option value="PRODUCTION">PRODUCTION</option>
              <option value="SANDBOX">SANDBOX</option>
            </select>
          </div>
        </div>

        <div className="h-6 w-px bg-slate-200" />

        {/* Domain Filter */}
        <div className="flex flex-col">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">Domain</span>
          <select
            value={contextScope.domain}
            onChange={(e) => updateContextScope("domain", e.target.value)}
            className="bg-transparent text-xs font-semibold text-slate-800 focus:outline-none cursor-pointer"
            aria-label="Filter by domain"
          >
            <option value="Global Operations">Global Operations</option>
            <option value="Domain A (Commercial)">Domain A (Commercial)</option>
            <option value="Domain C (Telemetry)">Domain C (Telemetry)</option>
          </select>
        </div>

        <div className="h-6 w-px bg-slate-200" />

        {/* Legal Entity */}
        <div className="flex flex-col">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">Legal Entity</span>
          <select
            value={contextScope.legalEntity}
            onChange={(e) => updateContextScope("legalEntity", e.target.value)}
            className="bg-transparent text-xs font-semibold text-slate-800 focus:outline-none cursor-pointer"
            aria-label="Filter by legal entity"
          >
            <option value="All Entities">All Entities</option>
            <option value="ZB-US-01">ZB-US-01 (North America)</option>
            <option value="ZB-EU-01">ZB-EU-01 (Europe)</option>
            <option value="ZB-UK-01">ZB-UK-01 (United Kingdom)</option>
          </select>
        </div>

        <div className="h-6 w-px bg-slate-200" />

        {/* Region */}
        <div className="flex flex-col">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">Region</span>
          <select
            value={contextScope.region}
            onChange={(e) => updateContextScope("region", e.target.value)}
            className="bg-transparent text-xs font-semibold text-slate-800 focus:outline-none cursor-pointer"
            aria-label="Filter by region"
          >
            <option value="Global">Global</option>
            <option value="US-East">US-East</option>
            <option value="EU-Central">EU-Central</option>
            <option value="AP-South">AP-South</option>
          </select>
        </div>

        <div className="h-6 w-px bg-slate-200" />

        {/* Reporting Currency */}
        <div className="flex flex-col">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">Reporting Currency</span>
          <select
            value={contextScope.reportingCurrency}
            onChange={(e) => updateContextScope("reportingCurrency", e.target.value)}
            className="bg-transparent text-xs font-semibold text-slate-800 focus:outline-none cursor-pointer"
            aria-label="Select reporting currency"
          >
            <option value="USD (USD)">USD (USD)</option>
            <option value="EUR (EUR)">EUR (EUR)</option>
            <option value="GBP (GBP)">GBP (GBP)</option>
          </select>
        </div>

        <div className="h-6 w-px bg-slate-200" />

        {/* Period */}
        <div className="flex flex-col">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">Period</span>
          <select
            value={contextScope.period}
            onChange={(e) => updateContextScope("period", e.target.value)}
            className="bg-transparent text-xs font-semibold text-slate-800 focus:outline-none cursor-pointer"
            aria-label="Select reporting period"
          >
            <option value="Last 30 Days">Last 30 Days</option>
            <option value="Last 7 Days">Last 7 Days</option>
            <option value="Month to Date">Month to Date</option>
            <option value="Quarter to Date">Quarter to Date</option>
          </select>
        </div>
      </div>

      {/* Freshness & Refresh */}
      <div className="flex items-center gap-3">
        <div className="text-right">
          <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-600">Data as of</span>
          <span className="text-xs font-medium text-slate-700">{formattedTime}</span>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
          title="Refresh Command Center"
        >
          <RefreshCw size={14} />
        </button>
      </div>
    </div>
  );
}
