import { useCallback, useEffect, useState } from "react";
import { getBillingKillSwitch } from "../service/commercialService";
import { useCommandCenter } from "../context/CommandCenterContext";
import usePolling from "./usePolling";

const POLL_INTERVAL_MS = 60000;

// Feeds the pinned cockpit strip so nav items don't each fire their own
// request. The triage summary is NOT fetched here: CommandCenterContext
// already fetches it once per cycle (and exposes it as triageSummary), so
// this hook only polls the kill switch. A failing fetch keeps its last known
// value (or null on first load) and logs to the console.
export default function useCockpitStatus(enabled) {
  const shell = useCommandCenter({ required: false });
  const triageSummary = shell?.triageSummary ?? null;
  const [state, setState] = useState({
    openIncidents: null,
    killSwitchEnabled: null,
    loading: true,
    error: null,
  });

  const load = useCallback(
    () =>
      getBillingKillSwitch().then(
        (value) => {
          setState((prev) => ({
            ...prev,
            killSwitchEnabled: !!value?.enabled,
            loading: false,
            error: null,
          }));
        },
        (reason) => {
          console.error("Cockpit status: billing-kill-switch fetch failed", reason);
          setState((prev) => ({ ...prev, loading: false, error: reason ?? null }));
        }
      ),
    []
  );

  useEffect(() => {
    if (!enabled) return undefined;
    load();
    return undefined;
  }, [enabled, load]);

  usePolling(load, POLL_INTERVAL_MS, { enabled });

  const openIncidents = triageSummary?.incidents?.counts?.total_open ?? state.openIncidents;
  return { ...state, openIncidents };
}
