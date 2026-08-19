/* HRPage Component */
import React from 'react';

export default function HRPage({ title, subtitle, children, actions }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="py-6 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
              {subtitle && (
                <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
              )}
            </div>
            {actions && <div className="shrink-0">{actions}</div>}
          </div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}