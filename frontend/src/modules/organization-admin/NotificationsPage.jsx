import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, FileText, ScrollText, AlertTriangle, Loader2 } from "lucide-react";
import { invoiceApi, contractApi, collectionApi } from "../../service/billingService";
import { getCurrencySymbol, getCurrencyInfo } from "../../utils/currency";
import { loadGlobalCurrency, getOrgBaseCurrency, isOrgCurrencyUnavailable } from "../billing/utils/CurrencyContext";

// Same real, org-scoped billing signals as the billing_admin workspace
// notifications page (invoiceApi.listOverdue, contractApi.listExpiring,
// collectionApi.getAgingBuckets) — org_admin holds the same organization_id
// and these endpoints authorize on that alone (get_current_user), so this
// is the identical real feed, not a fabricated one built for this role.
export default function OrgAdminNotificationsPage() {
  const navigate = useNavigate();
  const [overdueInvoices, setOverdueInvoices] = useState([]);
  const [expiringContracts, setExpiringContracts] = useState([]);
  const [agingBuckets, setAgingBuckets] = useState([]);
  const [currency, setCurrency] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [ov, exp, aging] = await Promise.allSettled([
          invoiceApi.listOverdue(),
          contractApi.listExpiring(30),
          collectionApi.getAgingBuckets(),
        ]);
        await loadGlobalCurrency().catch(() => {});
        if (cancelled) return;
        if (ov.status === "fulfilled") setOverdueInvoices(Array.isArray(ov.value) ? ov.value : ov.value?.items || []);
        if (exp.status === "fulfilled") setExpiringContracts(Array.isArray(exp.value) ? exp.value : exp.value?.items || []);
        if (aging.status === "fulfilled") setAgingBuckets(Array.isArray(aging.value?.buckets) ? aging.value.buckets : []);
        setCurrency(getOrgBaseCurrency() || "");
      } catch (err) {
        if (!cancelled) setError(err?.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const formatMoney = (amount) => {
    if (amount == null) return "—";
    if (!currency) return isOrgCurrencyUnavailable() ? "Currency not configured" : "—";
    const num = Number(amount);
    if (Number.isNaN(num)) return "—";
    const info = getCurrencyInfo(currency);
    const symbol = getCurrencySymbol(currency);
    const precision = typeof info?.decimalDigits === "number" ? info.decimalDigits : 2;
    return `${symbol}${num.toLocaleString("en-US", { minimumFractionDigits: precision, maximumFractionDigits: precision })}`;
  };

  const agingAlerts = useMemo(
    () => agingBuckets.filter((b) => !/^0[-–]30/.test(b.bucket || "") && Number(b.count) > 0),
    [agingBuckets]
  );

  const hasNotifications = overdueInvoices.length > 0 || expiringContracts.length > 0 || agingAlerts.length > 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-brand" />
      </div>
    );
  }

  if (error) {
    return <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>;
  }

  return (
    <div>
      <div className="mb-5 flex items-center gap-3 pb-4" style={{ borderBottom: "1px solid #E5E7EB" }}>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand">
          <Bell className="h-5 w-5" />
        </div>
        <div>
          <p className="text-lg font-extrabold text-slate-900">Notifications</p>
          <p className="text-xs font-medium text-slate-500">Billing alerts for your organization</p>
        </div>
      </div>

      {!hasNotifications ? (
        <div className="rounded-3xl border border-dashed border-slate-200 bg-white p-10 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-slate-50">
            <Bell className="h-8 w-8 text-slate-300" />
          </div>
          <h3 className="mb-2 text-lg font-bold text-slate-800">No Notifications</h3>
          <p className="mx-auto max-w-md text-[13px] text-slate-500">
            You're all caught up. No overdue invoices, expiring contracts, or aging collections right now.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {overdueInvoices.map((inv) => (
            <div
              key={`inv-${inv.id}`}
              onClick={() => navigate(`/billing/invoices/${inv.id}`)}
              className="flex items-start gap-3 rounded-3xl border border-slate-200 bg-white p-4 transition-shadow hover:shadow-[0_4px_20px_rgba(0,0,0,0.03)] cursor-pointer"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600">
                <FileText className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-slate-800">
                  Invoice {inv.invoice_number || `INV-${inv.id}`} is overdue
                </p>
                <p className="mt-0.5 text-[12px] text-slate-500">
                  {formatMoney(inv.balance_due ?? inv.total_amount)} outstanding
                  {inv.due_date && ` · due ${new Date(inv.due_date).toLocaleDateString()}`}
                  {inv.customer_name && ` · ${inv.customer_name}`}
                </p>
              </div>
            </div>
          ))}

          {expiringContracts.map((c) => (
            <div
              key={`contract-${c.id}`}
              onClick={() => navigate(`/billing/contracts/${c.id}`)}
              className="flex items-start gap-3 rounded-3xl border border-slate-200 bg-white p-4 transition-shadow hover:shadow-[0_4px_20px_rgba(0,0,0,0.03)] cursor-pointer"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600">
                <ScrollText className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-slate-800">
                  Contract {c.contract_number || `#${c.id}`} is expiring
                </p>
                <p className="mt-0.5 text-[12px] text-slate-500">
                  {c.end_date && `Ends ${new Date(c.end_date).toLocaleDateString()}`}
                  {c.customer_name && ` · ${c.customer_name}`}
                </p>
              </div>
            </div>
          ))}

          {agingAlerts.map((b) => (
            <div
              key={`aging-${b.bucket}`}
              onClick={() => navigate("/billing/collections-receivables")}
              className="flex items-start gap-3 rounded-3xl border border-slate-200 bg-white p-4 transition-shadow hover:shadow-[0_4px_20px_rgba(0,0,0,0.03)] cursor-pointer"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600">
                <AlertTriangle className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-slate-800">
                  {b.count} invoice{b.count === 1 ? "" : "s"} {b.bucket} overdue
                </p>
                <p className="mt-0.5 text-[12px] text-slate-500">
                  {formatMoney(b.total_amount)} total outstanding in this range
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
