import { useState, useEffect, useCallback } from "react";
import {
  Receipt, Search, Filter, X, ChevronDown, ArrowUpDown,
  Plus, AlertCircle, CheckCircle, Clock, Pencil, DollarSign, Landmark, Globe
} from "lucide-react";
import { taxApi } from "../../../service/billingService";
import { formatDisplayDate, extractArray } from "../../../utils/billing-helpers";
import { getCurrencySelectOptions } from "../../../utils/currency";
import {
  PageSkeleton, ErrorState, DashboardHeader, DashboardStatCard, DASHBOARD_KPI_GRID,
  StatusBadge, Pagination, useConfirmationDialog, exportDashboardToCsv, exportDashboardToJson,
} from "../../../components/billing-shared";
import { useBillingDateRange } from "../utils/DateRangeContext";

const ITEMS_PER_PAGE = 10;

function filterByCreatedAt(items, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return items;
  return items.filter((item) => {
    if (!item?.created_at) return true;
    const created = String(item.created_at).slice(0, 10);
    if (dateFrom && created < dateFrom) return false;
    if (dateTo && created > dateTo) return false;
    return true;
  });
}

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

const TAX_TYPE_OPTIONS = [
  { value: "sales_tax", label: "Sales Tax" },
  { value: "vat", label: "VAT" },
  { value: "gst", label: "GST" },
  { value: "service_tax", label: "Service Tax" },
  { value: "withholding", label: "Withholding" },
  { value: "customs", label: "Customs" },
];

const CURRENCY_OPTIONS = getCurrencySelectOptions();

const COUNTRY_OPTIONS = [
  { code: "IN", name: "India" },
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "EU", name: "European Union" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "AU", name: "Australia" },
  { code: "CA", name: "Canada" },
  { code: "SG", name: "Singapore" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
];

const SORT_FIELDS = [
  { key: "name", label: "Name" },
  { key: "rate", label: "Rate" },
  { key: "tax_type", label: "Type" },
  { key: "status", label: "Status" },
  { key: "created_at", label: "Created" },
];

// Reuses the shared billing-shared StatusBadge rather than hand-rolling a
// duplicate pill; the icon is passed per-render so the active/inactive icon
// swap from the original local component is preserved.
const STATUS_BADGE_OPTIONS = [
  { value: "active", label: "active", color: "bg-emerald-100 text-emerald-700" },
  { value: "inactive", label: "inactive", color: "bg-slate-100 text-slate-600" },
];

const TAX_TYPE_BADGE_OPTIONS = [
  { value: "sales", label: "sales", color: "bg-blue-100 text-blue-700" },
  { value: "vat", label: "vat", color: "bg-brand-100 text-brand-700" },
  { value: "gst", label: "gst", color: "bg-amber-100 text-amber-700" },
  { value: "income", label: "income", color: "bg-green-100 text-green-700" },
  { value: "withholding", label: "withholding", color: "bg-red-100 text-red-700" },
];

export default function TaxRatesPage() {
  const {
    range: dateRangeValue, setRange: setDateRangeValue,
    customStart, customEnd, applyCustomRange, reset: resetDateRange,
    dateRange,
  } = useBillingDateRange();
  const [taxRates, setTaxRates] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [sortField, setSortField] = useState("name");
  const [sortDir, setSortDir] = useState("asc");
  const [currentPage, setCurrentPage] = useState(1);

  const [showForm, setShowForm] = useState(false);
  const [editRate, setEditRate] = useState(null);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState(null);
  const [formData, setFormData] = useState({
    name: "", code: "", description: "", rate: "", tax_type: "sales_tax", jurisdiction: "",
    jurisdiction_type: "country", is_active: true, is_compound: false, is_recoverable: true,
    country_code: "", currency_code: "", tax_type_label: "", is_default: false, priority: 0,
  });
  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedSearch(search); setCurrentPage(1); }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);

  const fetchTaxRates = useCallback(async () => {
    try {
      setError(null);
      if (!loading) setRefreshing(true);
      const params = {
        page: safePage, per_page: ITEMS_PER_PAGE,
        search_term: debouncedSearch || undefined,
        tax_type: typeFilter || undefined,
        is_active: statusFilter === "active" ? true : statusFilter === "inactive" ? false : undefined,
      };
      const data = await taxApi.list(params);
      const items = extractArray(data);
      setTaxRates(items);
      setTotal(data.total || items.length || 0);
    } catch (err) {
      setError(err.message || "Failed to load tax rates");
      setTaxRates([]); setTotal(0);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [safePage, debouncedSearch, typeFilter, statusFilter]);

  useEffect(() => { fetchTaxRates(); }, [fetchTaxRates]);
  useEffect(() => { if (currentPage > totalPages && totalPages > 0) setCurrentPage(totalPages); }, [totalPages, currentPage]);

  const handleSort = (field) => {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir("asc"); }
    setCurrentPage(1);
  };

  const handleSubmit = async () => {
    setFormLoading(true); setFormError(null);
    try {
      const payload = {
        ...formData,
        rate: parseFloat(formData.rate) || 0,
        is_compound: !!formData.is_compound,
        is_recoverable: !!formData.is_recoverable,
      };
      if (editRate) await taxApi.update(editRate.id, payload);
      else await taxApi.create(payload);
      setShowForm(false); setEditRate(null);
      setFormData({ name: "", code: "", description: "", rate: "", tax_type: "sales_tax", jurisdiction: "", jurisdiction_type: "country", is_active: true, is_compound: false, is_recoverable: true, country_code: "", currency_code: "", tax_type_label: "", is_default: false, priority: 0 });
      setCurrentPage(1); fetchTaxRates();
    } catch (err) {
      setFormError(err.message || "Failed to save tax rate");
    } finally { setFormLoading(false); }
  };

  const handleDeactivate = async (id) => {
    const ok = await confirm({ title: "Deactivate tax rate", message: "Deactivate this tax rate? This action cannot be undone.", confirmLabel: "Deactivate" });
    if (!ok) return;
    try { await taxApi.update(id, { is_active: false }); fetchTaxRates(); }
    catch (err) { setError(err.message || "Failed to deactivate tax rate"); }
  };

  const handleExport = async (format) => {
    try {
      const allData = await taxApi.list({ per_page: 100 });
      const items = extractArray(allData);
      const prefix = `tax-rates-${new Date().toISOString().split("T")[0]}`;
      if (format === "csv") exportDashboardToCsv(items, prefix);
      else exportDashboardToJson(items, prefix);
    } catch (err) {
      setError(err?.message || "Failed to export tax rates");
      setTimeout(() => setError(null), 3000);
    }
  };

  const filteredTaxRates = filterByCreatedAt(taxRates, dateRange.date_from, dateRange.date_to);

  const sortedRates = [...taxRates].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;
    if (sortField === "name") return (a.name || "").localeCompare(b.name || "") * dir;
    if (sortField === "rate") return (parseFloat(a.rate || 0) - parseFloat(b.rate || 0)) * dir;
    if (sortField === "tax_type") return (a.tax_type || "").localeCompare(b.tax_type || "") * dir;
    if (sortField === "status") return ((a.is_active ? "active" : "inactive") || "").localeCompare((b.is_active ? "active" : "inactive") || "") * dir;
    if (sortField === "created_at") return (new Date(a.created_at || 0) - new Date(b.created_at || 0)) * dir;
    return 0;
  });

  const SortHeader = ({ field, label }) => (
    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider cursor-pointer select-none hover:text-slate-700" onClick={() => handleSort(field)}>
      <div className="flex items-center gap-1">{label}<ArrowUpDown size={12} className={`${sortField === field ? "text-brand-600" : "text-slate-300"}`} /></div>
    </th>
  );

  const headerProps = {
    title: "Tax Rates",
    subtitle: "Manage tax rates, jurisdictions, and default rates",
    icon: Receipt,
    iconGradient: "from-amber-500 to-orange-600",
    onRefresh: () => { setRefreshing(true); fetchTaxRates(); },
    refreshing,
    onExportCSV: () => handleExport("csv"),
    onExportJSON: () => handleExport("json"),
    dateRange: dateRangeValue,
    onDateRangeChange: setDateRangeValue,
    customStart,
    customEnd,
    onApplyCustomRange: applyCustomRange,
    onResetDateRange: resetDateRange,
  };

  if (loading) {
    return (
      <div className="space-y-8 px-4 py-6 sm:px-6 max-w-7xl mx-auto" aria-label="Loading tax rates">
        <DashboardHeader {...headerProps} />
        <PageSkeleton rows={6} />
      </div>
    );
  }

  if (error && taxRates.length === 0) {
    return (
      <div className="space-y-8 px-4 py-6 sm:px-6 max-w-7xl mx-auto">
        <DashboardHeader {...headerProps} />
        <ErrorState message={error} onRetry={() => { setLoading(true); fetchTaxRates(); }} title="Something went wrong" />
      </div>
    );
  }

  return (
    <div className="space-y-8 px-4 py-6 sm:px-6 max-w-7xl mx-auto">
      <DashboardHeader {...headerProps} />

      <div className={DASHBOARD_KPI_GRID}>
        <DashboardStatCard
          title="Total Tax Rates"
          value={total}
          subtitle={`${taxRates.filter((r) => r.is_active === true).length} active on this page`}
          icon={Receipt}
          color="from-brand to-brand-hover"
          onClick={() => { setTypeFilter(""); setStatusFilter(""); setCurrentPage(1); }}
        />
        <DashboardStatCard
          title="Sales Tax"
          value={filteredTaxRates.filter((r) => r.tax_type === "sales").length}
          icon={DollarSign}
          color="from-blue-500 to-blue-600"
          onClick={() => { setTypeFilter("sales"); setCurrentPage(1); }}
        />
        <DashboardStatCard
          title="VAT / GST"
          value={filteredTaxRates.filter((r) => r.tax_type === "vat" || r.tax_type === "gst").length}
          icon={Landmark}
          color="from-emerald-500 to-emerald-600"
        />
        <DashboardStatCard
          title="Countries Covered"
          value={new Set(filteredTaxRates.map((r) => r.jurisdiction)).size}
          icon={Globe}
          color="from-amber-500 to-orange-500"
        />
      </div>

      <div className="bg-white border border-slate-200 rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.02)] overflow-hidden">
        <div className="p-6 border-b border-slate-100">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3 flex-1">
              <div className="relative flex-1 max-w-md">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input type="text" placeholder="Search tax rates..." value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Search tax rates"
                  className="w-full pl-9 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                {search && <button onClick={() => setSearch("")} aria-label="Clear search" className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X size={16} /></button>}
              </div>
              <button onClick={() => setShowFilters(!showFilters)} aria-label="Toggle filters" aria-pressed={showFilters}
                className={`p-2.5 rounded-xl border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${showFilters ? "bg-brand-50 border-brand-200 text-brand-600" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}>
                <Filter size={18} />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => { setShowForm(true); setEditRate(null); setFormData({ name: "", code: "", description: "", rate: "", tax_type: "sales_tax", jurisdiction: "", jurisdiction_type: "country", is_active: true, is_compound: false, is_recoverable: true, country_code: "", currency_code: "", tax_type_label: "", is_default: false, priority: 0 }); }}
                className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg">
                <Plus size={18} /> Add Tax Rate
              </button>
            </div>
          </div>

          {showFilters && (
            <div className="flex flex-wrap items-center gap-3 mt-4 pt-4 border-t border-slate-100">
              <div className="relative">
                <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setCurrentPage(1); }}
                  className="appearance-none px-4 py-2 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                  <option value="">All Types</option>
                  {TAX_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              </div>
              <div className="relative">
                <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
                  className="appearance-none px-4 py-2 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                  <option value="">All Statuses</option>
                  {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              </div>
              <div className="relative">
                <select value={sortField} onChange={(e) => setSortField(e.target.value)}
                  className="appearance-none px-4 py-2 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                  {SORT_FIELDS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
                <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              </div>
              <button onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                className="flex items-center gap-1 px-3 py-2 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50">
                <ArrowUpDown size={14} /> {sortDir === "asc" ? "A-Z" : "Z-A"}
              </button>
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <SortHeader field="name" label="Name" />
                <SortHeader field="rate" label="Rate" />
                <SortHeader field="tax_type" label="Type" />
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Currency</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Jurisdiction</th>
                <SortHeader field="status" label="Status" />
                <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">Default</th>
                <SortHeader field="created_at" label="Created" />
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {sortedRates.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-16 text-center">
                    <div className="flex flex-col items-center">
                      <Receipt size={40} className="text-slate-300 mb-3" />
                      <p className="text-slate-500 font-medium">No tax rates found</p>
                      <p className="text-slate-400 text-sm mt-1">{search || typeFilter || statusFilter ? "Try adjusting your search or filters" : "Add your first tax rate to get started"}</p>
                    </div>
                  </td>
                </tr>
              ) : sortedRates.map((rate) => (
                <tr key={rate.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-full bg-gradient-to-br from-brand to-brand-hover text-white flex items-center justify-center text-sm font-bold">
                        {(rate.name || "?").charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className="font-medium text-slate-800">{rate.name || "Unnamed"}</p>
                        {rate.description && <p className="text-xs text-slate-400 line-clamp-1">{rate.description}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <span className="font-semibold text-slate-800">{parseFloat(rate.rate || 0).toFixed(2)}%</span>
                  </td>
                  <td className="px-4 py-4"><StatusBadge status={rate.tax_type} options={TAX_TYPE_BADGE_OPTIONS} fallbackColor="bg-slate-100 text-slate-600" /></td>
                  <td className="px-4 py-4 text-sm text-slate-600">
                    {rate.currency_code ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-brand-100 text-brand-700">
                        {rate.currency_code}
                      </span>
                    ) : "—"}
                  </td>
                  <td className="px-4 py-4 text-sm text-slate-600">
                    {rate.jurisdiction ? `${rate.jurisdiction} (${rate.jurisdiction_type || "country"})` : "—"}
                  </td>
                  <td className="px-4 py-4">
                    <StatusBadge status={rate.is_active ? "active" : "inactive"} options={STATUS_BADGE_OPTIONS} icon={rate.is_active !== false ? CheckCircle : Clock} />
                  </td>
                  <td className="px-4 py-4 text-center">
                    {rate.is_default ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-700">
                        Default
                      </span>
                    ) : (
                      <span className="text-slate-400 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-4 text-sm text-slate-500">{formatDisplayDate(rate.created_at)}</td>
                  <td className="px-4 py-4 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => { setEditRate(rate); setFormData({ name: rate.name || "", code: rate.code || "", description: rate.description || "", rate: (parseFloat(rate.rate || 0)).toString(), tax_type: rate.tax_type || "sales_tax", jurisdiction: rate.jurisdiction || "", jurisdiction_type: rate.jurisdiction_type || "country", is_active: rate.is_active !== false, is_compound: !!rate.is_compound, is_recoverable: rate.is_recoverable !== false, country_code: rate.country_code || "", currency_code: rate.currency_code || "", tax_type_label: rate.tax_type_label || "", is_default: !!rate.is_default, priority: rate.priority || 0 }); setShowForm(true); }}
                       className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-blue-600 transition-colors" title="Edit" aria-label={`Edit tax rate ${rate.name || ""}`}
                      >
                        <Pencil size={16} />
                      </button>
                      {rate.is_active !== false && (
                        <button onClick={() => handleDeactivate(rate.id)}
                          className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-amber-600 transition-colors" title="Deactivate" aria-label={`Deactivate tax rate ${rate.name || ""}`}>
                          <Clock size={16} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Pagination page={safePage} totalPages={totalPages} onPageChange={setCurrentPage}>
          {total} total tax rate(s)
        </Pagination>
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { setShowForm(false); setFormError(null); }}>
          <div className="bg-white rounded-3xl p-8 w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-slate-800">{editRate ? "Edit Tax Rate" : "New Tax Rate"}</h2>
              <button onClick={() => { setShowForm(false); setFormError(null); }} className="p-1 hover:bg-slate-100 rounded-lg" aria-label="Close form"><X size={20} /></button>
            </div>
            {formError && (
              <div className="flex items-center gap-2 p-3 mb-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
                <AlertCircle size={16} />{formError}
              </div>
            )}
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Name *</label>
                  <input type="text" value={formData.name} onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))}
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Code *</label>
                  <input type="text" value={formData.code} onChange={(e) => setFormData((p) => ({ ...p, code: e.target.value }))}
                    placeholder="e.g. GST-STD"
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
                <textarea rows={2} value={formData.description} onChange={(e) => setFormData((p) => ({ ...p, description: e.target.value }))}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Rate (%) *</label>
                  <input type="number" step="0.01" min="0" max="100" value={formData.rate} onChange={(e) => setFormData((p) => ({ ...p, rate: e.target.value }))}
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Tax Type</label>
                  <select value={formData.tax_type} onChange={(e) => setFormData((p) => ({ ...p, tax_type: e.target.value }))}
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                    {TAX_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Jurisdiction</label>
                  <input type="text" value={formData.jurisdiction} onChange={(e) => setFormData((p) => ({ ...p, jurisdiction: e.target.value }))}
                    placeholder="e.g. US, CA, EU"
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Jurisdiction Type</label>
                  <select value={formData.jurisdiction_type} onChange={(e) => setFormData((p) => ({ ...p, jurisdiction_type: e.target.value }))}
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                    <option value="country">Country</option>
                    <option value="state">State / Province</option>
                    <option value="county">County</option>
                    <option value="city">City</option>
                    <option value="region">Region</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex items-end pb-2.5">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={formData.is_active !== false} onChange={(e) => setFormData((p) => ({ ...p, is_active: e.target.checked }))}
                      className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" />
                    <span className="text-sm text-slate-700">Active</span>
                  </label>
                </div>
                <div className="flex items-end gap-4 pb-2.5">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={formData.is_compound} onChange={(e) => setFormData((p) => ({ ...p, is_compound: e.target.checked }))}
                      className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" />
                    <span className="text-sm text-slate-700">Compound Tax</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={formData.is_recoverable} onChange={(e) => setFormData((p) => ({ ...p, is_recoverable: e.target.checked }))}
                      className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" />
                    <span className="text-sm text-slate-700">Recoverable</span>
                  </label>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Country</label>
                  <select value={formData.country_code} onChange={(e) => setFormData((p) => ({ ...p, country_code: e.target.value }))}
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                    <option value="">Select country</option>
                    {COUNTRY_OPTIONS.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Currency</label>
                  <select value={formData.currency_code} onChange={(e) => setFormData((p) => ({ ...p, currency_code: e.target.value }))}
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                    <option value="">Select currency</option>
                    {CURRENCY_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.value} - {c.label.split("—")[0].trim()}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Tax Type Label</label>
                  <input type="text" value={formData.tax_type_label} onChange={(e) => setFormData((p) => ({ ...p, tax_type_label: e.target.value }))}
                    placeholder="e.g. GST, VAT, Sales Tax"
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Priority</label>
                  <input type="number" min="0" step="1" value={formData.priority} onChange={(e) => setFormData((p) => ({ ...p, priority: Number(e.target.value) }))}
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={formData.is_default} onChange={(e) => setFormData((p) => ({ ...p, is_default: e.target.checked }))}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" />
                  <span className="text-sm text-slate-700">Default tax for this currency</span>
                </label>
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-8">
              <button onClick={() => { setShowForm(false); setFormError(null); }} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Cancel</button>
              <button onClick={handleSubmit} disabled={formLoading || !formData.name}
                className="px-6 py-2 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg disabled:opacity-50">
                {formLoading ? "Saving..." : editRate ? "Update Tax Rate" : "Create Tax Rate"}
              </button>
            </div>
          </div>
        </div>
      )}
      {ConfirmationDialog}
    </div>
  );
}
