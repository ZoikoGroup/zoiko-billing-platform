import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "./AuthContext";
import { canReadReliabilityTelemetry } from "../config/roles";
import { getActivePrivilegedAccess, getJobTelemetry } from "../service/privilegedAccessService";
import { getAttentionCounts, getConfigurationInventory, getTriageSummary } from "../service/commandCenterService";
import usePolling from "../hooks/usePolling";
import { setExportSuppressed } from "../utils/export-helpers";

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

// Shell strip / context poll. Raised from 20 s to 60 s: nothing in the product
// needs sub-minute freshness here (the strip is an ambient indicator and every
// heavy surface already polls at 60 s). usePolling pauses while the tab is hidden.
const POLL_INTERVAL_MS = 60000;
// An automatic (poll-driven) refresh is skipped if the shell refreshed this
// recently, so the shell poller and per-page pollers never double-fetch.
const AUTO_REFRESH_DEDUPE_MS = 5000;

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
  // Bumped by every explicit refresh so mounted surfaces (dashboard lenses,
  // footer strips) reload their own queries in lockstep with the shell strip.
  const [refreshTick, setRefreshTick] = useState(0);
  const [triageSummary, setTriageSummary] = useState(null);
  const lastRefreshRef = useRef(0);

  const updateContextScope = useCallback((field, value) => {
    setContextScope((prev) => ({ ...prev, [field]: value }));
  }, []);

  const refresh = useCallback((opts) => {
    if (!isSuperAdmin) return;
    const now = Date.now();
    if (opts && opts.auto === true && now - lastRefreshRef.current < AUTO_REFRESH_DEDUPE_MS) return;
    lastRefreshRef.current = now;
    setLastRefreshedAt(new Date());
    getActivePrivilegedAccess()
      .then((grant) => setActiveGrant(grant && grant.status === "active" ? grant : null))
      .catch(() => setActiveGrant(null));
    getAttentionCounts()
      .then(setAttentionCounts)
      .catch(() => setAttentionCounts(null));
    // Single shared triage fetch per cycle: the cockpit strip reads this
    // instead of polling the endpoint itself (getTriageSummary de-dupes
    // concurrent callers such as the Hub / Platform dashboard pages).
    getTriageSummary()
      .then(setTriageSummary)
      .catch(() => {});
    if (canReadJobs) {
      getJobTelemetry()
        .then(setJobFreshness)
        .catch(() => setJobFreshness(null));
    }
  }, [isSuperAdmin, canReadJobs]);

  // Explicit operator action (Refresh button, poll-driven dashboard reload):
  // refreshes the shell strip AND signals heavy surfaces to reload.
  const requestRefresh = useCallback((opts) => {
    refresh(opts);
    setRefreshTick((t) => t + 1);
  }, [refresh]);

  useEffect(() => {
    if (!isSuperAdmin) {
      setActiveGrant(null);
      setAttentionCounts(null);
      setJobFreshness(null);
      setTriageSummary(null);
      return;
    }
    refresh();
  }, [isSuperAdmin, refresh]);

  usePolling(() => refresh({ auto: true }), POLL_INTERVAL_MS, { enabled: isSuperAdmin });

  const clearActiveGrant = useCallback(() => setActiveGrant(null), []);

  // §21 — authoritative environment identity. Fetched ONCE from the
  // configuration inventory (the backend derives it from the DEBUG flag).
  // If the caller lacks platform_config.read the fetch fails and the badge
  // degrades to an explicit UNVERIFIED state — it never silently claims a
  // production identity it cannot prove.
  const [environmentVerified, setEnvironmentVerified] = useState(false);
  const envLoadedRef = useRef(false);
  useEffect(() => {
    if (!isSuperAdmin || envLoadedRef.current) return;
    envLoadedRef.current = true;
    getConfigurationInventory()
      .then((inv) => {
        if (inv && inv.environment) {
          setContextScope((prev) => ({ ...prev, environment: inv.environment }));
          setEnvironmentVerified(true);
        }
      })
      .catch(() => setEnvironmentVerified(false));
  }, [isSuperAdmin]);

  // Domain B containment (§17): while a privileged tenant-access session is
  // active, suppress ALL shared export paths app-wide. Clearing the grant
  // (exit/expiry/role loss) restores them.
  useEffect(() => {
    setExportSuppressed(
      activeGrant
        ? "a privileged TENANT CONTEXT session is active (Domain B containment)"
        : null
    );
    return () => setExportSuppressed(null);
  }, [activeGrant]);

  // §10.2 freshness rollup — the WORST state across all tracked jobs.
  const worstFreshness = useMemo(() => {
    if (!jobFreshness || !jobFreshness.scheduler_enabled) return null;
    const jobs = jobFreshness.jobs || [];
    if (jobs.length === 0) return "unknown";
    if (jobs.some((j) => j.freshness === "unknown")) return "unknown";
    if (jobs.some((j) => j.freshness === "stale")) return "stale";
    return "fresh";
  }, [jobFreshness]);

  // Inclusive lower day-bound for period-windowed queries (audit feeds).
  // Returns a YYYY-MM-DD string consumable by date_from query params.
  const periodDateFrom = useMemo(() => {
    const now = new Date();
    let start;
    switch (contextScope.period) {
      case "Last 7 Days":
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
        break;
      case "Month to Date":
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case "Quarter to Date":
        start = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
        break;
      case "Last 30 Days":
      default:
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
        break;
    }
    return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
  }, [contextScope.period]);

  const value = {
    activeLens,
    setActiveLens,
    contextScope,
    updateContextScope,
    lastRefreshedAt,
    activeGrant,
    attentionCounts,
    triageSummary,
    worstFreshness,
    environmentVerified,
    refresh,
    requestRefresh,
    refreshTick,
    periodDateFrom,
    clearActiveGrant,
  };

  return <CommandCenterContext.Provider value={value}>{children}</CommandCenterContext.Provider>;
}

export function useCommandCenter({ required = true } = {}) {
  const ctx = useContext(CommandCenterContext);
  if (!ctx && required) throw new Error("useCommandCenter must be used within a CommandCenterProvider");
  return ctx;
}
