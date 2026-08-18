import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { invoiceApi, contractApi, collectionApi, settingsApi } from "../../service/billingService";
import WorkspaceHeader from "./WorkspaceHeader";
import { formatOrgMoney } from "./workspace-format";
import { Bell, FileText, CreditCard, Repeat, Clock, Activity, AlertTriangle, ScrollText, Loader2 } from "lucide-react";

const INK = "#181433";
const INK_SOFT = "#4A4566";
const LINE = "rgba(24,20,51,0.08)";
const RED = "#D6473C";
const RED_100 = "#FBE6E4";
const AMBER = "#F5A340";
const AMBER_100 = "#FDECD6";

const PREVIEW_CARDS = [
  {
    title: "Subscription Renewals",
    description: "Get notified when subscriptions are due for renewal",
    icon: Repeat,
    color: "#7C3AED",
    path: "/billing/subscriptions",
  },
  {
    title: "Overdue Invoices",
    description: "Alerts for invoices that have passed their due date",
    icon: FileText,
    color: "#D6473C",
    path: "/billing/invoices",
  },
  {
    title: "Payment Events",
    description: "Notifications for successful and failed payments",
    icon: CreditCard,
    color: "#0F9B8E",
    path: "/billing/payments",
  },
];

// Real, org-scoped billing signals only — never a fabricated event.
// Sources: GET /billing/invoices/overdue, GET /billing/contracts/expiring,
// GET /billing/collections/aging (all already used elsewhere in the app).
export default function WorkspaceNotificationsPage() {
  const navigate = useNavigate();
  const [overdueInvoices, setOverdueInvoices] = useState([]);
  const [expiringContracts, setExpiringContracts] = useState([]);
  const [agingBuckets, setAgingBuckets] = useState([]);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [ov, exp, aging, cfg] = await Promise.allSettled([
          invoiceApi.listOverdue(),
          contractApi.listExpiring(30),
          collectionApi.getAgingBuckets(),
          settingsApi.getConfig(),
        ]);
        if (cancelled) return;
        if (ov.status === "fulfilled") setOverdueInvoices(Array.isArray(ov.value) ? ov.value : ov.value?.items || []);
        if (exp.status === "fulfilled") setExpiringContracts(Array.isArray(exp.value) ? exp.value : exp.value?.items || []);
        if (aging.status === "fulfilled") setAgingBuckets(Array.isArray(aging.value?.buckets) ? aging.value.buckets : []);
        if (cfg.status === "fulfilled") setConfig(cfg.value);
      } catch (err) {
        if (!cancelled) setError(err?.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const agingAlerts = useMemo(
    () => agingBuckets.filter((b) => !/^0[-–]30/.test(b.bucket || "") && Number(b.count) > 0),
    [agingBuckets]
  );

  const hasNotifications = overdueInvoices.length > 0 || expiringContracts.length > 0 || agingAlerts.length > 0;

  if (loading) {
    return (
      <div className="p-4 sm:p-6 lg:p-8" style={{ background: "#F8F7F4", minHeight: "calc(100vh - 4rem)" }}>
        <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-purple-600" /></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 sm:p-6 lg:p-8" style={{ background: "#F8F7F4", minHeight: "calc(100vh - 4rem)" }}>
        <div className="rounded-[14px] border p-4 text-sm" style={{ background: RED_100, borderColor: RED, color: RED }}>{error}</div>
      </div>
    );
  }

  return (
    <div className="font-['Inter',system-ui,sans-serif] p-4 sm:p-6 lg:p-8" style={{ background: "#F8F7F4", color: INK, minHeight: "calc(100vh - 4rem)" }}>
      <WorkspaceHeader title="Notifications" subtitle="Billing alerts and notifications" icon={Bell} />

      {!hasNotifications ? (
        <div className="rounded-[20px] border bg-white p-10 text-center shadow-[0_1px_2px_rgba(24,20,51,0.04),0_8px_24px_-12px_rgba(24,20,51,0.10)]">
          <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
            <Bell className="w-8 h-8 text-gray-400" />
          </div>
          <h3 className="text-lg font-bold mb-2" style={{ color: INK }}>No Notifications</h3>
          <p className="text-[13px] mb-6 max-w-md mx-auto" style={{ color: INK_SOFT }}>
            You're all caught up. No overdue invoices, expiring contracts, or aging collections right now.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl mx-auto">
            {PREVIEW_CARDS.map((card) => {
              const Icon = card.icon;
              return (
                <button
                  key={card.path}
                  onClick={() => navigate(card.path)}
                  className="p-4 rounded-[14px] border text-left hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer"
                  style={{ borderColor: LINE }}
                >
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center mb-3" style={{ background: `${card.color}15`, color: card.color }}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <p className="text-[13px] font-semibold mb-1" style={{ color: INK }}>{card.title}</p>
                  <p className="text-[11px]" style={{ color: INK_SOFT }}>{card.description}</p>
                </button>
              );
            })}
          </div>

          <button
            onClick={() => navigate("/billing/workspace/activity")}
            className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold text-purple-600 bg-purple-50 hover:bg-purple-100 transition-colors cursor-pointer"
          >
            <Activity className="w-4 h-4" />
            View Activity Timeline
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {overdueInvoices.map((inv) => (
            <div
              key={`inv-${inv.id}`}
              onClick={() => navigate(`/billing/invoices/${inv.id}`)}
              className="flex items-start gap-3 p-4 rounded-[14px] border bg-white hover:shadow-sm transition-shadow cursor-pointer"
              style={{ borderColor: LINE }}
            >
              <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: RED_100, color: RED }}>
                <FileText className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold" style={{ color: INK }}>
                  Invoice {inv.invoice_number || `INV-${inv.id}`} is overdue
                </p>
                <p className="text-[12px] mt-0.5" style={{ color: INK_SOFT }}>
                  {formatOrgMoney(inv.balance_due ?? inv.total_amount, config)} outstanding
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
              className="flex items-start gap-3 p-4 rounded-[14px] border bg-white hover:shadow-sm transition-shadow cursor-pointer"
              style={{ borderColor: LINE }}
            >
              <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: AMBER_100, color: AMBER }}>
                <ScrollText className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold" style={{ color: INK }}>
                  Contract {c.contract_number || `#${c.id}`} is expiring
                </p>
                <p className="text-[12px] mt-0.5" style={{ color: INK_SOFT }}>
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
              className="flex items-start gap-3 p-4 rounded-[14px] border bg-white hover:shadow-sm transition-shadow cursor-pointer"
              style={{ borderColor: LINE }}
            >
              <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: RED_100, color: RED }}>
                <AlertTriangle className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold" style={{ color: INK }}>
                  {b.count} invoice{b.count === 1 ? "" : "s"} {b.bucket} overdue
                </p>
                <p className="text-[12px] mt-0.5" style={{ color: INK_SOFT }}>
                  {formatOrgMoney(b.total_amount, config)} total outstanding in this range
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
