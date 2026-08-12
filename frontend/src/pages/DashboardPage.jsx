import React, { useEffect, useState } from "react";
import { Building2, Users, CreditCard, RefreshCcw } from "lucide-react";

import { apiFetch } from "../api/client";

const CARDS = [
  { key: "total_organizations", label: "Organizations", icon: Building2 },
  { key: "active_organizations", label: "Active Organizations", icon: Building2 },
  { key: "total_users", label: "Users", icon: Users },
  { key: "org_admins", label: "Org Admins", icon: Users },
  { key: "billing_admins", label: "Billing Admins", icon: Users },
  { key: "total_customers", label: "Customers", icon: CreditCard },
  { key: "total_invoices", label: "Invoices", icon: RefreshCcw },
];

export default function DashboardPage() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch("/api/super-admin/dashboard/stats")
      .then(setStats)
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <p className="text-red-600">{error}</p>;
  if (!stats) return <p className="text-slate-500">Loading…</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 mb-6">Dashboard</h1>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {CARDS.map(({ key, label, icon: Icon }) => (
          <div key={key} className="bg-white rounded-xl shadow-sm p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-3xl font-bold text-slate-900">{stats[key] ?? 0}</div>
                <div className="text-xs text-slate-500 mt-1">{label}</div>
              </div>
              <Icon size={20} className="text-orange-500" />
            </div>
          </div>
        ))}
      </div>

      <h2 className="text-lg font-semibold text-slate-900 mt-8 mb-3">Recent Organizations</h2>
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Code</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody>
            {(stats.recent_organizations || []).map((org) => (
              <tr key={org.id} className="border-t border-slate-100">
                <td className="px-4 py-3 font-medium text-slate-800">{org.organization_name}</td>
                <td className="px-4 py-3 text-slate-500">{org.organization_code}</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      org.is_active ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                    }`}
                  >
                    {org.is_active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-500">
                  {new Date(org.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
