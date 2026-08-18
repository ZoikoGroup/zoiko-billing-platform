import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { auditApi, invoiceApi, settingsApi } from "../../service/billingService";
import WorkspaceHeader from "./WorkspaceHeader";
import { formatOrgMoney } from "./workspace-format";
import {
  Activity, FileText, CreditCard, Users, Repeat, Package, Settings, Clock,
  Loader2, Filter, RefreshCw,
} from "lucide-react";

const ENTITY_ICONS = {
  invoice: FileText,
  payment: CreditCard,
  customer: Users,
  subscription: Repeat,
  product: Package,
  configuration: Settings,
  default: Activity,
};

const ENTITY_COLORS = {
  invoice: "#7C3AED",
  payment: "#0891B2",
  customer: "#059669",
  subscription: "#2563EB",
  product: "#D97706",
  configuration: "#64748B",
  default: "#64748B",
};

function normalizeEntry(raw) {
  return {
    id: raw.id,
    timestamp: raw.timestamp || raw.created_at || raw.date,
    action: raw.action || raw.event_type || "activity",
    description: raw.description || raw.message || raw.reason || "",
    entityType: raw.entity_type || "unknown",
    entityId: raw.entity_id || raw.invoice_id,
    invoiceNumber: raw.invoice_number,
    amount: raw.total_amount || raw.amount,
  };
}

function dayLabel(dateStr) {
  if (!dateStr) return "Earlier";
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const entry = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = today - entry;
  if (diff < 86400000) return "Today";
  if (diff < 172800000) return "Yesterday";
  return "Earlier";
}

function isSameDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

export default function WorkspaceActivityPage() {
  const navigate = useNavigate();
  const [auditLogs, setAuditLogs] = useState([]);
  const [invoiceActivity, setInvoiceActivity] = useState([]);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [a, ia, c] = await Promise.allSettled([
        auditApi.list({ page: 1, per_page: 60 }),
        invoiceApi.getRecentActivity(20),
        settingsApi.getConfig(),
      ]);
      if (a.status === "fulfilled") setAuditLogs(a.value?.items || []);
      if (ia.status === "fulfilled") setInvoiceActivity(Array.isArray(ia.value) ? ia.value : []);
      if (c.status === "fulfilled") setConfig(c.value);
    } catch (err) {
      setError(err?.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const timeline = useMemo(() => {
    const merged = [
      ...auditLogs.map(normalizeEntry),
      ...invoiceActivity.map(normalizeEntry),
    ].filter((e) => e.timestamp);
    merged.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const seen = new Set();
    return merged.filter((e) => {
      const key = `${e.entityType}-${e.entityId}-${e.action}-${e.timestamp}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [auditLogs, invoiceActivity]);

  const filtered = useMemo(() => {
    if (filter === "all") return timeline;
    return timeline.filter((e) => e.entityType === filter);
  }, [timeline, filter]);

  const grouped = useMemo(() => {
    const groups = [];
    let currentDay = null;
    filtered.forEach((entry) => {
      if (!currentDay || !isSameDay(currentDay.date, entry.timestamp)) {
        currentDay = { date: entry.timestamp, label: dayLabel(entry.timestamp), items: [] };
        groups.push(currentDay);
      }
      currentDay.items.push(entry);
    });
    return groups;
  }, [filtered]);

  const counts = useMemo(() => {
    const m = { all: timeline.length };
    timeline.forEach((e) => { m[e.entityType] = (m[e.entityType] || 0) + 1; });
    return m;
  }, [timeline]);

  const filters = ["all", "invoice", "payment", "customer", "subscription", "product", "configuration"];

  if (loading) {
    return (
      <div className="p-4 sm:p-6 lg:p-8" style={{ background: "#ffffff", minHeight: "calc(100vh - 4rem)" }}>
        <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-brand" /></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 sm:p-6 lg:p-8" style={{ background: "#ffffff", minHeight: "calc(100vh - 4rem)" }}>
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8" style={{ background: "#ffffff", minHeight: "calc(100vh - 4rem)" }}>
      <WorkspaceHeader
        title="Activity Timeline"
        subtitle="Recent billing activity across your organization"
        icon={Activity}
        actions={
          <button
            onClick={load}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-slate-50 border border-slate-200 hover:bg-slate-100 text-slate-700 text-xs font-medium transition-colors cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        }
      />

      <div className="flex items-center gap-2 mb-6 flex-wrap">
        <Filter className="w-4 h-4 text-slate-400" />
        {filters.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full text-[12px] font-medium border transition-colors cursor-pointer ${
              filter === f
                ? "border-brand bg-brand text-white"
                : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
            }`}
          >
            {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
            {counts[f] ? ` (${counts[f]})` : ""}
          </button>
        ))}
      </div>

      {grouped.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-slate-200 bg-white p-10 text-center">
          <div className="w-16 h-16 rounded-full bg-slate-50 flex items-center justify-center mx-auto mb-4">
            <Activity className="w-8 h-8 text-slate-300" />
          </div>
          <h3 className="text-lg font-bold text-slate-800 mb-2">No Recent Activity</h3>
          <p className="text-[13px] text-slate-500">Activity will appear here as you create invoices, process payments, and manage customers.</p>
        </div>
      ) : (
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
          <div className="space-y-8">
            {grouped.map((group, gi) => (
              <div key={gi}>
                <div className="flex items-center gap-3 mb-4">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 whitespace-nowrap">{group.label}</h3>
                  <div className="h-px flex-1 bg-slate-100" />
                  <span className="text-[11px] text-slate-400">{group.items.length}</span>
                </div>
                <div className="space-y-4">
                  {group.items.map((item) => {
                    const Icon = ENTITY_ICONS[item.entityType] || ENTITY_ICONS.default;
                    const color = ENTITY_COLORS[item.entityType] || ENTITY_COLORS.default;
                    return (
                      <div key={item.id} className="flex items-start gap-3 pb-4 border-b border-slate-100 last:border-0 last:pb-0">
                        <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${color}15`, color }}>
                          <Icon className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-semibold text-slate-800">{item.action}</span>
                            <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{item.entityType}</span>
                          </div>
                          {item.description && <p className="text-[12px] mt-0.5 truncate text-slate-500">{item.description}</p>}
                          <div className="flex items-center gap-3 mt-1 text-[11px] text-slate-400">
                            <span>{item.timestamp ? new Date(item.timestamp).toLocaleString() : ""}</span>
                            {item.entityId && <span className="font-mono">#{item.entityId}</span>}
                            {item.amount != null && <span className="font-semibold text-slate-600">{formatOrgMoney(item.amount, config)}</span>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
