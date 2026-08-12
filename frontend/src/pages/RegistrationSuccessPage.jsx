import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Check,
  ArrowRight,
  Mail,
  ShieldCheck,
  Clock3,
  Building2,
  FileText,
  Users,
} from "lucide-react";

export default function RegistrationSuccessPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const orgName = location.state?.organizationName ?? "Your Organization";
  const email = location.state?.email ?? "";

  useEffect(() => {
    if (!location.state?.organizationName) {
      navigate("/register", { replace: true });
    }
  }, [location.state, navigate]);

  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-50 px-4 py-12">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(#0000000f_1px,transparent_1px)] bg-[size:28px_28px] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_35%,black,transparent)]" />

        <div className="absolute -top-32 left-1/2 h-[560px] w-[560px] -translate-x-1/2 rounded-full bg-gradient-to-br from-indigo-200/60 via-violet-200/40 to-transparent blur-3xl" />
        <div className="absolute -bottom-48 -left-24 h-[380px] w-[380px] rounded-full bg-gradient-to-tr from-orange-200/40 via-amber-100/30 to-transparent blur-3xl" />
        <div className="absolute -bottom-32 -right-16 h-[320px] w-[320px] rounded-full bg-gradient-to-tl from-indigo-200/40 to-transparent blur-3xl" />

        <div className="absolute left-[12%] top-[18%] hidden animate-[float_7s_ease-in-out_infinite] rounded-2xl border border-slate-200/70 bg-white/70 p-3 shadow-sm backdrop-blur-sm sm:block">
          <Building2 size={18} className="text-indigo-400" />
        </div>
        <div className="absolute right-[14%] top-[28%] hidden animate-[float_8s_ease-in-out_infinite] rounded-2xl border border-slate-200/70 bg-white/70 p-3 shadow-sm backdrop-blur-sm sm:block [animation-delay:1.2s]">
          <Users size={18} className="text-orange-400" />
        </div>
        <div className="absolute bottom-[16%] left-[16%] hidden animate-[float_9s_ease-in-out_infinite] rounded-2xl border border-slate-200/70 bg-white/70 p-3 shadow-sm backdrop-blur-sm sm:block [animation-delay:2.4s]">
          <FileText size={18} className="text-violet-400" />
        </div>
        <div className="absolute bottom-[22%] right-[10%] hidden animate-[float_6.5s_ease-in-out_infinite] rounded-2xl border border-slate-200/70 bg-white/70 p-3 shadow-sm backdrop-blur-sm sm:block [animation-delay:0.6s]">
          <ShieldCheck size={18} className="text-emerald-400" />
        </div>
      </div>

      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-10px); }
        }
        @media (prefers-reduced-motion: reduce) {
          [class*="animate-"] { animation: none !important; }
        }
      `}</style>

      <div
        className={`relative w-full max-w-md transition-all duration-700 ease-out ${
          mounted ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
        }`}
      >
        <div className="mb-8 flex items-center justify-center gap-2">
          <span
            className="grid h-10 w-10 place-items-center rounded-lg text-lg font-bold italic text-white"
            style={{ background: "linear-gradient(135deg, #f97316 40%, #3b82f6 100%)" }}
          >
            1
          </span>
          <span className="text-lg font-bold tracking-tight text-slate-900">Zoiko Billing</span>
        </div>

        <div className="rounded-2xl border border-slate-200/80 bg-white p-8 shadow-xl shadow-slate-900/[0.04] sm:p-10">
          <div className="flex justify-center">
            <div className="relative">
              <div className="absolute inset-0 animate-ping rounded-full bg-emerald-400/30 [animation-duration:2s]" />
              <div className="relative grid h-16 w-16 place-items-center rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-lg shadow-emerald-500/25">
                <Check size={30} strokeWidth={3} className="text-white" />
              </div>
            </div>
          </div>

          <div className="mt-6 text-center">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">
              Organization registered successfully
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-slate-500">
              <span className="font-medium text-slate-700">{orgName}</span>{" "}
              is ready for Zoiko Billing. We've sent a confirmation to
            </p>
            <p className="mt-0.5 flex items-center justify-center gap-1.5 text-sm font-medium text-slate-700">
              <Mail size={14} className="text-slate-400" />
              {email}
            </p>
          </div>

          <div className="mt-7 space-y-3 rounded-xl border border-slate-100 bg-slate-50/60 p-4">
            <div className="flex items-center gap-3">
              <div className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-emerald-100 text-emerald-600">
                <Check size={13} strokeWidth={3} />
              </div>
              <span className="text-sm text-slate-700">
                Organization created
              </span>
            </div>
            <div className="ml-3 h-3 w-px bg-slate-200" />
            <div className="flex items-center gap-3">
              <div className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-emerald-100 text-emerald-600">
                <Check size={13} strokeWidth={3} />
              </div>
              <span className="text-sm text-slate-700">
                Billing access ready
              </span>
            </div>
            <div className="ml-3 h-3 w-px bg-slate-200" />
            <div className="flex items-center gap-3">
              <div className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-amber-100 text-amber-600">
                <Clock3 size={13} />
              </div>
              <span className="text-sm text-slate-700">
                Invite billing admins
              </span>
            </div>
          </div>

          <p className="mt-6 text-center text-xs leading-relaxed text-slate-400">
            Sign in as organization admin to invite your team and start your first pay run.
          </p>

          <button
            onClick={() => navigate("/login")}
            className="mt-7 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-medium text-white shadow-sm shadow-indigo-600/20 transition-colors hover:bg-indigo-700 focus:outline-none focus:ring-4 focus:ring-indigo-100"
          >
            Go to login
            <ArrowRight size={16} />
          </button>
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          Wrong email? Contact your organization administrator.
        </p>
      </div>
    </div>
  );
}
