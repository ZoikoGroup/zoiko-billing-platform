import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "./AuthContext";
import { getActivePrivilegedAccess, getJobTelemetry } from "../service/privilegedAccessService";
import { getAttentionCounts } from "../service/commandCenterService";

/**
 * Persistent Super Admin Command Center shell state (ZB-SA-CMD-003 §8/§9/§19):
 * the active/pending privileged-tenant-access grant and the Attention
 * queue's severity counts, polled so the privileged-session banner and the
 * triage strip stay visible and current across every /super-admin/* route,
 * not just the one page that happens to have fetched them.
 *
 * Every value here is a read of server-authoritative state — never
 * something this context invents or extends client-side. On every poll a
 * lazily-expired grant server-side simply stops being returned as active;
 * this context has no client-side expiry logic of its own.
 *
 * Clears immediately (not just on next poll) when the signed-in role
 * changes away from super_admin — covers logout, role change, and session
 * invalidation in one check, per the spec's "tenant context clears on
 * logout/timeout/role change/grant expiry" requirement.
 */

const CommandCenterContext = createContext(null);

const POLL_INTERVAL_MS = 20000;

export function CommandCenterProvider({ children }) {
  const { role, isAuthenticated } = useAuth();
  const [activeGrant, setActiveGrant] = useState(null);
  const [attentionCounts, setAttentionCounts] = useState(null);
  const [jobFreshness, setJobFreshness] = useState(null);
  const isSuperAdmin = isAuthenticated && role === "super_admin";
  const pollRef = useRef(null);

  const refresh = useCallback(() => {
    if (!isSuperAdmin) return;
    getActivePrivilegedAccess()
      .then((grant) => setActiveGrant(grant && grant.status === "active" ? grant : null))
      .catch(() => setActiveGrant(null));
    getAttentionCounts()
      .then(setAttentionCounts)
      .catch(() => setAttentionCounts(null));
    getJobTelemetry()
      .then(setJobFreshness)
      .catch(() => setJobFreshness(null));
  }, [isSuperAdmin]);

  useEffect(() => {
    if (!isSuperAdmin) {
      setActiveGrant(null);
      setAttentionCounts(null);
      setJobFreshness(null);
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    refresh();
    pollRef.current = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [isSuperAdmin, refresh]);

  const clearActiveGrant = useCallback(() => setActiveGrant(null), []);

  // §10.2 freshness rollup — the WORST state across all tracked jobs, so a
  // single stale/unknown signal is never hidden by healthy siblings. Values
  // come straight from the server's per-job freshness computation; this is
  // only a max() over them, never a client-side re-derivation. When the
  // scheduler is disabled there are no expected cadences, so the rollup is
  // null (the strip renders nothing rather than a fake "fresh").
  const worstFreshness = useMemo(() => {
    if (!jobFreshness || !jobFreshness.scheduler_enabled) return null;
    const jobs = jobFreshness.jobs || [];
    if (jobs.length === 0) return "unknown";
    if (jobs.some((j) => j.freshness === "unknown")) return "unknown";
    if (jobs.some((j) => j.freshness === "stale")) return "stale";
    return "fresh";
  }, [jobFreshness]);

  const value = { activeGrant, attentionCounts, worstFreshness, refresh, clearActiveGrant };
  return <CommandCenterContext.Provider value={value}>{children}</CommandCenterContext.Provider>;
}

export function useCommandCenter() {
  const ctx = useContext(CommandCenterContext);
  if (!ctx) throw new Error("useCommandCenter must be used within a CommandCenterProvider");
  return ctx;
}
