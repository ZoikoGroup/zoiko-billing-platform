import React, { useCallback, useEffect, useState } from "react";
import { CheckSquare, ClipboardCheck, ScrollText, ShieldAlert, ShieldCheck, AlertTriangle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { listApprovalRequests } from "../../../service/commercialService";

export default function GovernanceLens({ readiness, activity }) {
  const navigate = useNavigate();
  const [pendingCount, setPendingCount] = useState(null);
  const [pendingTypes, setPendingTypes] = useState({});
  const [approvalLoading, setApprovalLoading] = useState(true);

  const loadApprovals = useCallback(() => {
    setApprovalLoading(true);
    listApprovalRequests({ status: "pending", limit: 200 })
      .then((data) => {
        const requests = data.requests || [];
        // Use the server's authoritative `total`, not requests.length — the
        // fetch is capped at limit:200, so length alone undercounts once
        // more than 200 requests are pending.
        setPendingCount(data.total ?? requests.length);
        const types = {};
        for (const r of requests) {
          types[r.request_type] = (types[r.request_type] || 0) + 1;
        }
        setPendingTypes(types);
      })
      .catch(() => {
        setPendingCount(null);
        setPendingTypes({});
      })
      .finally(() => setApprovalLoading(false));
  }, []);

  useEffect(() => {
    loadApprovals();
  }, [loadApprovals]);

  const pendingDisplay = approvalLoading ? "—" : (pendingCount ?? "—");
  const hasAction = !approvalLoading && (pendingCount ?? 0) > 0;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* G1: Approval Center */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">G1 · Approval Center</h3>
          <button
            type="button"
            onClick={() => navigate("/super-admin/approval-queue")}
            className="text-xs font-bold text-brand-600 hover:text-brand-800"
          >
            Review Queue →
          </button>
        </div>
        <div className="mt-4 flex items-center justify-between rounded-2xl border border-slate-100 bg-slate-50 p-4">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">
              Pending Maker-Checker Requests
            </span>
            <p className="mt-1 text-2xl font-extrabold text-slate-900">{pendingDisplay}</p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-extrabold ${
              hasAction
                ? "bg-amber-100 text-amber-800"
                : "bg-emerald-100 text-emerald-800"
            }`}
          >
            {hasAction ? "Action Required" : "Queue Empty"}
          </span>
        </div>
        {Object.keys(pendingTypes).length > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            {Object.entries(pendingTypes).map(([type, count]) => (
              <div key={type} className="rounded-xl border border-slate-100 p-2 text-center text-slate-600">
                {type.replace(/_/g, " ")}:{" "}
                <strong className="text-slate-800">{count}</strong>
              </div>
            ))}
          </div>
        )}
        {hasAction && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            <AlertTriangle size={12} />
            Self-approval is blocked server-side. A second Super Admin must decide.
          </div>
        )}
      </div>

      {/* G2: Privileged Access */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">G2 · Privileged Access (JIT)</h3>
          <button
            type="button"
            onClick={() => navigate("/super-admin/support-access")}
            className="text-xs font-bold text-brand-600 hover:text-brand-800"
          >
            Manage Grants →
          </button>
        </div>
        <div className="mt-4 space-y-2.5 text-xs">
          <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
            <span className="font-bold text-slate-800">Just-In-Time Tenant Access</span>
            <p className="mt-1 text-[11px] text-slate-600">
              Standing tenant access is disabled. Operator access requires ticket reference, business
              reason, TOTP step-up, and auto-expires in ≤ 30 minutes.
            </p>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
            <span className="font-bold text-slate-800">Domain Isolation</span>
            <p className="mt-1 text-[11px] text-slate-600">
              Grants are scoped to exactly one tenant organization. Platform-plane data is not
              accessible through the support access path.
            </p>
          </div>
        </div>
      </div>

      {/* G3: Audit & Evidence */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">G3 · Audit &amp; Evidence</h3>
          <button
            type="button"
            onClick={() => navigate("/super-admin/audit-logs")}
            className="text-xs font-bold text-brand-600 hover:text-brand-800"
          >
            Audit Trail →
          </button>
        </div>
        <div className="mt-4 space-y-2 text-xs">
          {(activity || []).slice(0, 3).map((log) => (
            <div
              key={log.id}
              className="flex items-center justify-between border-b border-slate-100 pb-2 last:border-0"
            >
              <div>
                <span className="font-bold text-slate-900">{log.action}</span>
                <span className="ml-1 text-slate-600">on {log.entity_type}</span>
              </div>
              <span className="text-[10px] text-slate-500">
                {new Date(log.created_at).toLocaleTimeString()}
              </span>
            </div>
          ))}
          {(!activity || activity.length === 0) && (
            <p className="py-3 text-center text-xs text-slate-500">
              Append-only audit store active — no recent platform events.
            </p>
          )}
        </div>
      </div>

      {/* G4: Release Control */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">G4 · Release Control</h3>
          <button
            type="button"
            onClick={() => navigate("/super-admin/production-readiness")}
            className="text-xs font-bold text-brand-600 hover:text-brand-800"
          >
            Checklist →
          </button>
        </div>
        <div className="mt-4 flex items-center justify-between rounded-2xl border border-slate-100 bg-slate-50 p-4">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">
              Table 13 Production Gate Verdict
            </span>
            <p className="mt-1 text-lg font-extrabold text-slate-900">
              {readiness?.overall_status || "UNKNOWN"}
            </p>
          </div>
          <span className="rounded-full bg-slate-200 px-3 py-1 text-xs font-extrabold text-slate-800">
            {readiness?.items?.length ? `${readiness.items.length} Criteria` : "Criteria count unavailable"}
          </span>
        </div>
        {readiness?.overall_status === "BLOCKED" && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
            <ShieldAlert size={12} />
            Release gate BLOCKED — review failing criteria before proceeding.
          </div>
        )}
      </div>
    </div>
  );
}
