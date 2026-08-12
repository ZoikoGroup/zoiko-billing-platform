import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { settingsApi } from "../../../service/billingService";
import { getCurrencyInfo } from "../../../utils/currency";

const DEFAULT_CURRENCY = "USD";

const CurrencyContext = createContext(null);

let globalCurrency = null;
let globalPromise = null;
const listeners = new Set();

function notifyListeners() {
  listeners.forEach((fn) => fn(globalCurrency));
}

export function loadGlobalCurrency() {
  if (globalCurrency) return Promise.resolve(globalCurrency);
  if (globalPromise) return globalPromise;
  globalPromise = (async () => {
    try {
      const data = await settingsApi.getConfig();
      globalCurrency = data?.base_currency || data?.default_currency || data?.home_currency || DEFAULT_CURRENCY;
    } catch {
      globalCurrency = DEFAULT_CURRENCY;
    }
    notifyListeners();
    return globalCurrency;
  })();
  return globalPromise;
}

export function getOrgBaseCurrency() {
  return globalCurrency || DEFAULT_CURRENCY;
}

export function resolveCurrency({ invoiceCurrency, customerCurrency } = {}) {
  return invoiceCurrency || customerCurrency || globalCurrency || DEFAULT_CURRENCY;
}

export function useCurrency() {
  const ctx = useContext(CurrencyContext);
  const [localCurrency, setLocalCurrency] = useState(globalCurrency || DEFAULT_CURRENCY);
  const [loading, setLoading] = useState(!globalCurrency);

  useEffect(() => {
    if (globalCurrency) {
      setLocalCurrency(globalCurrency);
      setLoading(false);
      return;
    }
    const handler = (currency) => {
      setLocalCurrency(currency);
      setLoading(false);
    };
    listeners.add(handler);
    loadGlobalCurrency().then((currency) => {
      setLocalCurrency(currency);
      setLoading(false);
    }).catch(() => setLoading(false));
    return () => { listeners.delete(handler); };
  }, []);

  const currency = ctx?.baseCurrency || localCurrency;
  const currencyInfo = getCurrencyInfo(currency);
  const currencySymbol = currencyInfo?.symbol || (ctx?.currencySymbol || "$");

  const formatCurrency = useCallback((v, fallback = "\u2014") => {
    if (v == null || v === "") return fallback;
    const num = Number(v);
    if (Number.isNaN(num)) return fallback;
    const info = getCurrencyInfo(currency);
    const precision = typeof info?.decimalDigits === "number" ? info.decimalDigits : 2;
    const sym = info?.symbol || "$";
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

  return { baseCurrency: currency, currencySymbol, currencyInfo, loading, formatCurrency, formatCompact };
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
  const currencySymbol = currencyInfo?.symbol || "$";

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
