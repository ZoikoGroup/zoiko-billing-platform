import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

// URL-backed list filters shared by the Billing list pages that dashboard KPI
// cards link to (credit notes, contracts, subscriptions, quotations).
//
//   ?status=<value>      one of the page's status option values (a comma list
//                        such as "cancelled,expired" is allowed when the page
//                        offers it as an option). Unknown values are ignored.
//   ?expiring=<days>     only records expiring within N days (1-365); the
//                        list API's expiring_within_days filter.
//   ?all_dates=1         ignore the shared dashboard date range. KPI counts
//                        are all-time snapshots, while these lists otherwise
//                        filter by creation date (default: last 30 days), so a
//                        card link must say so explicitly -- and the page shows
//                        it as a removable chip rather than hiding records.
//
// These pages used to ignore the URL entirely, so every dashboard link to
// "?status=..." silently opened the unfiltered list. The URL is now the single
// source of truth for these filters: a refresh or a shared link reproduces the
// same view, and a user's own changes update it in place.
export function useListUrlFilters(statusValues = []) {
  const [searchParams, setSearchParams] = useSearchParams();

  const rawStatus = searchParams.get("status") || "";
  const status = rawStatus && statusValues.includes(rawStatus) ? rawStatus : "";

  const rawExpiring = Number(searchParams.get("expiring"));
  const expiringDays = Number.isInteger(rawExpiring) && rawExpiring >= 1 && rawExpiring <= 365 ? rawExpiring : null;

  const allDates = searchParams.get("all_dates") === "1";

  const update = useCallback((changes) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      Object.entries(changes).forEach(([key, value]) => {
        if (value === null || value === undefined || value === "" || value === false) next.delete(key);
        else next.set(key, String(value));
      });
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const setStatus = useCallback((value) => update({ status: value || null }), [update]);
  const setExpiringDays = useCallback((days) => update({ expiring: days || null }), [update]);
  const setAllDates = useCallback((on) => update({ all_dates: on ? "1" : null }), [update]);
  const clearUrlFilters = useCallback(() => update({ status: null, expiring: null, all_dates: null }), [update]);

  // What a KPI card on the page itself does: show exactly the records it
  // counts (all-time), replacing whatever card/URL filter was active before.
  const applyCardFilter = useCallback(({ status: nextStatus = null, expiring = null } = {}) => {
    update({ status: nextStatus || null, expiring: expiring || null, all_dates: "1" });
  }, [update]);

  return { status, setStatus, expiringDays, setExpiringDays, allDates, setAllDates, clearUrlFilters, applyCardFilter };
}

// Reports pages: ?tab=<key> opens a specific tab (KPI cards link to the tab
// that shows their metric). Unknown keys fall back to the default tab.
export function useUrlTab(tabKeys, defaultTab) {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get("tab");
  const tab = tabKeys.includes(raw) ? raw : defaultTab;
  const setTab = useCallback((key) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (key && key !== defaultTab) next.set("tab", key); else next.delete("tab");
      return next;
    }, { replace: true });
  }, [setSearchParams, defaultTab]);
  return [tab, setTab];
}

// For pages that only SEED a filter from a ?status= deep link: once the user
// picks or clears a status themselves, drop the param so a reload or shared
// link doesn't resurrect the stale deep-link filter (Clear must clear the URL).
export function useDropUrlParam() {
  const [searchParams, setSearchParams] = useSearchParams();
  return useCallback((key) => {
    if (!searchParams.has(key)) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete(key);
      return next;
    }, { replace: true });
  }, [searchParams, setSearchParams]);
}
