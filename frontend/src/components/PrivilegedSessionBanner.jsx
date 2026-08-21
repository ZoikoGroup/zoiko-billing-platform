import React, { useEffect, useRef, useState } from "react";
import { Building2, Clock, LogOut } from "lucide-react";
import { exitPrivilegedAccess } from "../service/privilegedAccessService";
import { useCommandCenter } from "../context/CommandCenterContext";

// Real Vite build mode — the closest honest "environment" label this
// platform has; there is no Sandbox/Production concept modeled anywhere in
// the backend (see docs/SUPER_ADMIN_CURRENT_STATE.md).
const ENVIRONMENT_LABEL = (import.meta.env.MODE || "development").toUpperCase();

function msRemaining(expiresAt) {
  if (!expiresAt) return 0;
  return Math.max(0, new Date(expiresAt).getTime() - Date.now());
}

function formatCountdown(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Persistent tenant-context chrome (ZB-SA-CMD-003 §19) — rendered by
 * BillingShell on every /super-admin/* route whenever a privileged grant is
 * ACTIVE, not only on the Support Access page itself. This is what
 * prevents an operator from forgetting they are inside a tenant's context
 * while navigating elsewhere in the Command Center.
 */
export default function PrivilegedSessionBanner() {
  const { activeGrant, refresh, clearActiveGrant } = useCommandCenter();
  const [remainingMs, setRemainingMs] = useState(() => msRemaining(activeGrant?.expires_at));
  const [exiting, setExiting] = useState(false);
  const expiredRef = useRef(false);

  useEffect(() => {
    expiredRef.current = false;
  }, [activeGrant?.id]);

  useEffect(() => {
    if (!activeGrant) return undefined;
    const timer = setInterval(() => setRemainingMs(msRemaining(activeGrant.expires_at)), 1000);
    return () => clearInterval(timer);
  }, [activeGrant]);

  useEffect(() => {
    if (activeGrant && remainingMs <= 0 && !expiredRef.current) {
      expiredRef.current = true;
      refresh();
    }
  }, [activeGrant, remainingMs, refresh]);

  if (!activeGrant) return null;

  async function handleExit() {
    setExiting(true);
    try {
      await exitPrivilegedAccess(activeGrant.id);
    } finally {
      setExiting(false);
      clearActiveGrant();
      refresh();
    }
  }

  return (
    <div className="sticky top-0 z-40 border-b-2 border-red-300 bg-red-50 px-4 py-2.5 sm:px-6">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-red-700">
            <Building2 size={13} /> Tenant Context — {activeGrant.organization_name} · DOMAIN B · {ENVIRONMENT_LABEL}
          </p>
          <p className="truncate text-xs text-red-800">
            Privileged support access · Read-only financial view · {activeGrant.ticket_reference} · Exports disabled
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-xs font-bold text-red-700">
            <Clock size={13} /> {formatCountdown(remainingMs)}
          </span>
          <button
            type="button"
            onClick={handleExit}
            disabled={exiting}
            className="inline-flex items-center gap-1.5 rounded-full bg-red-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-red-700 disabled:opacity-60"
          >
            <LogOut size={13} /> Exit tenant context
          </button>
        </div>
      </div>
    </div>
  );
}
