import { useState } from "react";
import { Package, Upload, ArrowRight, X, Sparkles, ChevronRight } from "lucide-react";
import ImportWizardModal from "./import-wizard";

const DISMISSED_KEY = "billing_catalog_onboarding_dismissed";

/**
 * CatalogOnboarding
 * -----------------
 * Shown when a new organization's product catalog is empty.
 * Provides three paths: Manual Add / Import Catalog / Skip.
 *
 * Dismiss state is stored in localStorage for this phase.
 * Future enhancement: persist to org-level setting on the server.
 *
 * @param {function} onAddManually - Open the manual create product modal
 * @param {function} onImported    - Callback after a successful import
 * @param {function} onDismiss     - Callback when user clicks Skip / X
 */
export default function CatalogOnboarding({ onAddManually, onImported, onDismiss }) {
  const [showImport, setShowImport] = useState(false);
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISSED_KEY) === "1"
  );

  if (dismissed) return null;

  const handleDismiss = () => {
    // localStorage for now — server-side persistence is a future enhancement
    localStorage.setItem(DISMISSED_KEY, "1");
    setDismissed(true);
    if (onDismiss) onDismiss();
  };

  const handleImported = (result) => {
    setShowImport(false);
    if (onImported) onImported(result);
    handleDismiss();
  };

  return (
    <>
      {/* Onboarding Card */}
      <div className="relative rounded-3xl overflow-hidden shadow-xl mb-6"
           style={{ background: "linear-gradient(135deg, var(--color-accent-invoicing) 0%, var(--color-accent-invoicing-hover) 40%, #E64500 100%)" }}>
        {/* Decorative circles */}
        <div className="absolute top-0 right-0 w-64 h-64 rounded-full opacity-10"
             style={{ background: "radial-gradient(circle, #fff 0%, transparent 70%)", transform: "translate(30%, -40%)" }} />
        <div className="absolute bottom-0 left-1/2 w-40 h-40 rounded-full opacity-10"
             style={{ background: "radial-gradient(circle, #fff 0%, transparent 70%)", transform: "translate(-50%, 50%)" }} />

        {/* Dismiss button */}
        <button
          onClick={handleDismiss}
          className="absolute top-4 right-4 p-1.5 rounded-xl hover:bg-white/20 text-white/60 hover:text-white transition-all"
          title="Skip for now"
        >
          <X size={18} />
        </button>

        <div className="relative z-10 p-8">
          {/* Header */}
          <div className="flex items-start gap-4 mb-6">
            <div className="w-12 h-12 rounded-2xl bg-white/20 flex items-center justify-center flex-shrink-0 backdrop-blur-sm">
              <Sparkles size={24} className="text-white" />
            </div>
            <div>
              <h3 className="text-xl font-bold text-white mb-1">
                Set up your Products &amp; Services Catalog
              </h3>
              <p className="text-brand-100 text-sm leading-relaxed">
                Your catalog is empty. Add your first products and services to start
                creating invoices, quotations, and subscriptions.
              </p>
            </div>
          </div>

          {/* Option cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Option 1: Manual */}
            <button
              onClick={onAddManually}
              className="group flex flex-col gap-3 p-4 rounded-2xl bg-white/10 hover:bg-white/20 border border-white/20 hover:border-white/40 backdrop-blur-sm transition-all duration-200 text-left"
            >
              <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center group-hover:scale-110 transition-transform">
                <Package size={20} className="text-white" />
              </div>
              <div>
                <p className="font-semibold text-white text-sm mb-0.5">Add Manually</p>
                <p className="text-brand-100 text-xs leading-relaxed">
                  Start with a few products right now
                </p>
              </div>
              <div className="flex items-center gap-1 text-brand-200 text-xs font-medium mt-auto">
                Get started <ChevronRight size={12} />
              </div>
            </button>

            {/* Option 2: Import */}
            <button
              onClick={() => setShowImport(true)}
              className="group flex flex-col gap-3 p-4 rounded-2xl bg-white/20 hover:bg-white/30 border-2 border-white/40 hover:border-white/70 backdrop-blur-sm transition-all duration-200 text-left relative"
            >
              {/* Recommended badge */}
              <div className="absolute -top-2.5 left-4 bg-amber-400 text-amber-900 text-xs font-bold px-2.5 py-0.5 rounded-full shadow">
                RECOMMENDED
              </div>
              <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center group-hover:scale-110 transition-transform">
                <Upload size={20} className="text-white" />
              </div>
              <div>
                <p className="font-semibold text-white text-sm mb-0.5">Import Catalog</p>
                <p className="text-brand-100 text-xs leading-relaxed">
                  Upload CSV or Excel to bulk-import
                </p>
              </div>
              <div className="flex items-center gap-1 text-white text-xs font-medium mt-auto">
                Import now <ArrowRight size={12} />
              </div>
            </button>

            {/* Option 3: Skip */}
            <button
              onClick={handleDismiss}
              className="group flex flex-col gap-3 p-4 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 backdrop-blur-sm transition-all duration-200 text-left opacity-80 hover:opacity-100"
            >
              <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                <X size={20} className="text-white/70" />
              </div>
              <div>
                <p className="font-semibold text-white text-sm mb-0.5">Skip for Now</p>
                <p className="text-brand-100 text-xs leading-relaxed">
                  Continue and add products later
                </p>
              </div>
              <div className="flex items-center gap-1 text-brand-200 text-xs font-medium mt-auto">
                Dismiss <ChevronRight size={12} />
              </div>
            </button>
          </div>
        </div>
      </div>

      {/* Import Wizard */}
      {showImport && (
        <ImportWizardModal
          onClose={() => setShowImport(false)}
          onImported={handleImported}
        />
      )}
    </>
  );
}

/**
 * Utility: check if onboarding has been dismissed in this browser.
 */
export function isCatalogOnboardingDismissed() {
  return localStorage.getItem(DISMISSED_KEY) === "1";
}

/**
 * Utility: reset dismissal state (useful for testing or re-triggering).
 */
export function resetCatalogOnboarding() {
  localStorage.removeItem(DISMISSED_KEY);
}
