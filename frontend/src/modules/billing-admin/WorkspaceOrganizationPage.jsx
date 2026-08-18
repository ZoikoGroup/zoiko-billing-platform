import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { settingsApi } from "../../service/billingService";
import { getOrganizationDetails } from "../../service/orgAdminService";
import WorkspaceHeader from "./WorkspaceHeader";
import { normalizeOrgName } from "./workspace-format";
import { Building2, Mail, MapPin, Landmark, CalendarDays, Coins, FileText, ShieldCheck, Loader2, Users, ArrowRight, ScrollText } from "lucide-react";

const INK = "#181433";
const INK_SOFT = "#4A4566";
const LINE = "rgba(24,20,51,0.08)";
const RED_100 = "#FBE6E4";
const RED = "#D6473C";

function Field({ label, value }) {
  return (
    <div className="py-3">
      <p className="text-[11px] font-bold uppercase tracking-[0.06em] mb-1" style={{ color: INK_SOFT }}>{label}</p>
      <p className="text-[14px] font-medium" style={{ color: INK }}>{value || "\u2014"}</p>
    </div>
  );
}

function Card({ title, icon: Icon, children }) {
  return (
    <div className="rounded-[16px] border bg-white p-6 shadow-[0_1px_2px_rgba(24,20,51,0.04),0_8px_24px_-12px_rgba(24,20,51,0.10)]">
      <div className="flex items-center gap-2.5 mb-5 pb-4" style={{ borderBottom: `1px solid ${LINE}` }}>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-purple-50 text-purple-600">
          <Icon className="w-4 h-4" />
        </div>
        <h3 className="text-[14px] font-bold" style={{ color: INK }}>{title}</h3>
      </div>
      {children}
    </div>
  );
}

function StatTile({ label, value, sub }) {
  return (
    <div className="rounded-[12px] border p-4 text-center" style={{ borderColor: LINE }}>
      <p className="text-[24px] font-bold" style={{ color: INK }}>{value}</p>
      <p className="text-[11px] font-medium mt-1" style={{ color: INK_SOFT }}>{label}</p>
      {sub && <p className="text-[10px] mt-0.5" style={{ color: INK_SOFT }}>{sub}</p>}
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
      <div className="p-4 sm:p-6 lg:p-8" style={{ background: "#F8F7F4", minHeight: "calc(100vh - 4rem)" }}>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-purple-600" />
        </div>
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

  const companyName = config?.company_name || org?.name || "";
  const orgCode = org?.code || "";
  const adminName = org?.admin_name || "";
  const adminEmail = org?.admin_email || config?.billing_email || "";
  const status = org?.status || "active";
  const totalCustomers = org?.total_customers ?? 0;
  const activeCustomers = org?.active_customers ?? 0;
  const billingAdmins = org?.billing_admins ?? 0;

  return (
    <div className="font-['Inter',system-ui,sans-serif] p-4 sm:p-6 lg:p-8" style={{ background: "#F8F7F4", color: INK, minHeight: "calc(100vh - 4rem)" }}>
      <WorkspaceHeader
        title="Organization Profile"
        subtitle="Read-only billing administration view"
        icon={Building2}
        organization={org || config}
      />

      <div className="rounded-[20px] border bg-white p-6 mb-6 shadow-[0_1px_2px_rgba(24,20,51,0.04),0_8px_24px_-12px_rgba(24,20,51,0.10)]">
        <div className="flex items-center gap-4 mb-4">
          <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-[#1a0933] to-purple-800 flex items-center justify-center text-white font-bold text-xl">
            {companyName ? normalizeOrgName(companyName).split(" ").map(w => w[0]).join("").substring(0, 2).toUpperCase() : "org"}
          </div>
          <div>
            <h2 className="text-lg font-bold" style={{ color: INK }}>{normalizeOrgName(companyName) || "Organization"}</h2>
            <div className="flex items-center gap-2 mt-1">
              {orgCode && <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-gray-100 text-gray-600">{orgCode}</span>}
              <StatusPill status={status} />
            </div>
          </div>
        </div>
        {adminName && (
          <div className="flex items-center gap-2 text-[13px]" style={{ color: INK_SOFT }}>
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
          <Field label="Organization Name" value={normalizeOrgName(companyName)} />
          <Field label="Organization Code" value={orgCode} />
          <Field label="Status" value={status} />
          <Field label="Industry" value={org?.industry || config?.industry} />
          <Field label="Registration Date" value={org?.created_at ? new Date(org.created_at).toLocaleDateString() : "\u2014"} />
        </Card>

        <Card title="Contact & Address" icon={Mail}>
          <Field label="Billing Email" value={config?.billing_email || org?.email || "\u2014"} />
          <Field label="Billing Phone" value={config?.billing_phone || org?.phone || "\u2014"} />
          <Field label="Website" value={config?.website || org?.website || "\u2014"} />
          <Field label="Address" value={[config?.address_line1, config?.address_line2, config?.city, config?.state, config?.postal_code, config?.country].filter(Boolean).join(", ") || "\u2014"} />
        </Card>

        <Card title="Tax & Registration" icon={ShieldCheck}>
          <Field label="Tax Calculation" value={config?.tax_calculation_method || "\u2014"} />
          <Field label="GST Number" value={config?.gst_number || "\u2014"} />
          <Field label="VAT Number" value={config?.vat_number || "\u2014"} />
          <Field label="PAN Number" value={config?.pan_number || "\u2014"} />
          <Field label="TIN Number" value={config?.tin_number || "\u2014"} />
          <Field label="Business Registration" value={config?.business_registration_number || "\u2014"} />
        </Card>

        <Card title="Billing Defaults" icon={Coins}>
          <Field label="Default Currency" value={config?.default_currency || org?.currency || "USD"} />
          <Field label="Base Currency" value={config?.base_currency || "USD"} />
          <Field label="Supported Currencies" value={Array.isArray(config?.supported_currencies) && config.supported_currencies.length ? config.supported_currencies.join(", ") : "\u2014"} />
          <Field label="Payment Terms" value={config?.default_payment_terms || "\u2014"} />
          <Field label="Tax Label" value={config?.tax_label || "\u2014"} />
          <Field label="Timezone" value={config?.timezone || org?.timezone || "UTC"} />
          <Field label="Date Format" value={config?.date_format || "\u2014"} />
          <Field label="Language" value={config?.language || "\u2014"} />
          <Field label="Fiscal Year" value={config?.fiscal_year_start ? `${config.fiscal_year_start} to ${config.fiscal_year_end || "?"}` : "\u2014"} />
        </Card>

        <Card title="Document Defaults" icon={FileText}>
          <Field label="Invoice Prefix" value={config?.invoice_prefix || "INV-"} />
          <Field label="Invoice Number Format" value={config?.invoice_number_format || "\u2014"} />
          <Field label="Quote Prefix" value={config?.quote_prefix || "QTE-"} />
          <Field label="Quote Number Format" value={config?.quote_number_format || "\u2014"} />
          <Field label="Credit Note Prefix" value={config?.credit_note_prefix || "\u2014"} />
          <Field label="Refund Prefix" value={config?.refund_prefix || "\u2014"} />
          <Field label="Write-off Prefix" value={config?.write_off_prefix || "\u2014"} />
        </Card>

        {(config?.invoice_footer || config?.invoice_terms || config?.invoice_notes) && (
          <Card title="Invoice Notes & Terms" icon={ScrollText}>
            <Field label="Invoice Footer" value={config?.invoice_footer || "\u2014"} />
            <Field label="Invoice Terms" value={config?.invoice_terms || "\u2014"} />
            <Field label="Invoice Notes" value={config?.invoice_notes || "\u2014"} />
          </Card>
        )}
      </div>

      <div className="mt-6 rounded-[16px] border bg-white p-5 flex items-center justify-between flex-wrap gap-3" style={{ borderColor: LINE }}>
        <p className="text-[13px]" style={{ color: INK_SOFT }}>
          These fields are managed by your Billing configuration. To change any of them, open Billing Settings.
        </p>
        <button
          onClick={() => navigate("/billing/settings")}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold text-white cursor-pointer"
          style={{ background: "#7C3AED" }}
        >
          Edit in Billing Settings
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
