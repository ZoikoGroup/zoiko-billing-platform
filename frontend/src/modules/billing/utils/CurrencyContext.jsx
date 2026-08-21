import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { settingsApi } from "../../../service/billingService";
import { getCurrencyInfo } from "../../../utils/currency";

const DEFAULT_CURRENCY = "";

const CurrencyContext = createContext(null);

let globalCurrency = null;
let globalCurrencyUnavailable = false;
let globalPromise = null;
const listeners = new Set();

function notifyListeners() {
  listeners.forEach((fn) => fn(globalCurrency, globalCurrencyUnavailable));
}

export function loadGlobalCurrency() {
  if (globalCurrency) return Promise.resolve(globalCurrency);
  if (globalPromise) return globalPromise;
  globalPromise = (async () => {
    try {
      const data = await settingsApi.getConfig();
      const resolved = data?.base_currency || data?.default_currency || data?.home_currency || null;
      if (resolved) {
        globalCurrency = resolved;
        globalCurrencyUnavailable = false;
      } else {
        // Config loaded but no currency was ever configured -- distinct
        // from a network/auth failure (below): don't cache a currency at
        // all, so a later fix to org config resolves immediately on next
        // use instead of being masked by a permanently-cached fallback.
        globalCurrencyUnavailable = true;
      }
    } catch {
      // Previously this cached DEFAULT_CURRENCY here and `if (globalCurrency)`
      // above meant that fake "USD" was treated as a real resolved value
      // for the rest of the session -- a transient network/auth error on
      // the very first config fetch would silently make the entire app
      // believe the org's currency was USD, forever, even once the request
      // would have succeeded. Leaving globalCurrency unset (and clearing
      // globalPromise) lets the next caller retry for a real value instead.
      globalCurrencyUnavailable = true;
      globalPromise = null;
    }
    notifyListeners();
    return globalCurrency;
  })();
  return globalPromise;
}

export function getOrgBaseCurrency() {
  return globalCurrency || DEFAULT_CURRENCY;
}

// True once a load attempt has completed without resolving a real
// organization currency (config unreachable, or genuinely unconfigured).
// Callers that want to surface "Currency not configured" instead of a
// silent "$"/"USD" can check this instead of trusting getOrgBaseCurrency()
// blindly.
export function isOrgCurrencyUnavailable() {
  return globalCurrencyUnavailable && !globalCurrency;
}

export function resolveCurrency({ invoiceCurrency, customerCurrency } = {}) {
  return invoiceCurrency || customerCurrency || globalCurrency || DEFAULT_CURRENCY;
}

export function useCurrency() {
  const ctx = useContext(CurrencyContext);
  const [localCurrency, setLocalCurrency] = useState(globalCurrency || DEFAULT_CURRENCY);
  const [loading, setLoading] = useState(!globalCurrency);
  const [currencyUnavailable, setCurrencyUnavailable] = useState(isOrgCurrencyUnavailable());

  useEffect(() => {
    if (globalCurrency) {
      setLocalCurrency(globalCurrency);
      setLoading(false);
      return;
    }
    const handler = (currency, unavailable) => {
      setLocalCurrency(currency || DEFAULT_CURRENCY);
      setCurrencyUnavailable(!!unavailable && !currency);
      setLoading(false);
    };
    listeners.add(handler);
    loadGlobalCurrency().then((currency) => {
      setLocalCurrency(currency || DEFAULT_CURRENCY);
      setCurrencyUnavailable(isOrgCurrencyUnavailable());
      setLoading(false);
    }).catch(() => setLoading(false));
    return () => { listeners.delete(handler); };
  }, []);

  const currency = ctx?.baseCurrency || localCurrency;
  const currencyInfo = getCurrencyInfo(currency);
  const currencySymbol = currencyInfo?.symbol || (ctx?.currencySymbol || "");

  const formatCurrency = useCallback((v, fallback = "\u2014") => {
    if (v == null || v === "") return fallback;
    const num = Number(v);
    if (Number.isNaN(num)) return fallback;
    const info = getCurrencyInfo(currency);
    const precision = typeof info?.decimalDigits === "number" ? info.decimalDigits : 2;
    const sym = info?.symbol || "";
    return `${sym}${num.toLocaleString("en-US", { minimumFractionDigits: precision, maximumFractionDigits: precision })}`;
  }, [currency]);

  const formatCompact = useCallback((v) => {
    if (v === null || v === undefined) return `${currencySymbol}0`;
    const num = typeof v === "string" ? parseFloat(v) : v;
    if (isNaN(num)) return `${currencySymbol}0`;
    if (num >= 1e9) return `${currencySymbol}${(num / 1e9).toFixed(1)}B`;
    if (num >= 1e6) return `${currencySymbol}${(num / 1e6).toFixed(1)}M`;
    if (num >= 1e3) return `${currencySymbol}${(num / 1e3).toFixed(1)}K`;
    return `${currencySymbol}${num.toFixed(0)}`;
  }, [currencySymbol]);

  return { baseCurrency: currency, currencySymbol, currencyInfo, loading, currencyUnavailable, formatCurrency, formatCompact };
}

export function CurrencyProvider({ children }) {
  const [baseCurrency, setBaseCurrency] = useState(globalCurrency || DEFAULT_CURRENCY);
  const [loading, setLoading] = useState(!globalCurrency);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (globalCurrency) {
      setBaseCurrency(globalCurrency);
      setLoading(false);
      return;
    }
    loadGlobalCurrency().then((currency) => {
      if (mountedRef.current) {
        setBaseCurrency(currency);
        setLoading(false);
      }
    }).catch(() => {
      if (mountedRef.current) setLoading(false);
    });
    return () => { mountedRef.current = false; };
  }, []);

  const currencyInfo = getCurrencyInfo(baseCurrency);
  const currencySymbol = currencyInfo?.symbol || "";

  const formatCurrency = useCallback((v, fallback = "\u2014") => {
    if (v == null || v === "") return fallback;
    const num = Number(v);
    if (Number.isNaN(num)) return fallback;
    const info = getCurrencyInfo(baseCurrency);
    const precision = typeof info?.decimalDigits === "number" ? info.decimalDigits : 2;
    return `${currencySymbol}${num.toLocaleString("en-US", { minimumFractionDigits: precision, maximumFractionDigits: precision })}`;
  }, [baseCurrency, currencySymbol]);

  const formatCompact = useCallback((v) => {
    if (v === null || v === undefined) return `${currencySymbol}0`;
    const num = typeof v === "string" ? parseFloat(v) : v;
    if (isNaN(num)) return `${currencySymbol}0`;
    if (num >= 1e9) return `${currencySymbol}${(num / 1e9).toFixed(1)}B`;
    if (num >= 1e6) return `${currencySymbol}${(num / 1e6).toFixed(1)}M`;
    if (num >= 1e3) return `${currencySymbol}${(num / 1e3).toFixed(1)}K`;
    return `${currencySymbol}${num.toFixed(0)}`;
  }, [currencySymbol]);

  return (
    <CurrencyContext.Provider value={{ baseCurrency, currencySymbol, currencyInfo, loading, formatCurrency, formatCompact }}>
      {children}
    </CurrencyContext.Provider>
  );
}

export { CurrencyContext, DEFAULT_CURRENCY };
