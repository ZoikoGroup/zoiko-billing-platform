import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Calendar, Search, Filter, X, RefreshCw,
  AlertCircle, Clock, CheckCircle, FileText, Plus } from "lucide-react"
import HRPage from "../../../components/HRPage";
import { ErrorState } from "../../../components/billing-shared";
import { subscriptionApi } from "../../../service/billingService";
import { extractArray } from "../../../utils/billing-helpers";
import { formatCurrency } from "../../../utils/locale";

const ITEMS_PER_PAGE = 10;

const STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "cancelled", label: "Cancelled" },
  { value: "expired", label: "Expired" },
  { value: "past_due", label: "Past Due" },
];

const formatDate = (d) => d ? new Date(d).toLocaleDateString() : "—";

export default function InvoiceSchedulesPage() {
  const navigate = useNavigate();

  const [schedules, setSchedules] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [dateRange, setDateRange] = useState("all");
  const [showFilters, setShowFilters] = useState(false);

  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setCurrentPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);

  const fetchSchedules = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params = { page: safePage, per_page: ITEMS_PER_PAGE };
      if (debouncedSearch) params.search_term = debouncedSearch;
      if (statusFilter) params.status = statusFilter;
      const data = await subscriptionApi.list(params);
      const items = extractArray(data);
      setSchedules(items);
      setTotal(data?.total || data?.total_count || items.length);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  }, [safePage, debouncedSearch, statusFilter]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    await fetchSchedules();
    setRefreshing(false);
  }, [fetchSchedules]);

  useEffect(() => { fetchSchedules(); }, [fetchSchedules]);

  const activeSchedules = schedules.filter((s) => s.status === "active");
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const thisWeek = new Date(now);
  thisWeek.setDate(thisWeek.getDate() + 7);
  const thisMonth = new Date(now);
  thisMonth.setMonth(thisMonth.getMonth() + 1);

  const dueThisWeek = schedules.filter(
    (s) => s.next_billing_at && new Date(s.next_billing_at) >= now && new Date(s.next_billing_at) <= thisWeek
  );
  const dueToday = schedules.filter(
    (s) => s.next_billing_at && new Date(s.next_billing_at) >= startOfToday && new Date(s.next_billing_at) < endOfToday
  );
  const dueThisMonth = schedules.filter(
    (s) => s.next_billing_at && new Date(s.next_billing_at) >= now && new Date(s.next_billing_at) <= thisMonth
  );
  const renewalReminders = schedules.filter(
    (s) => s.current_term_end && new Date(s.current_term_end) >= now && new Date(s.current_term_end) <= thisMonth
  );
  const overdue = schedules.filter(
    (s) => s.next_billing_at && new Date(s.next_billing_at) < now && s.status === "active"
  );

  function clearFilters() {
    setSearch("");
    setStatusFilter("");
    setDateRange("all");
    setCurrentPage(1);
  }

  const hasActiveFilters = debouncedSearch || statusFilter || dateRange !== "all";

  const filteredSchedules = schedules.filter((s) => {
    if (!s.next_billing_at && dateRange !== "all") return false;
    if (dateRange === "today" && s.next_billing_at) {
      const d = new Date(s.next_billing_at);
      if (d < startOfToday || d >= endOfToday) return false;
    }
    if (dateRange === "week" && s.next_billing_at) {
      const d = new Date(s.next_billing_at);
      if (d < now || d > thisWeek) return false;
    }
    if (dateRange === "renewals") {
      if (!s.current_term_end) return false;
      const d = new Date(s.current_term_end);
      if (d < now || d > thisMonth) return false;
    }
    if (dateRange === "month" && s.next_billing_at) {
      const d = new Date(s.next_billing_at);
      if (d < now || d > thisMonth) return false;
    }
    if (dateRange === "overdue" && s.next_billing_at) {
      const d = new Date(s.next_billing_at);
      if (d >= now || s.status !== "active") return false;
    }
    if (dateRange === "none" && !s.next_billing_at) return false;
    return true;
  });

  const displaySchedules = filteredSchedules;

  return (
    <HRPage title="Invoice Schedules" subtitle="Manage subscription billing schedules">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input type="text" placeholder="Search schedules..." value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 pr-3 py-2 rounded-lg border border-gray-300 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 w-64" />
          </div>
          <button onClick={() => setShowFilters(!showFilters)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border transition-colors ${
              showFilters || hasActiveFilters
                ? "border-brand-200 bg-brand-50 text-brand-700"
                : "border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}>
            <Filter className="h-4 w-4" /> Filters {hasActiveFilters && <span className="w-2 h-2 rounded-full bg-brand-500" />}
          </button>
          {hasActiveFilters && (
            <button onClick={clearFilters}
              className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">
              <X className="h-4 w-4" /> Clear
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => navigate("/billing/invoices?create=1")}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700">
            <Plus className="h-4 w-4" /> Create Invoice
          </button>
          <button onClick={refreshAll} disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        {[
          { value: "today", label: "Today", count: dueToday.length },
          { value: "week", label: "This Week", count: dueThisWeek.length },
          { value: "overdue", label: "Overdue", count: overdue.length },
          { value: "renewals", label: "Renewals", count: renewalReminders.length },
        ].map((chip) => (
          <button key={chip.value} onClick={() => { setDateRange(chip.value); setCurrentPage(1); }}
            className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${dateRange === chip.value ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
            {chip.label}
            <span className={dateRange === chip.value ? "text-white/80" : "text-slate-400"}>{chip.count}</span>
          </button>
        ))}
      </div>

      {showFilters && (
        <div className="mb-6 p-4 bg-white rounded-xl border border-gray-200 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">Status</label>
              <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
                className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">Next Billing</label>
              <select value={dateRange} onChange={(e) => { setDateRange(e.target.value); setCurrentPage(1); }}
                className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                <option value="all">All Dates</option>
                <option value="today">Due Today</option>
                <option value="week">Due This Week</option>
                <option value="month">Due This Month</option>
                <option value="renewals">Renewal Reminders</option>
                <option value="overdue">Overdue</option>
                <option value="none">No Schedule</option>
              </select>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-2 mb-2">
            <Calendar className="h-5 w-5 text-brand-500" />
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Active Schedules</p>
          </div>
          <p className="text-2xl font-bold text-gray-900">{activeSchedules.length}</p>
          <p className="text-xs text-gray-400 mt-1">{schedules.length} total</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle className="h-5 w-5 text-emerald-500" />
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Due Today</p>
          </div>
          <p className="text-2xl font-bold text-emerald-600">{dueToday.length}</p>
          <p className="text-xs text-gray-400 mt-1">Ready to invoice</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="h-5 w-5 text-blue-500" />
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Due This Week</p>
          </div>
          <p className="text-2xl font-bold text-blue-600">{dueThisWeek.length}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-2 mb-2">
            <Calendar className="h-5 w-5 text-amber-500" />
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Due This Month</p>
          </div>
          <p className="text-2xl font-bold text-amber-600">{dueThisMonth.length}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-2 mb-2">
            <AlertCircle className="h-5 w-5 text-red-500" />
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Overdue</p>
          </div>
          <p className="text-2xl font-bold text-red-600">{overdue.length}</p>
          <p className="text-xs text-gray-400 mt-1">Past billing date</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-2 mb-2">
            <RefreshCw className="h-5 w-5 text-indigo-500" />
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Renewals</p>
          </div>
          <p className="text-2xl font-bold text-indigo-600">{renewalReminders.length}</p>
          <p className="text-xs text-gray-400 mt-1">Term ends this month</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
          </div>
        ) : error ? (
          <ErrorState message={error} onRetry={fetchSchedules} />
        ) : displaySchedules.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Calendar className="h-10 w-10 text-gray-300 mb-3" />
            <p className="text-sm font-medium text-gray-500 mb-1">No schedules found</p>
            <p className="text-xs text-gray-400">{hasActiveFilters ? "Try adjusting your filters." : "No subscription billing schedules available."}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-3 px-4 font-medium text-gray-500 text-xs uppercase tracking-wider">Subscription</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-500 text-xs uppercase tracking-wider">Status</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-500 text-xs uppercase tracking-wider">Plan</th>
                  <th className="text-right py-3 px-4 font-medium text-gray-500 text-xs uppercase tracking-wider">Amount</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-500 text-xs uppercase tracking-wider">Next Billing</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-500 text-xs uppercase tracking-wider">Term End</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-500 text-xs uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {displaySchedules.map((s) => {
                  const nbDate = s.next_billing_at ? new Date(s.next_billing_at) : null;
                  const isOverdue = nbDate && nbDate < now && s.status === "active";
                  const isThisWeek = nbDate && nbDate >= now && nbDate <= thisWeek;
                  const isThisMonth = nbDate && nbDate >= now && nbDate <= thisMonth;

                  let billingStyle = "text-gray-500";
                  if (isOverdue) billingStyle = "text-red-600 font-medium";
                  else if (isThisWeek) billingStyle = "text-amber-600 font-medium";
                  else if (isThisMonth) billingStyle = "text-blue-600";

                  return (
                    <tr key={s.id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="py-3 px-4">
                        <span className="font-medium text-gray-900">{s.subscription_number || `#${s.id}`}</span>
                      </td>
                      <td className="py-3 px-4">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                          s.status === "active" ? "bg-emerald-100 text-emerald-700" :
                          s.status === "paused" ? "bg-amber-100 text-amber-700" :
                          s.status === "past_due" ? "bg-red-100 text-red-700" :
                          s.status === "cancelled" ? "bg-slate-100 text-slate-500" :
                          "bg-gray-100 text-gray-600"
                        }`}>
                          {s.status ? s.status.charAt(0).toUpperCase() + s.status.slice(1) : "Unknown"}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-gray-600">
                        {s.plan?.plan_name || s.plan_name || `Plan #${s.plan_id}`}
                      </td>
                      <td className="py-3 px-4 text-right font-medium text-gray-900">
                        {formatCurrency(s.unit_price, s.currency || "—")}
                        {s.quantity > 1 && <span className="text-xs text-gray-400 ml-1">x{s.quantity}</span>}
                      </td>
                      <td className={`py-3 px-4 whitespace-nowrap ${billingStyle}`}>
                        {s.next_billing_at ? formatDate(s.next_billing_at) : "—"}
                        {isOverdue && <span className="ml-1.5 text-xs text-red-500">(Overdue)</span>}
                        {isThisWeek && !isOverdue && <span className="ml-1.5 text-xs text-amber-500">(This week)</span>}
                      </td>
                      <td className="py-3 px-4 text-gray-500 whitespace-nowrap">
                        {s.current_term_end ? formatDate(s.current_term_end) : "—"}
                      </td>
                      <td className="py-3 px-4">
                        <button onClick={() => navigate(`/billing/subscriptions/${s.id}`)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-brand-600 bg-brand-50 rounded-lg hover:bg-brand-100">
                          <FileText className="h-3.5 w-3.5" /> View
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !error && totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
            <p className="text-xs text-gray-500">
              Showing {Math.min((safePage - 1) * ITEMS_PER_PAGE + 1, total)}–{Math.min(safePage * ITEMS_PER_PAGE, total)} of {total}
            </p>
            <div className="flex items-center gap-1">
              <button onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1}
                className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-40">
                Previous
              </button>
              {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                const start = Math.max(1, Math.min(safePage - 2, totalPages - 4));
                const page = start + i;
                if (page > totalPages) return null;
                return (
                  <button key={page} onClick={() => setCurrentPage(page)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg ${
                      page === safePage ? "bg-brand-600 text-white" : "text-gray-600 bg-gray-100 hover:bg-gray-200"
                    }`}>
                    {page}
                  </button>
                );
              })}
              <button onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages}
                className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-40">
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </HRPage>
  );
}
