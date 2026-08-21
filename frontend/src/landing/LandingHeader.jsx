import { ChevronDown } from "lucide-react";
import { Link } from "react-router-dom";

const NAV_ITEMS = [
  { label: "Product", hasMenu: true },
  { label: "Solutions", hasMenu: true },
  { label: "Global Billing", hasMenu: true },
  { label: "Integrations", hasMenu: true },
  { label: "Pricing", hasMenu: false },
  { label: "Resources", hasMenu: true },
  { label: "Company", hasMenu: true },
];

export default function LandingHeader() {
  return (
    <header className="sticky top-0 z-50 bg-white border-b border-[#E5E7EB]" style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>
      <div className="flex items-center justify-between px-6 lg:px-10 h-16 gap-6">
        <Link to="/" className="flex items-center shrink-0 no-underline">
          <img src="/zoiko-billing-logo.png" alt="Zoiko Billing" className="h-10 w-auto" />
        </Link>

        <nav className="hidden lg:flex flex-1 items-center justify-center gap-6 text-sm font-medium text-[#374151]">
          {NAV_ITEMS.map(({ label, hasMenu }) => (
            <button
              key={label}
              type="button"
              className="flex items-center gap-1 whitespace-nowrap bg-transparent border-none cursor-pointer hover:text-[#0F172A] transition-colors"
            >
              {label}
              {hasMenu && <ChevronDown size={14} />}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-3 text-sm font-semibold shrink-0">
          <Link to="/login" className="text-[#0F172A] no-underline">
            Sign In
          </Link>
          <button
            type="button"
            className="inline-flex items-center gap-1 bg-white border border-[#0F172A] text-[#0F172A] rounded-full px-5 py-2.5 hover:bg-[#F9FAFB] transition-all duration-200"
          >
            Book a Demo
          </button>
          <Link
            to="/register"
            className="inline-flex items-center gap-1 bg-[#2563EB] hover:bg-[#1D4ED8] text-white rounded-full px-5 py-2.5 shadow-md shadow-blue-200 transition-all duration-200 no-underline"
          >
            Create Account
          </Link>
        </div>
      </div>
    </header>
  );
}
