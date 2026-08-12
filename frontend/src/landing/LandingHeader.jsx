import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";

export default function LandingHeader() {
  return (
    <header className="sticky top-0 z-50 bg-gradient-to-b from-[#F1EEFC] to-white border-b border-[#E2E4EF] rounded-b-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8 h-16">
        <Link to="/" className="flex items-center gap-2 shrink-0 no-underline">
          <span
            style={{
              width: "36px",
              height: "36px",
              borderRadius: "8px",
              background: "linear-gradient(135deg, #f97316 40%, #3b82f6 100%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "18px",
              color: "#ffffff",
              fontWeight: "700",
              fontStyle: "italic",
            }}
          >
            1
          </span>
          <span className="text-[17px] font-bold text-[#1a1a3e] tracking-tight">
            Zoiko Billing
          </span>
        </Link>

        <div className="flex items-center gap-4 text-sm font-semibold">
          <Link to="/login" className="text-[#1E1B4B] no-underline">
            Sign In
          </Link>
          <Link
            to="/register"
            className="inline-flex items-center gap-1 bg-[#F97316] hover:bg-[#EA580C] text-white rounded-full px-5 py-2.5 shadow-md shadow-orange-200 transition-all duration-200 no-underline"
          >
            Create your account <ArrowRight size={15} />
          </Link>
        </div>
      </div>
    </header>
  );
}
