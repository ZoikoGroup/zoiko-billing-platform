import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { auditApi, invoiceApi, settingsApi } from "../../service/billingService";
import WorkspaceHeader from "./WorkspaceHeader";
import { formatOrgMoney } from "./workspace-format";
import {
  Activity, FileText, CreditCard, Users, Repeat, Package, Settings, Clock,
  Loader2, Filter,
} from "lucide-react";

const INK = "#181433";
const INK_SOFT = "#4A4566";
const LINE = "rgba(24,20,51,0.08)";
const RED_100 = "#FBE6E4";
const RED = "#D6473C";
const VIOLET = "#5B3FE0";

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
  invoice: "#F5A340",
  payment: "#0F9B8E",
  customer: "#5B3FE0",
  subscription: "#7C3AED",
  product: "#0F9B8E",
  configuration: "#6B7280",
  default: "#5B3FE0",
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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [a, ia, c] = await Promise.allSettled([
          auditApi.list({ page: 1, per_page: 60 }),
          invoiceApi.getRecentActivity(20),
          settingsApi.getConfig(),
        ]);
        if (cancelled) return;
        if (a.status === "fulfilled") setAuditLogs(a.value?.items || []);
        if (ia.status === "fulfilled") setInvoiceActivity(Array.isArray(ia.value) ? ia.value : []);
        if (c.status === "fulfilled") setConfig(c.value);
      } catch (err) {
        if (!cancelled) setError(err?.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

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
      <WorkspaceHeader title="Activity Timeline" subtitle="Recent billing activity across your organization" icon={Activity} />

      <div className="flex items-center gap-2 mb-6 flex-wrap">
        <Filter className="w-4 h-4" style={{ color: INK_SOFT }} />
        {filters.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full text-[12px] font-medium border transition-colors cursor-pointer ${
              filter === f
                ? "bg-purple-600 text-white border-purple-600"
                : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
            }`}
          >
            {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
            {counts[f] ? ` (${counts[f]})` : ""}
          </button>
        ))}
      </div>

      {grouped.length === 0 ? (
        <div className="rounded-[20px] border bg-white p-10 text-center shadow-[0_1px_2px_rgba(24,20,51,0.04),0_8px_24px_-12px_rgba(24,20,51,0.10)]">
          <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
            <Activity className="w-8 h-8 text-gray-400" />
          </div>
          <h3 className="text-lg font-bold mb-2" style={{ color: INK }}>No Recent Activity</h3>
          <p className="text-[13px]" style={{ color: INK_SOFT }}>Activity will appear here as you create invoices, process payments, and manage customers.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map((group, gi) => (
            <div key={gi}>
              <div className="flex items-center gap-2 mb-3">
                <Clock className="w-3.5 h-3.5" style={{ color: INK_SOFT }} />
                <h3 className="text-[12px] font-bold uppercase tracking-[0.06em]" style={{ color: INK_SOFT }}>{group.label}</h3>
              </div>
              <div className="space-y-2">
                {group.items.map((item) => {
                  const Icon = ENTITY_ICONS[item.entityType] || ENTITY_ICONS.default;
                  const color = ENTITY_COLORS[item.entityType] || ENTITY_COLORS.default;
                  return (
                    <div key={item.id} className="flex items-start gap-3 p-4 rounded-[14px] border bg-white hover:shadow-sm transition-shadow">
                      <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${color}15`, color }}>
                        <Icon className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-semibold" style={{ color: INK }}>{item.action}</span>
                          <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{item.entityType}</span>
                        </div>
                        {item.description && <p className="text-[12px] mt-0.5 truncate" style={{ color: INK_SOFT }}>{item.description}</p>}
                        <div className="flex items-center gap-3 mt-1 text-[11px]" style={{ color: INK_SOFT }}>
                          <span>{item.timestamp ? new Date(item.timestamp).toLocaleString() : ""}</span>
                          {item.entityId && <span className="font-mono">#{item.entityId}</span>}
                          {item.amount != null && <span className="font-semibold">{formatOrgMoney(item.amount, config)}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
