// ZB-SA-CMD-003 Domain B containment: while a privileged tenant-access
// session is active, ALL data exports are suppressed app-wide. The flag is
// owned by CommandCenterContext (the single source of privileged-session
// truth) and enforced here at the shared download choke point. Page-local
// ad-hoc blob downloads that bypass these helpers are a known residual gap
// tracked for the follow-up sweep.
let _suppressionReason = null;

export function setExportSuppressed(reason) {
  _suppressionReason = reason || null;
}

export function getExportSuppression() {
  return _suppressionReason;
}

export function assertExportsAllowed() {
  if (_suppressionReason) {
    throw new Error(`Exports disabled: ${_suppressionReason}`);
  }
}

export function downloadJSON(data, filename) {
  assertExportsAllowed();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadCSV(rows, headers, filename) {
  assertExportsAllowed();
  const csv = [
    headers.join(","),
    ...rows.map((r) => r.map((v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(",")),
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// `rows`/`headers` here are always data this app already fetched from its
// own API (report/export flows) — this function never parses a user-
// uploaded file, so it's not on the untrusted-input path. The `xlsx`
// dependency is installed from SheetJS's own CDN tarball (package.json),
// not the stale/vulnerable npm-registry release, so no extra guard is
// needed here beyond that. Untrusted spreadsheet parsing (product/customer
// import) happens server-side via openpyxl — see product_import_service.py
// / customer_import_service.py for the size/row-count limits guarding that.
export async function downloadExcel(rows, headers, filename, sheetName = "Sheet1") {
  assertExportsAllowed();
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}

export function filterByDateRange(items, dateField, range, customStart, customEnd) {
  if (!range || range === "all_time") return items;
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let start, end;
  switch (range) {
    case "today": start = startOfDay; end = now; break;
    case "yesterday": { const y = new Date(startOfDay); y.setDate(y.getDate() - 1); start = y; end = startOfDay; break; }
    case "last_7_days": { start = new Date(startOfDay); start.setDate(start.getDate() - 7); end = now; break; }
    case "last_30_days": { start = new Date(startOfDay); start.setDate(start.getDate() - 30); end = now; break; }
    case "this_month": start = new Date(now.getFullYear(), now.getMonth(), 1); end = now; break;
    case "last_month": start = new Date(now.getFullYear(), now.getMonth() - 1, 1); end = new Date(now.getFullYear(), now.getMonth(), 0); break;
    case "this_quarter": { const q = Math.floor(now.getMonth() / 3); start = new Date(now.getFullYear(), q * 3, 1); end = now; break; }
    case "this_year": start = new Date(now.getFullYear(), 0, 1); end = now; break;
    case "custom": start = customStart ? new Date(customStart) : new Date(0); end = customEnd ? new Date(customEnd + "T23:59:59") : now; break;
    default: return items;
  }
  return items.filter((item) => {
    const val = item[dateField];
    if (!val) return false;
    const d = new Date(val);
    return d >= start && d <= end;
  });
}

export function calculateAging(items, dateField, amountField = "amount", currencyField = "currency") {
  const now = new Date();
  const buckets = { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, over_90: 0 };
  items.forEach((item) => {
    const due = new Date(item[dateField]);
    const diffDays = Math.floor((now - due) / 86400000);
    const amt = Number(item[amountField]) || 0;
    if (diffDays <= 0) buckets.current += amt;
    else if (diffDays <= 30) buckets.days_1_30 += amt;
    else if (diffDays <= 60) buckets.days_31_60 += amt;
    else if (diffDays <= 90) buckets.days_61_90 += amt;
    else buckets.over_90 += amt;
  });
  return buckets;
}
