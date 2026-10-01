import { useCallback, useEffect, useState } from "react";
import { getTriageSummary } from "../service/commandCenterService";
import { getBillingKillSwitch } from "../service/commercialService";

const POLL_INTERVAL_MS = 60000;

// One poll cycle, two existing read-only endpoints — feeds the pinned
// cockpit strip so nav items don't each fire their own request. A single
// badge's fetch failing never blocks the others; it just keeps its last
// known value (or null on first load) and logs to the console.
export default function useCockpitStatus(enabled) {
  const [state, setState] = useState({
    openIncidents: null,
    killSwitchEnabled: null,
    loading: true,
    error: null,
  });

  const load = useCallback(() => {
    Promise.allSettled([getTriageSummary(), getBillingKillSwitch()]).then(
      ([triageResult, killResult]) => {
        [
          ["triage-summary", triageResult],
          ["billing-kill-switch", killResult],
        ].forEach(([name, result]) => {
          if (result.status === "rejected") {
            console.error(`Cockpit status: ${name} fetch failed`, result.reason);
          }
        });

        setState((prev) => ({
          openIncidents:
            triageResult.status === "fulfilled"
              ? triageResult.value?.incidents?.counts?.total_open ?? null
              : prev.openIncidents,
          killSwitchEnabled:
            killResult.status === "fulfilled" ? !!killResult.value?.enabled : prev.killSwitchEnabled,
          loading: false,
          error: [triageResult, killResult].find((r) => r.status === "rejected")?.reason ?? null,
        }));
      }
    );
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, load]);

  return state;
}
