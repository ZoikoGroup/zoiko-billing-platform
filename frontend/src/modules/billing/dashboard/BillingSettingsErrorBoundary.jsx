import React from "react";
import { AlertCircle, RefreshCw, RotateCcw, Settings2 } from "lucide-react";

export default class BillingSettingsErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo });
    /* BillingSettings error caught by boundary */
    /* Component stack captured */
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      const errorMsg = this.state.error?.message || "Unknown error";
      return (
        <div className="space-y-8">
          <div className="rounded-3xl bg-white border border-slate-200 p-6 md:p-8 shadow-[0_4px_20px_rgba(0,0,0,0.03)]">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-2xl bg-gradient-to-r from-[#FF7A00] to-[#FF5500] text-white flex items-center justify-center shadow-sm shrink-0">
                <Settings2 size={22} />
              </div>
              <div>
                <h1 className="text-2xl md:text-3xl font-extrabold text-slate-900 tracking-tight dark:text-white">Billing Configuration</h1>
                <p className="text-slate-500 text-sm mt-0.5 dark:text-slate-400">Enterprise billing module settings</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-8 text-center" role="alert">
            <div className="h-16 w-16 rounded-full bg-red-100 text-red-600 flex items-center justify-center mx-auto mb-4">
              <AlertCircle size={32} />
            </div>
            <h2 className="text-xl font-bold text-slate-900 mb-2">Something went wrong</h2>
            <p className="text-sm text-slate-600 mb-6 max-w-md mx-auto">
              A rendering error occurred in the Billing Settings page. This has been logged.
            </p>
            <div className="flex items-center justify-center gap-3">
              <button onClick={this.handleRetry}
                className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-[#FF7A00] to-[#FF5500] text-white rounded-xl text-sm font-medium hover:shadow-lg transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A00]/50 focus-visible:ring-offset-1">
                <RefreshCw size={16} />
                Retry
              </button>
              <button onClick={this.handleReload}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-slate-50 border border-slate-200 hover:bg-slate-100 text-slate-700 text-sm font-medium transition-colors shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A00]/50">
                <RotateCcw size={16} />
                Reload
              </button>
            </div>
            <details className="mt-6 text-left max-w-lg mx-auto">
              <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A00]/50 rounded">View Error Details</summary>
              <pre className="mt-2 p-3 bg-red-50 rounded-xl text-xs text-red-700 overflow-auto max-h-40">
                {errorMsg}
                {this.state.error?.stack ? `\n\n${this.state.error.stack}` : ""}
              </pre>
            </details>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
