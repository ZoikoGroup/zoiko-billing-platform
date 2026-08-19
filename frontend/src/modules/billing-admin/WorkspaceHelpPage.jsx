import { useState } from "react";
import { useNavigate } from "react-router-dom";
import WorkspaceHeader from "./WorkspaceHeader";
import { HelpCircle, BookOpen, FileText, Headphones, ChevronDown, ChevronRight } from "lucide-react";

const QUICK_LINKS = [
  { title: "Billing Dashboard", description: "Overview of your billing metrics and KPIs", icon: FileText, path: "/billing", color: "#D97706" },
  { title: "Billing Settings", description: "Configure your billing preferences and templates", icon: BookOpen, path: "/billing/settings", color: "#0891B2" },
  { title: "Customers", description: "Manage your customer accounts and contacts", icon: Headphones, path: "/billing/customers", color: "#7C3AED" },
  { title: "Invoices", description: "Create and manage invoices, credit notes, and payments", icon: FileText, path: "/billing/invoices", color: "#DC2626" },
];

const FAQ_ITEMS = [
  {
    q: "How do I create an invoice?",
    a: "Navigate to Invoices and click 'Create Invoice'. You can add line items, apply taxes, set payment terms, and send the invoice to your customer via email.",
  },
  {
    q: "How do I add a new customer?",
    a: "Go to Customers and click 'Add Customer'. Fill in the customer details including billing address, payment terms, and credit limits.",
  },
  {
    q: "How do I set up pricing plans?",
    a: "Navigate to Pricing Plans to create tiered, flat-rate, or usage-based pricing. You can assign plans to products and link them to subscriptions.",
  },
  {
    q: "How do I manage payments?",
    a: "Go to Payments to record manual payments, allocate unallocated payments to invoices, and reconcile payment records.",
  },
  {
    q: "How do I configure billing settings?",
    a: "Navigate to Billing Settings to configure invoice prefixes, payment terms, tax settings, email templates, and currency preferences.",
  },
  {
    q: "How do I handle refunds and credit notes?",
    a: "Use Credit Notes to issue credits against invoices, and Refunds to process refund requests. Both have full approval workflows and audit trails.",
  },
];

function FaqItem({ item, isOpen, onToggle }) {
  return (
    <div className="border border-slate-200 rounded-2xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-4 text-left bg-white hover:bg-slate-50 transition-colors cursor-pointer"
      >
        <span className="text-[13px] font-semibold text-slate-800">{item.q}</span>
        {isOpen ? <ChevronDown className="w-4 h-4 shrink-0 text-slate-400" /> : <ChevronRight className="w-4 h-4 shrink-0 text-slate-400" />}
      </button>
      {isOpen && (
        <div className="px-4 pb-4">
          <p className="text-[13px] leading-relaxed text-slate-500">{item.a}</p>
        </div>
      )}
    </div>
  );
}

export default function WorkspaceHelpPage() {
  const navigate = useNavigate();
  const [openFaq, setOpenFaq] = useState(null);

  return (
    <div className="p-4 sm:p-6 lg:p-8" style={{ background: "#ffffff", minHeight: "calc(100vh - 4rem)" }}>
      <WorkspaceHeader title="Help & Documentation" subtitle="Billing guides and support" icon={HelpCircle} />

      <div className="mb-8">
        <h2 className="text-lg font-bold text-slate-800 mb-4">Quick Links</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {QUICK_LINKS.map((link) => {
            const Icon = link.icon;
            return (
              <button
                key={link.path}
                onClick={() => navigate(link.path)}
                className="p-5 rounded-2xl border border-slate-200 bg-white text-left hover:border-brand/40 hover:shadow-lg transition-all cursor-pointer"
              >
                <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3" style={{ background: `${link.color}15`, color: link.color }}>
                  <Icon className="w-5 h-5" />
                </div>
                <p className="text-[13px] font-semibold text-slate-800 mb-1">{link.title}</p>
                <p className="text-[11px] leading-relaxed text-slate-500">{link.description}</p>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mb-8">
        <h2 className="text-lg font-bold text-slate-800 mb-4">Frequently Asked Questions</h2>
        <div className="space-y-2">
          {FAQ_ITEMS.map((item, i) => (
            <FaqItem key={i} item={item} isOpen={openFaq === i} onToggle={() => setOpenFaq(openFaq === i ? null : i)} />
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <p className="text-[12.5px] leading-relaxed text-slate-500">
          This workspace ("My Organization" in the sidebar) is your
          organization-level control center — identity, billing health,
          subscription, activity, and configuration at a glance. The full
          Zoiko Billing product itself — Customers, Products, Pricing,
          Quotations, Contracts, Subscriptions, Invoicing, Payments, Tax,
          and Reports — lives under the <strong>Billing</strong> section of
          the sidebar below it. Every action in this workspace navigates
          into that same product; nothing here duplicates it.
        </p>
      </div>
    </div>
  );
}
