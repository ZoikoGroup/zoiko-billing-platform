import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "./AuthContext";
import { canReadReliabilityTelemetry } from "../config/roles";
import { getActivePrivilegedAccess, getJobTelemetry } from "../service/privilegedAccessService";
import { getAttentionCounts } from "../service/commandCenterService";

/**
 * Persistent Super Admin Command Center shell state (ZB-SA-CMD-003 §8/§9/§19):
 * 1. Persistent Context Bar scope (Environment, Domain, Legal Entity, Region, Currency, Period)
 * 2. Active 5-lens selection (Triage [default], Commercial, Financial Ops, Reliability, Governance)
 * 3. Active/pending privileged-tenant-access grant and countdown
 * 4. Attention queue severity counts
 * 5. Worst freshness rollup across background jobs and telemetry
 *
 * Invariant: Clears immediately when role changes away from super_admin.
 */

const CommandCenterContext = createContext(null);

const POLL_INTERVAL_MS = 20000;

export function CommandCenterProvider({ children }) {
  const { role, user, isAuthenticated } = useAuth();
  const isSuperAdmin = isAuthenticated && role === "super_admin";
  const canReadJobs = canReadReliabilityTelemetry(user?.platform_role);

  // Lens management (Default: "triage", ZB-SA-CMD-003 §11)
  const [activeLens, setActiveLens] = useState("triage");

  // Persistent Context Bar filters
  const [contextScope, setContextScope] = useState({
    environment: "PRODUCTION",
    domain: "Global Operations",
    legalEntity: "All Entities",
    region: "Global",
    reportingCurrency: "USD (USD)",
    period: "Last 30 Days",
  });

  const [lastRefreshedAt, setLastRefreshedAt] = useState(new Date());
  const [activeGrant, setActiveGrant] = useState(null);
  const [attentionCounts, setAttentionCounts] = useState(null);
  const [jobFreshness, setJobFreshness] = useState(null);
  const pollRef = useRef(null);

  const updateContextScope = useCallback((field, value) => {
    setContextScope((prev) => ({ ...prev, [field]: value }));
  }, []);

  const refresh = useCallback(() => {
    if (!isSuperAdmin) return;
    setLastRefreshedAt(new Date());
    getActivePrivilegedAccess()
      .then((grant) => setActiveGrant(grant && grant.status === "active" ? grant : null))
      .catch(() => setActiveGrant(null));
    getAttentionCounts()
      .then(setAttentionCounts)
      .catch(() => setAttentionCounts(null));
    if (canReadJobs) {
      getJobTelemetry()
        .then(setJobFreshness)
        .catch(() => setJobFreshness(null));
    }
  }, [isSuperAdmin, canReadJobs]);

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

  // §10.2 freshness rollup — the WORST state across all tracked jobs.
  const worstFreshness = useMemo(() => {
    if (!jobFreshness || !jobFreshness.scheduler_enabled) return null;
    const jobs = jobFreshness.jobs || [];
    if (jobs.length === 0) return "unknown";
    if (jobs.some((j) => j.freshness === "unknown")) return "unknown";
    if (jobs.some((j) => j.freshness === "stale")) return "stale";
    return "fresh";
  }, [jobFreshness]);

  const value = {
    activeLens,
    setActiveLens,
    contextScope,
    updateContextScope,
    lastRefreshedAt,
    activeGrant,
    attentionCounts,
    worstFreshness,
    refresh,
    clearActiveGrant,
  };

  return <CommandCenterContext.Provider value={value}>{children}</CommandCenterContext.Provider>;
}

export function useCommandCenter() {
  const ctx = useContext(CommandCenterContext);
  if (!ctx) throw new Error("useCommandCenter must be used within a CommandCenterProvider");
  return ctx;
}
