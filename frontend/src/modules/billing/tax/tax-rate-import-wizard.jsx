import { useState, useRef, useCallback } from "react";
import {
  Upload, FileText, CheckCircle, AlertCircle, ArrowRight, ArrowLeft,
  X, Download, RefreshCw, AlertTriangle, Info, SkipForward,
  RotateCcw, Copy, Eye, ChevronDown, Receipt, Layers,
} from "lucide-react";
import { taxApi } from "../../../service/billingService";

// ─── Step metadata ────────────────────────────────────────────────────────────
const STEPS = [
  { id: 1, label: "Upload" },
  { id: 2, label: "Map Columns" },
  { id: 3, label: "Validate" },
  { id: 4, label: "Preview" },
  { id: 5, label: "Confirm" },
];

const TAX_RATE_FIELDS = [
  { value: "name",             label: "Name *",             required: true },
  { value: "code",             label: "Code *",             required: true },
  { value: "tax_type",         label: "Tax Type *",         required: true },
  { value: "rate",             label: "Rate (%) *",         required: true },
  { value: "jurisdiction",     label: "Jurisdiction *",     required: true },
  { value: "country_code",     label: "Country Code",       required: false },
  { value: "currency_code",    label: "Currency",           required: false },
  { value: "applies_to",       label: "Applies To",         required: false },
  { value: "effective_from",   label: "Effective From",     required: false },
  { value: "effective_to",     label: "Effective Until",    required: false },
  { value: "is_compound",      label: "Is Compound",        required: false },
  { value: "is_recoverable",   label: "Is Recoverable",     required: false },
  { value: "is_default",       label: "Is Default",         required: false },
  { value: "priority",         label: "Priority",           required: false },
  { value: "is_active",        label: "Status",             required: false },
  { value: "__ignore",         label: "— Ignore this column —", required: false },
];

// Mirrors the backend's MAX_IMPORT_FILE_SIZE_BYTES (tax_rate_import_service.py)
// — this is purely an early, friendlier UX check; the server enforces the
// real limit regardless of what the client sends.
const MAX_IMPORT_FILE_SIZE_BYTES = 10 * 1024 * 1024;
// Rows processed per confirm request. Keeps each request comfortably fast
// (avoiding a timeout on very large imports) and gives a real progress bar
// between batches instead of one long blocking call.
const CONFIRM_BATCH_SIZE = 500;

const DUPLICATE_STRATEGIES = [
  { value: "skip",        label: "Skip Existing",       icon: SkipForward,  desc: "Leave duplicates unchanged (recommended)" },
  { value: "overwrite",   label: "Update Existing",     icon: RotateCcw,    desc: "Update existing rates with imported data" },
  { value: "create_copy", label: "Create New",          icon: Copy,         desc: "Add as a new rate with modified code" },
  { value: "review",      label: "Review Individually", icon: Eye,          desc: "Choose action per duplicate in preview" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function StatusPill({ status }) {
  const map = {
    valid:     "bg-emerald-100 text-emerald-700",
    invalid:   "bg-red-100 text-red-700",
    duplicate: "bg-amber-100 text-amber-700",
    warning:   "bg-yellow-100 text-yellow-700",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${map[status] || "bg-slate-100 text-slate-600"}`}>
      {status}
    </span>
  );
}

function StepBar({ current }) {
  return (
    <div className="flex items-center justify-between mb-8 px-2">
      {STEPS.map((step, idx) => {
        const done = current > step.id;
        const active = current === step.id;
        return (
          <div key={step.id} className="flex items-center flex-1">
            <div className="flex flex-col items-center">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold transition-all duration-300
                ${done ? "bg-brand-600 text-white shadow-lg shadow-brand-200"
                       : active ? "bg-brand-600 text-white ring-4 ring-brand-200"
                                : "bg-slate-100 text-slate-500"}`}>
                {done ? <CheckCircle size={18} /> : step.id}
              </div>
              <span className={`mt-1 text-xs font-medium whitespace-nowrap
                ${active ? "text-brand-700" : done ? "text-brand-500" : "text-slate-500"}`}>
                {step.label}
              </span>
            </div>
            {idx < STEPS.length - 1 && (
              <div className={`flex-1 h-0.5 mx-2 mt-[-14px] rounded-full transition-all duration-500
                ${done ? "bg-brand-500" : "bg-slate-200"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function TaxRateImportWizard({ onClose, onImported }) {
  const [step, setStep] = useState(1);
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [columnMap, setColumnMap] = useState({});
  const [duplicateStrategy, setDuplicateStrategy] = useState("skip");
  const [preview, setPreview] = useState(null);          // ImportPreviewResult
  const [perRowActions, setPerRowActions] = useState({}); // {rowIndex: action}
  const [summary, setSummary] = useState(null);           // ImportSummaryResult
  const [confirmProgress, setConfirmProgress] = useState(null); // { done, total }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [showAllRows, setShowAllRows] = useState(false);
  const fileInputRef = useRef(null);

  // ── Step 1: Upload ─────────────────────────────────────────────────────────

  const handleFileDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) acceptFile(f);
  }, []);

  const handleFileSelect = (e) => {
    const f = e.target.files?.[0];
    if (f) acceptFile(f);
  };

  const acceptFile = (f) => {
    const ext = f.name.split(".").pop().toLowerCase();
    if (!["csv", "xlsx", "xls"].includes(ext)) {
      setError("Only CSV and XLSX files are supported.");
      return;
    }
    if (f.size > MAX_IMPORT_FILE_SIZE_BYTES) {
      setError(`File is too large (${(f.size / (1024 * 1024)).toFixed(1)} MB). The maximum allowed size is ${MAX_IMPORT_FILE_SIZE_BYTES / (1024 * 1024)} MB — please split it into smaller files.`);
      return;
    }
    setFile(f);
    setError(null);
    setPreview(null);
    setSummary(null);
    setColumnMap({});
    setPerRowActions({});
  };

  const handleDownloadErrorReport = () => {
    if (!summary?.failed_details?.length) return;
    const csvEscape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = ["Row", "Name", "Code", "Error"];
    const lines = [header.map(csvEscape).join(",")];
    for (const fd of summary.failed_details) {
      const originalRow = preview?.rows?.find((r) => r.row_index === fd.row);
      const name = originalRow?.mapped_data?.name || originalRow?.raw_data?.Name || originalRow?.raw_data?.name || "";
      const code = originalRow?.mapped_data?.code || originalRow?.raw_data?.Code || originalRow?.raw_data?.code || "";
      lines.push([fd.row, name, code, fd.error].map(csvEscape).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    triggerDownload(blob, `tax-rate-import-error-report-${new Date().toISOString().slice(0, 10)}.csv`);
  };

  const handleDownloadTemplate = async (fmt) => {
    setTemplateLoading(true);
    try {
      await taxApi.downloadTemplate(fmt);
    } catch (e) {
      setError("Failed to download template: " + e.message);
    } finally {
      setTemplateLoading(false);
    }
  };

  // ── Step 2 → 4: Preview (validate + map) ──────────────────────────────────

  // `advance` controls whether a successful call moves the wizard on to the
  // results step (step 4). It's false for the initial call made right after
  // upload — that call exists purely to read the file's columns for the
  // Map Columns screen (step 2) and must not skip past it.
  const handlePreview = async (advance = true) => {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("column_map", JSON.stringify(columnMap));
      fd.append("duplicate_strategy", duplicateStrategy);
      const result = await taxApi.importPreview(fd);
      setPreview(result);
      // Auto-initialise per-row actions for duplicates using global strategy
      const actions = {};
      (result.rows || []).forEach(row => {
        if (row.status === "duplicate") actions[row.row_index] = duplicateStrategy === "review" ? "skip" : duplicateStrategy;
      });
      setPerRowActions(actions);
      if (advance) setStep(4);
    } catch (e) {
      setError(e.message || "Preview failed. Please check your file and try again.");
      if (advance) setStep(2);
    } finally {
      setLoading(false);
    }
  };

  // ── Step 5: Confirm import ─────────────────────────────────────────────────

  // Processes the previewed session in fixed-size batches rather than one
  // request for the whole file — each batch is its own fast HTTP call (so a
  // large import can't time out a single request), and the accumulated
  // totals give a real, incrementing progress bar instead of one indefinite
  // spinner. Only the request is chunked, not the underlying create/update
  // behavior (TaxService.create_tax_rate/update_tax_rate on the backend).
  const handleConfirm = async () => {
    if (!preview?.session_id) return;
    setLoading(true);
    setError(null);
    setConfirmProgress({ done: 0, total: preview.total || 0 });

    const accumulated = {
      imported: 0, skipped: 0, failed: 0, warnings: 0,
      imported_row_indices: [], skipped_row_indices: [],
      failed_details: [], warning_row_indices: [],
    };

    try {
      let offset = 0;
      let isComplete = false;
      while (!isComplete) {
        const batch = await taxApi.importConfirm({
          session_id: preview.session_id,
          duplicate_strategy: duplicateStrategy,
          per_row_actions: perRowActions,
          offset,
          batch_size: CONFIRM_BATCH_SIZE,
        });
        accumulated.imported += batch.imported;
        accumulated.skipped += batch.skipped;
        accumulated.failed += batch.failed;
        accumulated.warnings += batch.warnings;
        accumulated.imported_row_indices.push(...(batch.imported_row_indices || []));
        accumulated.skipped_row_indices.push(...(batch.skipped_row_indices || []));
        accumulated.failed_details.push(...(batch.failed_details || []));
        accumulated.warning_row_indices.push(...(batch.warning_row_indices || []));

        isComplete = batch.is_complete;
        offset = batch.next_offset ?? (offset + CONFIRM_BATCH_SIZE);
        setConfirmProgress({ done: Math.min(offset, batch.total_rows || preview.total || offset), total: batch.total_rows || preview.total || 0 });
      }
      setSummary(accumulated);
      setStep(5);
      if (onImported) onImported(accumulated);
    } catch (e) {
      setError(e.message || "Import failed. Please try again.");
    } finally {
      setLoading(false);
      setConfirmProgress(null);
    }
  };

  // ─── Render each step ───────────────────────────────────────────────────────

  const renderStep1 = () => (
    <div className="space-y-6">
      {/* Drag-and-drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleFileDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`relative border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center gap-3 cursor-pointer transition-all duration-200
          ${dragging ? "border-brand-300 bg-brand-50 scale-[1.01]"
                     : file ? "border-emerald-400 bg-emerald-50"
                             : "border-slate-300 hover:border-brand-400 hover:bg-brand-50/50 bg-slate-50"}`}
      >
        <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleFileSelect} />
        {file ? (
          <>
            <div className="w-14 h-14 rounded-2xl bg-emerald-100 flex items-center justify-center">
              <FileText size={28} className="text-emerald-700" />
            </div>
            <p className="font-semibold text-slate-800">{file.name}</p>
            <p className="text-sm text-slate-500">{(file.size / 1024).toFixed(1)} KB · Ready to process</p>
            <span className="text-xs text-emerald-700 font-medium bg-emerald-100 px-3 py-1 rounded-full">✓ File selected</span>
          </>
        ) : (
          <>
            <div className="w-14 h-14 rounded-2xl bg-brand-100 flex items-center justify-center">
              <Upload size={28} className="text-brand-600" />
            </div>
            <p className="font-semibold text-slate-700">Drag & drop your file here</p>
            <p className="text-sm text-slate-500">or click to browse — CSV and XLSX supported</p>
          </>
        )}
      </div>

      {/* Template download */}
      <div className="bg-brand-50/40 border border-brand-200 rounded-2xl p-4">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-xl bg-brand-100 flex items-center justify-center flex-shrink-0">
            <Download size={16} className="text-brand-600" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-brand-700 mb-1">Download Import Template</p>
            <p className="text-xs text-brand-600 mb-3">
              Templates include required fields, optional fields, and accepted values for each column.
            </p>
            <div className="flex gap-2">
              <button
                onClick={(e) => { e.stopPropagation(); handleDownloadTemplate("csv"); }}
                disabled={templateLoading}
                className="px-3 py-1.5 text-xs font-semibold border border-brand-200 text-brand-700 rounded-xl hover:bg-brand-100 transition-colors disabled:opacity-50"
              >
                {templateLoading ? <RefreshCw size={12} className="animate-spin inline mr-1" /> : null}
                CSV Template
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); handleDownloadTemplate("xlsx"); }}
                disabled={templateLoading}
                className="px-3 py-1.5 text-xs font-semibold border border-brand-200 text-brand-700 rounded-xl hover:bg-brand-100 transition-colors disabled:opacity-50"
              >
                Excel Template
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Duplicate strategy */}
      <div>
        <p className="text-sm font-semibold text-slate-700 mb-2">Duplicate Handling</p>
        <p className="text-xs text-slate-500 mb-2">A duplicate is any row whose Code matches an existing tax rate in your organization.</p>
        <div className="grid grid-cols-2 gap-2">
          {DUPLICATE_STRATEGIES.map(({ value, label, icon: Icon, desc }) => (
            <button
              key={value}
              onClick={() => setDuplicateStrategy(value)}
              className={`flex items-start gap-2 p-3 rounded-xl border text-left transition-all duration-150
                ${duplicateStrategy === value
                  ? "border-brand-300 bg-brand-50 ring-2 ring-brand-200"
                  : "border-slate-200 hover:border-brand-200 hover:bg-slate-50"}`}
            >
              <Icon size={16} className={duplicateStrategy === value ? "text-brand-600 mt-0.5" : "text-slate-500 mt-0.5"} />
              <div>
                <p className={`text-xs font-semibold ${duplicateStrategy === value ? "text-brand-700" : "text-slate-700"}`}>{label}</p>
                <p className="text-xs text-slate-500 mt-0.5">{desc}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Default-rate note */}
      <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-700">
        <Info size={14} className="flex-shrink-0 mt-0.5" />
        <span>Only one tax rate can be the default per currency. If your file marks more than one row as default for the same currency, the last one processed wins — earlier defaults (including existing ones) are automatically unset.</span>
      </div>
    </div>
  );

  const renderStep2 = () => {
    // Detect columns from preview (if available) or file rows parsed by wizard
    const detectedCols = preview?.rows?.[0] ? Object.keys(preview.rows[0].raw_data || {}) : [];
    return (
      <div className="space-y-4">
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 flex items-start gap-2">
          <Info size={16} className="text-blue-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-blue-700">
            Map each column from your file to the corresponding tax rate field.
            Columns mapped to <strong>Ignore</strong> will be skipped.
            Leave unmapped columns as-is — the system auto-detects common names.
          </p>
        </div>
        {loading ? (
          <div className="flex flex-col items-center justify-center py-10 gap-3 text-slate-500">
            <RefreshCw size={22} className="animate-spin text-brand-500" />
            <p className="text-sm">Reading columns from your file…</p>
          </div>
        ) : detectedCols.length === 0 ? (
          <p className="text-slate-500 text-sm text-center py-8">
            Couldn't detect columns from this file. You can still continue — unmapped columns
            will be auto-detected during validation.
          </p>
        ) : (
          <div className="overflow-auto max-h-72 rounded-xl border border-slate-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-left">
                  <th className="px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase">File Column</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase">Map to Field</th>
                </tr>
              </thead>
              <tbody>
                {detectedCols.map(col => (
                  <tr key={col} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-mono text-xs text-slate-700">{col}</td>
                    <td className="px-4 py-2">
                      <div className="relative">
                        <select
                          value={columnMap[col] || ""}
                          onChange={e => setColumnMap(prev => ({ ...prev, [col]: e.target.value }))}
                          className="w-full appearance-none bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand/30 pr-8"
                        >
                          <option value="">— Auto detect —</option>
                          {TAX_RATE_FIELDS.map(f => (
                            <option key={f.value} value={f.value}>{f.label}</option>
                          ))}
                        </select>
                        <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const renderStep3 = () => (
    <div className="flex flex-col items-center justify-center py-16 gap-4">
      <div className="relative">
        <div className="w-20 h-20 rounded-full border-4 border-brand-200 border-t-brand-600 animate-spin" />
        <div className="absolute inset-0 flex items-center justify-center">
          <Receipt size={28} className="text-brand-600" />
        </div>
      </div>
      <p className="text-lg font-bold text-slate-800">Validating your file…</p>
      <p className="text-sm text-slate-500 text-center max-w-xs">
        Checking required fields, validating rates/currencies/countries, and detecting duplicates.
      </p>
    </div>
  );

  const renderStep4 = () => {
    if (!preview) return null;
    const { total, valid, invalid, duplicate, warning, rows } = preview;
    const visibleRows = showAllRows ? rows : rows?.slice(0, 50);

    if (confirmProgress) {
      const pct = confirmProgress.total > 0 ? Math.round((confirmProgress.done / confirmProgress.total) * 100) : 0;
      return (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <div className="w-full max-w-sm">
            <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
              <span>Importing…</span>
              <span>{confirmProgress.done.toLocaleString()} / {confirmProgress.total.toLocaleString()}</span>
            </div>
            <div className="w-full h-2.5 rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full bg-gradient-to-r from-brand to-brand-hover rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
            </div>
          </div>
          <p className="text-sm text-slate-500 text-center max-w-xs">
            Processing your tax rates in batches of {CONFIRM_BATCH_SIZE.toLocaleString()} — please keep this window open.
          </p>
        </div>
      );
    }

    return (
      <div className="space-y-5">
        {/* Summary cards */}
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: "Total Rows",  value: total,     color: "bg-slate-100 text-slate-700", icon: Layers },
            { label: "Valid",       value: valid,     color: "bg-emerald-100 text-emerald-700", icon: CheckCircle },
            { label: "Duplicates",  value: duplicate, color: "bg-amber-100 text-amber-700",   icon: AlertTriangle },
            { label: "Errors",      value: invalid,   color: "bg-red-100 text-red-700",       icon: AlertCircle },
          ].map(({ label, value, color, icon: Icon }) => (
            <div key={label} className={`rounded-2xl p-3 ${color}`}>
              <div className="flex items-center gap-1.5 mb-1">
                <Icon size={14} />
                <span className="text-xs font-semibold">{label}</span>
              </div>
              <p className="text-2xl font-bold">{value}</p>
            </div>
          ))}
        </div>

        {warning > 0 && (
          <div className="flex items-center gap-2 p-3 bg-yellow-50 border border-yellow-200 rounded-xl text-xs text-yellow-700">
            <AlertTriangle size={14} className="flex-shrink-0" />
            <span>{warning} rows have warnings — they will still be imported. Review them below.</span>
          </div>
        )}

        {invalid > 0 && (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700">
            <AlertCircle size={14} className="flex-shrink-0" />
            <span>{invalid} rows have errors and will be skipped. Fix these in your file and re-import.</span>
          </div>
        )}

        {/* Per-row table */}
        <div className="rounded-2xl border border-slate-200 overflow-hidden">
          <div className="bg-slate-50 px-4 py-2.5 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Row Preview</span>
            {rows?.length > 50 && (
              <button
                onClick={() => setShowAllRows(!showAllRows)}
                className="text-xs text-brand-600 hover:underline"
              >
                {showAllRows ? "Show less" : `Show all ${rows.length} rows`}
              </button>
            )}
          </div>
          <div className="overflow-auto max-h-56">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 bg-white sticky top-0">
                  <th className="px-3 py-2 text-left text-slate-500 font-semibold">#</th>
                  <th className="px-3 py-2 text-left text-slate-500 font-semibold">Name</th>
                  <th className="px-3 py-2 text-left text-slate-500 font-semibold">Code</th>
                  <th className="px-3 py-2 text-left text-slate-500 font-semibold">Rate</th>
                  <th className="px-3 py-2 text-left text-slate-500 font-semibold">Status</th>
                  {duplicate > 0 && duplicateStrategy === "review" && (
                    <th className="px-3 py-2 text-left text-slate-500 font-semibold">Action</th>
                  )}
                  <th className="px-3 py-2 text-left text-slate-500 font-semibold">Issues</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows?.map((row) => (
                  <tr key={row.row_index} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-2 text-slate-500">{row.row_index}</td>
                    <td className="px-3 py-2 text-slate-700 font-medium max-w-[120px] truncate">
                      {row.mapped_data?.name || row.raw_data?.Name || row.raw_data?.name || "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-slate-600">
                      {row.mapped_data?.code || row.raw_data?.Code || row.raw_data?.code || "—"}
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {row.mapped_data?.rate != null ? `${row.mapped_data.rate}%` : "—"}
                    </td>
                    <td className="px-3 py-2"><StatusPill status={row.status} /></td>
                    {duplicate > 0 && duplicateStrategy === "review" && (
                      <td className="px-3 py-2">
                        {row.status === "duplicate" ? (
                          <select
                            value={perRowActions[row.row_index] || "skip"}
                            onChange={e => setPerRowActions(prev => ({ ...prev, [row.row_index]: e.target.value }))}
                            className="border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-brand-300"
                          >
                            <option value="skip">Skip</option>
                            <option value="overwrite">Update Existing</option>
                            <option value="create_copy">Create New</option>
                          </select>
                        ) : <span className="text-slate-300">—</span>}
                      </td>
                    )}
                    <td className="px-3 py-2 text-slate-500 max-w-[200px]">
                      {[...(row.errors || []), ...(row.warnings || [])].slice(0, 2).join("; ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {valid === 0 && duplicate === 0 && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-center">
            <p className="text-sm font-semibold text-red-700 mb-1">No valid rows to import</p>
            <p className="text-xs text-red-600">Please fix the errors in your file and try again.</p>
          </div>
        )}
      </div>
    );
  };

  const renderStep5 = () => {
    if (!summary) return null;
    const success = summary.imported > 0;
    return (
      <div className="flex flex-col items-center text-center py-6 gap-5">
        <div className={`w-20 h-20 rounded-full flex items-center justify-center shadow-xl
          ${success ? "bg-gradient-to-br from-emerald-400 to-emerald-600" : "bg-gradient-to-br from-slate-400 to-slate-600"}`}>
          {success ? <CheckCircle size={40} className="text-white" /> : <AlertCircle size={40} className="text-white" />}
        </div>
        <div>
          <h3 className="text-xl font-bold text-slate-800 mb-1">
            {success ? "Import Complete!" : "Import Finished with Issues"}
          </h3>
          <p className="text-sm text-slate-500">
            {success ? `${summary.imported} tax rate${summary.imported !== 1 ? "s" : ""} imported successfully.` : "No new records were created."}
          </p>
        </div>

        {/* Result grid */}
        <div className="grid grid-cols-4 gap-3 w-full">
          {[
            { label: "Imported", value: summary.imported,  color: "from-emerald-50 to-emerald-100 border-emerald-200 text-emerald-700" },
            { label: "Skipped",  value: summary.skipped,   color: "from-slate-50 to-slate-100 border-slate-200 text-slate-600"     },
            { label: "Failed",   value: summary.failed,    color: "from-red-50 to-red-100 border-red-200 text-red-700"              },
            { label: "Warnings", value: summary.warnings,  color: "from-yellow-50 to-yellow-100 border-yellow-200 text-yellow-700"  },
          ].map(({ label, value, color }) => (
            <div key={label} className={`bg-gradient-to-b ${color} border rounded-2xl py-4 flex flex-col items-center`}>
              <span className="text-2xl font-bold">{value}</span>
              <span className="text-xs font-semibold mt-1 opacity-80">{label}</span>
            </div>
          ))}
        </div>

        {/* Failed detail */}
        {summary.failed_details?.length > 0 && (
          <div className="w-full max-h-36 overflow-auto bg-red-50 border border-red-200 rounded-xl p-3 text-left">
            <p className="text-xs font-semibold text-red-700 mb-2">Failed Rows:</p>
            {summary.failed_details.map((fd, i) => (
              <p key={i} className="text-xs text-red-600 mb-0.5">Row {fd.row}: {fd.error}</p>
            ))}
          </div>
        )}

        <div className="flex gap-3">
          {summary.failed_details?.length > 0 && (
            <button
              onClick={handleDownloadErrorReport}
              className="flex items-center gap-1.5 px-6 py-2.5 border border-red-200 text-red-700 bg-red-50 rounded-xl text-sm font-semibold hover:bg-red-100 transition-colors"
            >
              <Download size={16} /> Download Error Report
            </button>
          )}
          <button
            onClick={onClose}
            className="px-6 py-2.5 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-semibold hover:shadow-lg transition-shadow"
          >
            Done
          </button>
        </div>
      </div>
    );
  };

  // ─── Navigation ──────────────────────────────────────────────────────────────
  const canProceed = () => {
    if (step === 1) return !!file;
    if (step === 2) return true;
    // Duplicates are actionable too (skip/overwrite/create copy per the
    // chosen strategy) -- only block when there's truly nothing to do with
    // any row in the file.
    if (step === 4) return preview && (preview.valid > 0 || preview.duplicate > 0);
    return true;
  };

  const handleNext = async () => {
    setError(null);
    if (step === 1) {
      setStep(2);
      // Fetch the file's columns for mapping (advance: false — stay on step 2).
      // Skipped if we already have them (e.g. user went Back then Next again
      // without changing the file — acceptFile() clears `preview` on a new file).
      if (!preview) await handlePreview(false);
      return;
    }
    if (step === 2) {
      setStep(3);
      await handlePreview();
      return;
    }
    if (step === 4) {
      await handleConfirm();
      return;
    }
  };

  const handleBack = () => {
    setError(null);
    if (step === 2) setStep(1);
    else if (step === 3) setStep(2);
    else if (step === 4) setStep(2);
  };

  const nextLabel = () => {
    if (step === 2) return loading ? "Validating…" : "Validate & Preview";
    if (step === 4) return loading ? "Importing…" : `Import ${(preview?.valid || 0) + (preview?.duplicate || 0)} Rates`;
    if (step === 5) return null;
    return "Next";
  };

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden"
        style={{ boxShadow: "0 25px 60px rgba(0,0,0,0.2), 0 0 0 1px rgba(0,0,0,0.05)" }}
      >
        {/* Header */}
        <div className="p-6 pb-0 bg-gradient-to-r from-brand to-brand-hover text-white flex items-center justify-between rounded-t-3xl">
          <div>
            <h2 className="text-lg font-bold">Import Tax Rates</h2>
            <p className="text-brand-100 text-sm mt-0.5">Upload CSV or XLSX to bulk-import your organization's tax rates</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-2 rounded-xl hover:bg-white/20 transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Step bar */}
        <div className="px-6 pt-6">
          <StepBar current={step} />
        </div>

        {/* Error */}
        {error && (
          <div className="mx-6 flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            <AlertCircle size={16} className="flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {step === 1 && renderStep1()}
          {step === 2 && renderStep2()}
          {step === 3 && renderStep3()}
          {step === 4 && renderStep4()}
          {step === 5 && renderStep5()}
        </div>

        {/* Footer nav */}
        {step !== 5 && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100 bg-slate-50/80 rounded-b-3xl">
            <button
              onClick={step === 1 ? onClose : handleBack}
              disabled={loading || step === 3}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl transition-colors disabled:opacity-40"
            >
              {step === 1 ? <X size={16} /> : <ArrowLeft size={16} />}
              {step === 1 ? "Cancel" : "Back"}
            </button>

            <div className="flex items-center gap-3">
              {step === 4 && preview?.valid === 0 && preview?.duplicate === 0 && (
                <span className="text-xs text-red-600 font-medium">No valid rows to import</span>
              )}
              {nextLabel() && (
                <button
                  onClick={handleNext}
                  disabled={loading || !canProceed() || step === 3}
                  className="flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-semibold hover:shadow-lg hover:shadow-brand-200 transition-all disabled:opacity-50"
                >
                  {loading ? <RefreshCw size={16} className="animate-spin" /> : null}
                  {nextLabel()}
                  {!loading && step !== 4 && <ArrowRight size={16} />}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
