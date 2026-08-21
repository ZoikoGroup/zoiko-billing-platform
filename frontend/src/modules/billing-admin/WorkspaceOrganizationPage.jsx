import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { settingsApi } from "../../service/billingService";
import { getOrganizationDetails } from "../../service/orgAdminService";
import WorkspaceHeader from "./WorkspaceHeader";
import { normalizeOrgName, formatFiscalYearRange } from "./workspace-format";
import { Building2, Mail, MapPin, Landmark, CalendarDays, Coins, FileText, ShieldCheck, Loader2, Users, ArrowRight, ScrollText } from "lucide-react";

function Field({ label, value }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">{label}</p>
      <p className="text-sm font-medium text-slate-700">{value || "—"}</p>
    </div>
  );
}

function Card({ title, icon: Icon, children }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
      <div className="flex items-center gap-2.5 mb-5 pb-4 border-b border-slate-100">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-linear-to-r from-brand to-brand-hover text-white shadow-sm">
          <Icon className="w-4 h-4" />
        </div>
        <h3 className="text-lg font-bold text-slate-800">{title}</h3>
      </div>
      <div className="grid gap-x-6 gap-y-4 grid-cols-1 sm:grid-cols-2">{children}</div>
    </div>
  );
}

function StatTile({ label, value, sub }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50/60 p-4 text-center">
      <p className="text-2xl font-bold text-slate-800">{value}</p>
      <p className="text-[11px] font-medium text-slate-500 mt-1">{label}</p>
      {sub && <p className="text-[10px] text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

function StatusPill({ status }) {
  const active = status === "active";
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium ${active ? "bg-emerald-50 text-emerald-700" : "bg-gray-50 text-gray-600"}`}>
      <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${active ? "bg-emerald-500" : "bg-gray-400"}`} />
      {status || "unknown"}
    </span>
  );
}

export default function WorkspaceOrganizationPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [config, setConfig] = useState(null);
  const [org, setOrg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [c, o] = await Promise.allSettled([
          settingsApi.getConfig(),
          getOrganizationDetails(),
        ]);
        if (cancelled) return;
        if (c.status === "fulfilled") setConfig(c.value);
        if (o.status === "fulfilled") setOrg(o.value);
      } catch (err) {
        if (!cancelled) setError(err?.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="p-4 sm:p-6 lg:p-8" style={{ background: "#ffffff", minHeight: "calc(100vh - 4rem)" }}>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-brand" />
        </div>
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

  const companyName = config?.company_name || org?.name || "";
  const orgCode = org?.code || "";
  const adminName = org?.admin_name || "";
  const adminEmail = org?.admin_email || config?.billing_email || "";
  const status = org?.status || "active";
  const totalCustomers = org?.total_customers ?? 0;
  const activeCustomers = org?.active_customers ?? 0;
  const billingAdmins = org?.billing_admins ?? 0;

  return (
    <div className="p-4 sm:p-6 lg:p-8" style={{ background: "#ffffff", minHeight: "calc(100vh - 4rem)" }}>
      <WorkspaceHeader
        title="Organization Profile"
        subtitle="Read-only billing administration view"
        icon={Building2}
        organization={org || config}
      />

      <div className="rounded-3xl border border-slate-200 bg-white p-6 mb-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <div className="flex items-center gap-4 mb-4">
          <div className="w-14 h-14 rounded-2xl bg-linear-to-br from-brand to-brand-hover flex items-center justify-center text-white shrink-0">
            <Building2 className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-800">{normalizeOrgName(companyName) || "Organization"}</h2>
            <div className="flex items-center gap-2 mt-1">
              {orgCode && <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-100 text-slate-600">{orgCode}</span>}
              <StatusPill status={status} />
            </div>
          </div>
        </div>
        {adminName && (
          <div className="flex items-center gap-2 text-[13px] text-slate-500">
            <Users className="w-3.5 h-3.5" />
            Admin: {adminName} ({adminEmail})
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatTile label="Total Customers" value={totalCustomers} />
        <StatTile label="Active Customers" value={activeCustomers} sub={totalCustomers > 0 ? `${Math.round((activeCustomers / totalCustomers) * 100)}%` : undefined} />
        <StatTile label="Billing Admins" value={billingAdmins} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title="Company Identity" icon={Building2}>
          <Field label="Company Name" value={normalizeOrgName(companyName)} />
          <Field label="Website" value={config?.website || org?.website || "—"} />
          <Field label="Billing Email" value={config?.billing_email || org?.email || "—"} />
          <Field label="Billing Phone" value={config?.billing_phone || org?.phone || "—"} />
          <Field label="Organization Code" value={orgCode} />
          <Field label="Status" value={status} />
          <Field label="Industry" value={org?.industry || config?.industry} />
          <Field label="Registration Date" value={org?.created_at ? new Date(org.created_at).toLocaleDateString() : "—"} />
        </Card>

        <Card title="Contact & Address" icon={Mail}>
          <div className="sm:col-span-2">
            <Field label="Address" value={[config?.address_line1, config?.address_line2, config?.city, config?.state, config?.postal_code, config?.country].filter(Boolean).join(", ") || "—"} />
          </div>
          <Field label="City" value={config?.city} />
          <Field label="State / Region" value={config?.state} />
          <Field label="Postal Code" value={config?.postal_code} />
          <Field label="Country" value={config?.country} />
        </Card>

        <Card title="Tax & Registration" icon={ShieldCheck}>
          <Field label="Business Registration Number" value={config?.business_registration_number || "—"} />
          <Field label="GST Number" value={config?.gst_number || "—"} />
          <Field label="VAT Number" value={config?.vat_number || "—"} />
          <Field label="PAN Number" value={config?.pan_number || "—"} />
          <Field label="TIN Number" value={config?.tin_number || "—"} />
          <Field label="Tax Calculation" value={config?.tax_calculation_method || "—"} />
        </Card>

        <Card title="Billing Defaults" icon={Coins}>
          <Field label="Fiscal Year" value={formatFiscalYearRange(config?.fiscal_year_start, config?.fiscal_year_end)} />
          <Field label="Default Currency" value={config?.default_currency || org?.currency} />
          <Field label="Supported Currencies" value={Array.isArray(config?.supported_currencies) && config.supported_currencies.length ? config.supported_currencies.join(", ") : "—"} />
          <Field label="Date Format" value={config?.date_format || "—"} />
          <Field label="Timezone" value={config?.timezone || org?.timezone || "UTC"} />
          <Field label="Language" value={config?.language || "—"} />
          <Field label="Base Currency" value={config?.base_currency} />
          <Field label="Tax Label" value={config?.tax_label || "—"} />
        </Card>

        <Card title="Document Defaults" icon={FileText}>
          <Field label="Invoice Number Format" value={config?.invoice_number_format || "—"} />
          <Field label="Quote Number Format" value={config?.quote_number_format || "—"} />
          <Field label="Credit Note Prefix" value={config?.credit_note_prefix || "—"} />
          <Field label="Refund Prefix" value={config?.refund_prefix || "—"} />
          <Field label="Write-off Prefix" value={config?.write_off_prefix || "—"} />
          <Field label="Default Payment Terms" value={config?.default_payment_terms || "—"} />
          <Field label="Invoice Prefix" value={config?.invoice_prefix || "INV-"} />
          <Field label="Quote Prefix" value={config?.quote_prefix || "QTE-"} />
        </Card>

        {(config?.invoice_footer || config?.invoice_terms || config?.invoice_notes) && (
          <Card title="Invoice Notes & Terms" icon={ScrollText}>
            <Field label="Invoice Footer" value={config?.invoice_footer || "—"} />
            <Field label="Invoice Terms" value={config?.invoice_terms || "—"} />
            <Field label="Invoice Notes" value={config?.invoice_notes || "—"} />
          </Card>
        )}
      </div>

      <div className="mt-6 rounded-3xl border border-slate-200 bg-slate-50/60 p-5 flex items-center justify-between flex-wrap gap-3">
        <p className="text-[13px] text-slate-500">
          These fields are managed by your Billing configuration. To change any of them, open Billing Settings.
        </p>
        <button
          onClick={() => navigate("/billing/settings")}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-semibold text-white bg-brand hover:bg-brand-hover transition-colors cursor-pointer"
        >
          Edit in Billing Settings
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
