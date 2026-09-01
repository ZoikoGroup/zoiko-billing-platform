# Plan: Trial Period Bar Chart in Super Admin User Management

## Goal
Show remaining trial days per organization as a bar chart on the super admin
user management page (`frontend/src/pages/UsersPage.jsx`). No backend changes —
derive from existing `/api/super-admin/users` response (`trial_ends_at`,
`subscription_status`, `recovery_ends_at`).

## File
`frontend/src/pages/UsersPage.jsx`

## Changes

### 1. Imports (line 6-7)
Add recharts + shared chart components:
```js
import { ErrorState, SuccessMessage, Pagination, StatusBadge,
         DashboardChartCard, DashboardChartErrorBoundary, DashboardEmptyPanel }
  from "../components/billing-shared";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
```

### 2. Derive chart data via useMemo (after `totalPages`, ~line 390)
- Group `users` by `organization_name`
- For each org, compute remaining trial days from `trial_ends_at`
- Include only orgs with active/upcoming trial
  (`subscription_status === "trialing" || "pending"`)
- Sort by remaining days ascending (most urgent first)
- Output `[{ org, days, color }]` where color by urgency:
  - `#EF4444` (red) days <= 3
  - `#F59E0B` (amber) days <= 7
  - `#10B981` (emerald) days > 7

### 3. Insert chart section between ListToolbar (line 427) and DataTable (line 429)
```jsx
{chartData.length > 0 ? (
  <div className="mt-6">
    <DashboardChartCard title="Trial Period Overview"
      action={<span className="text-xs text-slate-400">{chartData.length} org(s) on trial</span>}>
      <div className="h-64 w-full" aria-label="Remaining trial days per organization">
        <DashboardChartErrorBoundary>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
              <XAxis dataKey="org" tick={{ fontSize: 11, fill: "#64748B" }}
                interval={0} angle={-25} textAnchor="end" height={56} />
              <YAxis tick={{ fontSize: 11, fill: "#64748B" }} allowDecimals={false} />
              <Tooltip formatter={(v) => [`${v} day(s)`, "Trial remaining"]} />
              <Bar dataKey="days" radius={[6,6,0,0]}>
                {chartData.map((d, i) => <Cell key={i} fill={d.color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </DashboardChartErrorBoundary>
      </div>
    </DashboardChartCard>
  </div>
) : null}
```
Need to add `Cell` to recharts import for per-bar coloring.

## Notes
- Chart reflects current filtered page of users (25 rows), not all tenants.
- Uses existing `users` state; no extra fetch.
- `DashboardChartCard` / `DashboardChartErrorBoundary` / `DashboardEmptyPanel`
  pattern reused from `billing-shared.jsx` (existing exports lines 739-797).
