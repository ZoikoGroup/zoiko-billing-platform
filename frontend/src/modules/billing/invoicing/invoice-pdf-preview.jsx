import { Printer, Download } from "lucide-react";
import { Button } from "../../../components/billing-ui";
import { formatDisplayCurrency, formatDisplayDate } from "../../../utils/billing-helpers";
import React from "react";

// pdfmake + vfs_fonts are lazy-loaded inside generatePDF() so the ~1.74 MB
// font bundle is only fetched when the user actually clicks "Download PDF",
// not when they navigate to this page.

// Single source of truth for reading organization branding out of the
// BillingConfiguration API response — the org's own address/contact fields
// are address_line1/2, city, state, postal_code, country, billing_email,
// billing_phone (NOT "address"/"email"/"phone", which don't exist on the
// response and previously always rendered blank here).
function getOrgBranding(orgSettings = {}) {
  const name = orgSettings.company_name || orgSettings.organization_name || "Your Company";
  const address = [
    orgSettings.address_line1,
    orgSettings.address_line2,
    [orgSettings.city, orgSettings.state, orgSettings.postal_code].filter(Boolean).join(", "),
    orgSettings.country,
  ].filter(Boolean).join("\n");
  const email = orgSettings.billing_email || "";
  const phone = orgSettings.billing_phone || "";
  const website = orgSettings.website || "";
  const taxRegistration = orgSettings.gst_number || orgSettings.vat_number || orgSettings.business_registration_number || "";
  const logo = orgSettings.invoice_logo_url || orgSettings.logo_url || null;
  return { name, address, email, phone, website, taxRegistration, logo };
}

async function generatePDF({ form, lineItems, totals, orgSettings, customerName, billingAddress, shippingAddress }) {
  const pdfMakeModule = await import("pdfmake/build/pdfmake");
  const pdfFontsModule = await import("pdfmake/build/vfs_fonts");
  const pdfMake = pdfMakeModule.default;
  const pdfFonts = pdfFontsModule.default;
  pdfMake.vfs = pdfFonts.pdfMake ? pdfFonts.pdfMake.vfs : pdfFonts;

  const { name: orgName, address: orgAddress, email: orgEmail, phone: orgPhone, website: orgWebsite, taxRegistration: orgTaxRegistration } = getOrgBranding(orgSettings);
  const currency = form.currency || orgSettings.default_currency;
  const invoiceNumber = form.invoice_number || (orgSettings?.auto_generate_invoice_number ? "Auto-generated on save" : "Draft Invoice");
  const showTaxBreakdown = orgSettings.show_tax_breakdown !== false;
  const showDiscount = orgSettings.show_discount !== false;
  const invoiceFooter = orgSettings.invoice_footer || "";
  const invoiceTerms = orgSettings.invoice_terms_and_conditions || "";
  const invoiceNotes = form.notes || orgSettings.invoice_notes || "";

  const fmt = (v) => {
    if (v == null || v === "") return "—";
    const num = Number(v);
    if (Number.isNaN(num)) return "—";
    return `${currency} ${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const headerSection = [
    { text: "INVOICE", style: "title" },
    { text: invoiceNumber, style: "subtitle", margin: [0, 2, 0, 10] },
  ];

  const companyInfo = [
    { text: orgName, style: "companyName" },
    orgAddress ? { text: orgAddress, style: "companyDetail" } : null,
    orgEmail ? { text: orgEmail, style: "companyDetail" } : null,
    orgPhone ? { text: orgPhone, style: "companyDetail" } : null,
    orgWebsite ? { text: orgWebsite, style: "companyDetail" } : null,
    orgTaxRegistration ? { text: orgTaxRegistration, style: "companyDetail" } : null,
  ].filter(Boolean);

  const datesInfo = [
    { text: `Invoice Date: ${form.issue_date ? formatDisplayDate(form.issue_date) : "—" }`, style: "dateLabel" },
    { text: `Due Date: ${form.due_date ? formatDisplayDate(form.due_date) : "—" }`, style: "dateLabel" },
    form.payment_terms ? { text: `Terms: ${form.payment_terms.replace(/_/g, " ")}`, style: "dateLabel" } : null,
    form.po_number ? { text: `PO Number: ${form.po_number}`, style: "dateLabel" } : null,
  ].filter(Boolean);

  const billToSection = [
    { text: "Bill To", style: "sectionLabel" },
    { text: customerName || "—", style: "customerName" },
    billingAddress ? { text: billingAddress, style: "addressDetail" } : null,
  ].filter(Boolean);

  const lineItemHeader = [
    { text: "#", style: "tableHeader" },
    { text: "Description", style: "tableHeader" },
    { text: "Qty", style: "tableHeaderRight" },
    { text: "Rate", style: "tableHeaderRight" },
  ];
  if (showTaxBreakdown) lineItemHeader.push({ text: "Tax %", style: "tableHeaderRight" });
  lineItemHeader.push({ text: "Amount", style: "tableHeaderRight" });

  const lineItemRows = lineItems.map((item, idx) => {
    const qty = Number(item.quantity) || 0;
    const rate = Number(item.unit_price) || 0;
    const taxPct = Number(item.tax_percentage) || 0;
    const lineTotal = Number(item.total) || 0;
    const row = [
      { text: String(idx + 1), style: "tableCell" },
      { text: [item.description || `Item ${idx + 1}`, item.sku ? { text: `SKU: ${item.sku}`, style: "skuText" } : ""], style: "tableCell" },
      { text: String(qty), style: "tableCellRight" },
      { text: fmt(rate), style: "tableCellRight" },
    ];
    if (showTaxBreakdown) row.push({ text: taxPct > 0 ? `${taxPct}%` : "—", style: "tableCellRight" });
    row.push({ text: fmt(lineTotal), style: "tableCellRight" });
    return row;
  });

  const tableBody = [lineItemHeader, ...lineItemRows];

  const totalsBody = [];
  totalsBody.push([{ text: "Subtotal", style: "totalsLabel" }, { text: fmt(totals.subtotal || 0), style: "totalsValue" }]);
  if (totals.discount > 0 && showDiscount) {
    totalsBody.push([{ text: "Discount", style: "totalsLabel" }, { text: "-" + fmt(totals.discount), style: "totalsValueRed" }]);
  }
  if (totals.tax > 0 && showTaxBreakdown) {
    totalsBody.push([{ text: "Tax", style: "totalsLabel" }, { text: fmt(totals.tax), style: "totalsValue" }]);
  }
  if (totals.shipping > 0) {
    totalsBody.push([{ text: "Shipping", style: "totalsLabel" }, { text: fmt(totals.shipping), style: "totalsValue" }]);
  }
  if (totals.roundOff !== 0) {
    totalsBody.push([{ text: "Round Off", style: "totalsLabel" }, { text: fmt(totals.roundOff), style: "totalsValue" }]);
  }
  totalsBody.push([{ text: "Total", style: "totalsGrandLabel" }, { text: fmt(totals.grandTotal || 0), style: "totalsGrandValue" }]);

  var taxColWidth = showTaxBreakdown ? ["auto"] : [];
  var lineTableWidths = ["auto", "*", "auto", "auto"].concat(taxColWidth).concat(["auto"]);
  var lineTableBlock = lineItems.length > 0 ? {
    table: { body: tableBody, widths: lineTableWidths },
    layout: "lightHorizontalLines",
    margin: [0, 0, 0, 10],
  } : { text: "No line items", style: "noData", margin: [0, 10, 0, 10] };

  var totalsTable = {
    body: totalsBody,
    widths: [100, "*"],
  };

  var totalsColBlock = { width: "*", text: "" };
  var totalsRightBlock = { width: 200, table: totalsTable, layout: "noBorders" };
  var totalsSection = [{ columns: [totalsColBlock, totalsRightBlock], margin: [0, 10, 0, 10] }];

  var content = [];
  content.push(headerSection);
  content.push({ columns: [companyInfo, { text: datesInfo, alignment: "right" }], columnGap: 20, margin: [0, 10, 0, 10] });
  content.push({ columns: [billToSection, ""], columnGap: 20, margin: [0, 0, 0, 10] });
  content.push(lineTableBlock);
  content.push(totalsSection);

  if (invoiceNotes) {
    content.push({ text: [{ text: "Notes\n", style: "sectionLabel" }, { text: invoiceNotes, style: "bodyText" }], margin: [0, 10, 0, 5] });
  }
  if (invoiceTerms) {
    content.push({ text: [{ text: "Terms & Conditions\n", style: "sectionLabel" }, { text: invoiceTerms, style: "bodyText" }], margin: [0, 5, 0, 5] });
  }

  const docDefinition = {
    content,
    styles: {
      title: { fontSize: 22, bold: true, color: "#FF5500", margin: [0, 0, 0, 2] },
      subtitle: { fontSize: 11, color: "#6b7280" },
      companyName: { fontSize: 14, bold: true, color: "#1e293b" },
      companyDetail: { fontSize: 9, color: "#6b7280", margin: [0, 1, 0, 0] },
      dateLabel: { fontSize: 9, color: "#6b7280", alignment: "right", margin: [0, 1, 0, 0] },
      sectionLabel: { fontSize: 9, bold: true, color: "#6b7280", margin: [0, 0, 0, 4] },
      customerName: { fontSize: 11, bold: true, color: "#1e293b" },
      addressDetail: { fontSize: 9, color: "#6b7280", margin: [0, 2, 0, 0] },
      tableHeader: { fontSize: 8, bold: true, color: "#6b7280", margin: [0, 4, 0, 4] },
      tableHeaderRight: { fontSize: 8, bold: true, color: "#6b7280", alignment: "right", margin: [0, 4, 0, 4] },
      tableCell: { fontSize: 9, color: "#1e293b", margin: [0, 3, 0, 3] },
      tableCellRight: { fontSize: 9, color: "#1e293b", alignment: "right", margin: [0, 3, 0, 3] },
      skuText: { fontSize: 7, color: "#9ca3af" },
      totalsLabel: { fontSize: 9, color: "#6b7280", margin: [0, 2, 0, 2] },
      totalsValue: { fontSize: 9, bold: true, color: "#1e293b", alignment: "right", margin: [0, 2, 0, 2] },
      totalsValueRed: { fontSize: 9, bold: true, color: "#dc2626", alignment: "right", margin: [0, 2, 0, 2] },
      totalsGrandLabel: { fontSize: 11, bold: true, color: "#1e293b", margin: [0, 4, 0, 4] },
      totalsGrandValue: { fontSize: 13, bold: true, color: "#FF7A00", alignment: "right", margin: [0, 4, 0, 4] },
      bodyText: { fontSize: 9, color: "#6b7280", margin: [0, 2, 0, 0] },
      noData: { fontSize: 9, color: "#9ca3af", italics: true },
    },
    defaultStyle: { font: "Roboto" },
    footer: (currentPage, pageCount) => ({
      columns: [
        { text: invoiceFooter || `Generated by ${orgName} — Zoiko Billing`, fontSize: 7, color: "#9ca3af", margin: [40, 0, 0, 0] },
        { text: `Page ${currentPage} of ${pageCount}`, fontSize: 7, color: "#9ca3af", alignment: "right", margin: [0, 0, 40, 0] },
      ],
      margin: [0, 10, 0, 10],
    }),
  };

  pdfMake.createPdf(docDefinition).download(`${invoiceNumber.replace(/[^a-zA-Z0-9-_]/g, "_") || "invoice"}.pdf`);
}

export default function InvoicePDFPreview({
  form,
  lineItems = [],
  totals = {},
  orgSettings = {},
  customerName = "",
  billingAddress = "",
  shippingAddress = "",
}) {
  const { name: orgName, address: orgAddress, email: orgEmail, phone: orgPhone, website: orgWebsite, taxRegistration: orgTaxRegistration, logo: orgLogo } = getOrgBranding(orgSettings);
  const currency = form.currency || orgSettings.default_currency;
  const invoiceNumber = form.invoice_number || (orgSettings?.auto_generate_invoice_number ? "Auto-generated on save" : "Draft Invoice");
  const showTaxBreakdown = orgSettings.show_tax_breakdown !== false;
  const showDiscount = orgSettings.show_discount !== false;
  const invoiceFooter = orgSettings.invoice_footer || "";
  const invoiceTerms = orgSettings.invoice_terms_and_conditions || "";
  const invoiceNotes = form.notes || orgSettings.invoice_notes || "";
  const [downloading, setDownloading] = React.useState(false);
  const [downloadError, setDownloadError] = React.useState(null);

  const handleDownloadPDF = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await generatePDF({ form, lineItems, totals, orgSettings, customerName, billingAddress, shippingAddress });
    } catch (err) {
      setDownloadError(err?.message || "Failed to generate PDF");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">Invoice Preview</h3>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            icon={Download}
            onClick={handleDownloadPDF}
            loading={downloading}
          >
            {downloading ? "Generating…" : "Download PDF"}
          </Button>
          <Button variant="secondary" size="sm" icon={Printer} onClick={() => window.print()}>
            Print
          </Button>
        </div>
      </div>
      {downloadError && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
          {downloadError}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden print:shadow-none print:border-none">
        <div className="bg-gradient-to-r from-brand to-brand-hover px-8 py-6">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight">INVOICE</h1>
              <p className="text-white/80 text-sm mt-1">
                {invoiceNumber}
              </p>
            </div>
            {orgLogo ? (
              <img src={orgLogo} alt={orgName} className="h-12 max-w-45 w-auto object-contain" />
            ) : (
              <div className="text-right text-white">
                <p className="font-bold text-lg">{orgName}</p>
                {orgAddress && <p className="text-white/80 text-xs mt-0.5 whitespace-pre-line">{orgAddress}</p>}
                {orgEmail && <p className="text-white/80 text-xs">{orgEmail}</p>}
                {orgPhone && <p className="text-white/80 text-xs">{orgPhone}</p>}
                {orgWebsite && <p className="text-white/80 text-xs">{orgWebsite}</p>}
                {orgTaxRegistration && <p className="text-white/80 text-xs">{orgTaxRegistration}</p>}
              </div>
            )}
          </div>
        </div>

        <div className="px-8 py-6">
          <div className="grid grid-cols-2 gap-8 mb-8">
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Bill To</p>
              <p className="text-sm font-bold text-slate-800">{customerName || "—"}</p>
              {billingAddress && (
                <p className="text-xs text-slate-600 mt-1 whitespace-pre-line">{billingAddress}</p>
              )}
            </div>
            <div className="text-right">
              <div className="space-y-1">
                <div className="flex justify-end text-xs">
                  <span className="text-slate-500 w-24">Invoice Date:</span>
                  <span className="font-medium text-slate-700 w-32 text-right">
                    {form.issue_date ? formatDisplayDate(form.issue_date) : "—"}
                  </span>
                </div>
                <div className="flex justify-end text-xs">
                  <span className="text-slate-500 w-24">Due Date:</span>
                  <span className="font-medium text-slate-700 w-32 text-right">
                    {form.due_date ? formatDisplayDate(form.due_date) : "—"}
                  </span>
                </div>
                <div className="flex justify-end text-xs">
                  <span className="text-slate-500 w-24">Terms:</span>
                  <span className="font-medium text-slate-700 w-32 text-right">
                    {form.payment_terms?.replace(/_/g, " ") || "—"}
                  </span>
                </div>
                {form.po_number && (
                  <div className="flex justify-end text-xs">
                    <span className="text-slate-500 w-24">PO Number:</span>
                    <span className="font-medium text-slate-700 w-32 text-right">{form.po_number}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {shippingAddress && (
            <div className="mb-6">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Ship To</p>
              <p className="text-xs text-slate-600 whitespace-pre-line">{shippingAddress}</p>
            </div>
          )}

          <div className="overflow-x-auto mb-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-slate-200">
                  <th className="text-left py-2 text-xs font-semibold text-slate-500 uppercase">#</th>
                  <th className="text-left py-2 text-xs font-semibold text-slate-500 uppercase">Description</th>
                  <th className="text-right py-2 text-xs font-semibold text-slate-500 uppercase">Qty</th>
                  <th className="text-right py-2 text-xs font-semibold text-slate-500 uppercase">Rate</th>
                  <th className="text-right py-2 text-xs font-semibold text-slate-500 uppercase">Tax %</th>
                  <th className="text-right py-2 text-xs font-semibold text-slate-500 uppercase">Amount</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-slate-400 text-xs">
                      No line items added
                    </td>
                  </tr>
                ) : (
                  lineItems.map((item, idx) => {
                    const qty = Number(item.quantity) || 0;
                    const rate = Number(item.unit_price) || 0;
                    const taxPct = Number(item.tax_percentage) || 0;
                    const lineTotal = Number(item.total) || 0;
                    return (
                      <tr key={idx} className="border-b border-slate-100">
                        <td className="py-2.5 text-slate-400 text-xs">{idx + 1}</td>
                        <td className="py-2.5">
                          <p className="font-medium text-slate-800">{item.description || `Item ${idx + 1}`}</p>
                          {item.sku && <p className="text-xs text-slate-400 mt-0.5">SKU: {item.sku}</p>}
                        </td>
                        <td className="py-2.5 text-right text-xs text-slate-600">{qty}</td>
                        <td className="py-2.5 text-right text-xs text-slate-600">
                          {formatDisplayCurrency(rate, "—", currency)}
                        </td>
                        <td className="py-2.5 text-right text-xs text-slate-600">
                          {taxPct > 0 ? `${taxPct}%` : "—"}
                        </td>
                        <td className="py-2.5 text-right text-xs font-medium text-slate-800">
                          {formatDisplayCurrency(lineTotal, "—", currency)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end">
            <div className="w-64 space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-slate-500">Subtotal</span>
                <span className="font-medium text-slate-700">{formatDisplayCurrency(totals.subtotal || 0, "—", currency)}</span>
              </div>
              {(totals.discount || 0) > 0 && showDiscount && (
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Discount</span>
                  <span className="font-medium text-red-600">-{formatDisplayCurrency(totals.discount, "—", currency)}</span>
                </div>
              )}
              {(totals.tax || 0) > 0 && showTaxBreakdown && (
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Tax</span>
                  <span className="font-medium text-slate-700">{formatDisplayCurrency(totals.tax, "—", currency)}</span>
                </div>
              )}
              {(totals.shipping || 0) > 0 && (
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Shipping</span>
                  <span className="font-medium text-slate-700">{formatDisplayCurrency(totals.shipping, "—", currency)}</span>
                </div>
              )}
              {(totals.roundOff || 0) !== 0 && (
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Round Off</span>
                  <span className="font-medium text-slate-700">{formatDisplayCurrency(totals.roundOff, "—", currency)}</span>
                </div>
              )}
              <div className="border-t-2 border-slate-200 pt-2 flex justify-between">
                <span className="font-bold text-slate-800">Total</span>
                <span className="font-bold text-lg text-brand-600">
                  {formatDisplayCurrency(totals.grandTotal || 0, "—", currency)}
                </span>
              </div>
              <div className="text-right text-xs text-slate-400 mt-1">
                {currency}
              </div>
              {lineItems.some(item => item.exchange_rate && item.original_currency && item.original_currency !== currency) && (
                <div className="mt-2 pt-2 border-t border-slate-100 space-y-1">
                  <div className="text-xs font-semibold text-slate-500 uppercase">Exchange Rate Info</div>
                  {(() => {
                    const firstConverted = lineItems.find(item => item.exchange_rate && item.original_currency && item.original_currency !== currency);
                    return firstConverted ? (
                      <>
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-500">Source</span>
                          <span className="text-slate-600">{firstConverted.exchange_rate_source || 'ExchangeRate-API'}</span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-500">Rate ({firstConverted.original_currency}/{currency})</span>
                          <span className="text-slate-600">{firstConverted.exchange_rate?.toFixed(6)}</span>
                        </div>
                        {firstConverted.exchange_rate_timestamp && (
                          <div className="flex justify-between text-xs">
                            <span className="text-slate-500">Fetched</span>
                            <span className="text-slate-600">{new Date(firstConverted.exchange_rate_timestamp).toLocaleString()}</span>
                          </div>
                        )}
                      </>
                    ) : null;
                  })()}
                </div>
              )}
            </div>
          </div>

          {invoiceNotes && (
            <div className="mt-8 pt-4 border-t border-slate-100">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Notes</p>
              <p className="text-xs text-slate-600 whitespace-pre-line">{invoiceNotes}</p>
            </div>
          )}

          {invoiceTerms && (
            <div className="mt-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Terms &amp; Conditions</p>
              <p className="text-xs text-slate-600 whitespace-pre-line">{invoiceTerms}</p>
            </div>
          )}

          <div className="mt-8 pt-4 border-t border-slate-100 text-center">
            {invoiceFooter ? (
              <p className="text-xs text-slate-400 whitespace-pre-line">{invoiceFooter}</p>
            ) : (
              <p className="text-xs text-slate-400">Generated by {orgName} — Zoiko Billing</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
