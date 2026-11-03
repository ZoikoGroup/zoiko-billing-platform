import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangle, Building2, ChevronRight, Clock, CreditCard, MinusCircle, Plus, X } from "lucide-react";
import {
  createOrganization,
  getCountryDefaults,
  listOrganizations,
} from "../../service/commercialService";
import { getCurrencyInfo } from "../../utils/currency";
import { PageHeader, DataTable, SearchInput, Modal, Field, Button } from "../../components/billing-ui";
import { Pagination, ErrorState, Spinner, SuccessMessage } from "../../components/billing-shared";
import {
  PAGE_SIZE,
  formatDateTime,
  displayValue,
  CommercialClassificationBadge,
  formatTrialRemaining,
  ORG_ACCOUNT_STATUS as ACCOUNT_STATUS,
  ORG_ACCOUNT_STATUS_ORDER as ACCOUNT_STATUS_ORDER,
  OrgAccountStatusBadge as AccountStatusBadge,
  SUBSCRIPTION_STATUS_OPTIONS,
} from "./constants";

// The API serializes naive UTC datetimes (no offset). Read as-is, the browser
// would treat them as local time and every "Xh ago" / trial countdown would be
// off by the viewer's UTC offset — normalize to an explicit UTC string first.
export function asUtc(value) {
  if (!value || typeof value !== "string") return value ?? null;
  if (!value.includes("T") || /([zZ]|[+-]\d{2}:?\d{2})$/.test(value)) return value;
  return `${value}Z`;
}

// The create endpoint validates `email` as an EmailStr: an empty string is a
// 422, not "no email". Optional fields left blank are omitted instead.
export function buildOrganizationPayload(form) {
  const payload = {};
  for (const [key, value] of Object.entries(form)) {
    const text = typeof value === "string" ? value.trim() : value;
    if (text !== "" && text != null) payload[key] = text;
  }
  return payload;
}

const EMPTY_ORG_FORM = {
  organization_name: "",
  industry: "",
  email: "",
  address: "",
  phone: "",
  tax_no: "",
  registration_number: "",
  country: "",
  currency: "",
};

// Loads the backend's supported countries and their default currencies once
// per modal open. A failure is surfaced, never replaced by a guessed list.
function useCountryDefaults(open) {
  const [state, setState] = useState({ countries: [], currencies: [], loading: true, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    getCountryDefaults()
      .then((res) => {
        if (cancelled) return;
        const countries = (res?.countries || []).filter((c) => c.currency);
        const codes = [...new Set(countries.map((c) => c.currency))].sort();
        const currencies = codes.map((code) => {
          const info = getCurrencyInfo(code);
          return { value: code, label: info?.name ? `${code} — ${info.name}` : code };
        });
        setState({ countries, currencies, loading: false, error: null });
      })
      .catch((e) => {
        if (!cancelled) setState({ countries: [], currencies: [], loading: false, error: e?.message || "Failed to load countries." });
      });
    return () => { cancelled = true; };
  }, [open, attempt]);

  return { ...state, retry: () => setAttempt((n) => n + 1) };
}


function CreateOrganizationModal({ open, onClose, onCreated }) {
  const [form, setForm] = useState(EMPTY_ORG_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const countryDefaults = useCountryDefaults(open);

  // Reset to a blank form each time the modal is (re-)opened, so a prior
  // create/cancel never leaks into the next one.
  useEffect(() => {
    if (open) {
      setForm(EMPTY_ORG_FORM);
      setError(null);
    }
  }, [open]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  // Picking a country pre-selects its default billing currency; the currency
  // stays editable for organizations billed in a different one.
  function handleCountryChange(e) {
    const country = e.target.value;
    const match = countryDefaults.countries.find((c) => c.name === country);
    setForm((f) => ({ ...f, country, currency: match?.currency || f.currency }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    if (!form.organization_name.trim()) {
      setError("Enter the organization's name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const org = await createOrganization(buildOrganizationPayload(form));
      onCreated(org);
    } catch (err) {
      setError(err?.message || "Failed to create organization.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New Organization" icon={Building2} size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="create-organization-form" variant="primary" loading={busy}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </>
      }
    >
      <form id="create-organization-form" onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="new-org-name" required className="sm:col-span-2">
          <input
            id="new-org-name"
            required
            value={form.organization_name}
            onChange={set("organization_name")}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        <Field label="Industry" htmlFor="new-org-industry">
          <input
            id="new-org-industry"
            value={form.industry}
            onChange={set("industry")}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        <Field label="Email" htmlFor="new-org-email">
          <input
            id="new-org-email"
            type="email"
            value={form.email}
            onChange={set("email")}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        <Field label="Address" htmlFor="new-org-address" className="sm:col-span-2">
          <input
            id="new-org-address"
            value={form.address}
            onChange={set("address")}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        <Field label="Phone" htmlFor="new-org-phone">
          <input
            id="new-org-phone"
            value={form.phone}
            onChange={set("phone")}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        <Field label="Tax No" htmlFor="new-org-tax">
          <input
            id="new-org-tax"
            value={form.tax_no}
            onChange={set("tax_no")}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        <Field label="Country" htmlFor="new-org-country" required hint="Sets the default billing currency.">
          <select
            id="new-org-country"
            required
            value={form.country}
            onChange={handleCountryChange}
            disabled={countryDefaults.loading || !!countryDefaults.error}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50"
          >
            <option value="">{countryDefaults.loading ? "Loading countries…" : "Select country"}</option>
            {countryDefaults.countries.map((c) => (
              <option key={c.code} value={c.name}>{c.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Billing Currency" htmlFor="new-org-currency" required>
          <select
            id="new-org-currency"
            required
            value={form.currency}
            onChange={set("currency")}
            disabled={countryDefaults.loading || !!countryDefaults.error}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50"
          >
            <option value="">Select currency</option>
            {countryDefaults.currencies.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </Field>
        {countryDefaults.error && (
          <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 sm:col-span-2">
            Couldn't load the country list: {countryDefaults.error}{" "}
            <button type="button" onClick={countryDefaults.retry} className="font-semibold underline">Retry</button>
          </p>
        )}
        <Field label="Registration Number" htmlFor="new-org-registration" className="sm:col-span-2">
          <input
            id="new-org-registration"
            value={form.registration_number}
            onChange={set("registration_number")}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 sm:col-span-2">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

// ── Directory presentation helpers ───────────────────────────────────────────

// One billing badge. Source ("registered via") and classification were two
// badges that, for nearly every tenant, both read "Standalone". Show the
// classification, and the source only when it says something different.
const SOURCE_LABELS = { registered_via_standalone: "Standalone", registered_via_zoiko_one: "Zoiko One" };
function BillingBadge({ classification, source }) {
  const sourceLabel = SOURCE_LABELS[source] || null;
  const classLabel = CLASSIFICATION_LABEL(classification);
  return (
    <span className="flex flex-col items-start gap-0.5">
      <CommercialClassificationBadge value={classification} />
      {sourceLabel && sourceLabel !== classLabel && (
        <span className="text-[11px] text-slate-500">via {sourceLabel}</span>
      )}
    </span>
  );
}
const CLASSIFICATION_LABEL = (value) =>
  ({ commercial_standalone: "Standalone", commercial_zoiko_one: "Zoiko One" })[value] || null;

const AVATAR_TONES = [
  "bg-brand-50 text-brand-700",
  "bg-emerald-50 text-emerald-700",
  "bg-violet-50 text-violet-700",
  "bg-amber-50 text-amber-700",
  "bg-sky-50 text-sky-700",
  "bg-rose-50 text-rose-700",
];

function initialsOf(name) {
  const words = (name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}

function OrgAvatar({ name, seed }) {
  const tone = AVATAR_TONES[Math.abs(Number(seed) || 0) % AVATAR_TONES.length];
  return (
    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold ${tone}`} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}

function relativeTime(value) {
  if (!value) return null;
  const ts = new Date(asUtc(value)).getTime();
  if (Number.isNaN(ts)) return null;
  const minutes = Math.floor((Date.now() - ts) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

function UsersMeter({ active, total, admins }) {
  const pct = total > 0 ? Math.round((active / total) * 100) : 0;
  return (
    <div className="w-full max-w-28">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-semibold text-slate-700">
          {displayValue(active)}<span className="font-normal text-slate-400">/{displayValue(total)}</span>
        </span>
        {admins > 0 && <span className="text-[10px] text-slate-500">{admins} admin{admins === 1 ? "" : "s"}</span>}
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100" title={`${active} of ${total} users active`}>
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Clickable status tiles: fleet-wide counts that double as the filter. */
function AccountStatusOverview({ counts, selected, onSelect }) {
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null;
  const tiles = [{ key: "", label: "All organizations", count: total, dot: "bg-slate-800" }].concat(
    ACCOUNT_STATUS_ORDER.map((key) => ({ key, label: ACCOUNT_STATUS[key].label, count: counts ? counts[key] ?? 0 : null, dot: ACCOUNT_STATUS[key].dot }))
  );
  return (
    <div role="group" aria-label="Filter by account status" className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
      {tiles.map((tile) => {
        const active = selected === tile.key;
        const empty = tile.key !== "" && tile.count === 0;
        return (
          <button
            key={tile.key || "all"}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(tile.key)}
            className={`rounded-2xl border p-3.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
              active ? "border-brand-500 bg-brand-50 shadow-sm" : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm"
            } ${empty && !active ? "opacity-60" : ""}`}
          >
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <span className={`h-2 w-2 rounded-full ${tile.dot}`} aria-hidden="true" />
              <span className="truncate">{tile.label}</span>
            </span>
            <span className={`mt-1.5 block text-2xl font-extrabold ${active ? "text-brand-700" : "text-slate-800"}`}>
              {tile.count == null ? "—" : tile.count.toLocaleString()}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default function OrganizationsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  // The Lifecycle & Onboarding, Tenant Health and Support Access tabs were
  // removed from this page. Old ?tab= links (bookmarks) just open the
  // directory; drop the stale param so it doesn't linger in the URL.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.has("tab")) setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);
  const [orgs, setOrgs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  // ?status=<account_status> opens the list pre-filtered (dashboard links).
  const [statusFilter, setStatusFilter] = useState(() => {
    const value = searchParams.get("status");
    return value && ACCOUNT_STATUS_ORDER.includes(value) ? value : "";
  });
  // Once the user picks another filter, drop the deep-link param so a reload
  // doesn't resurrect it.
  useEffect(() => {
    const linked = searchParams.get("status");
    if (linked && linked !== statusFilter) {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete("status");
        return next;
      }, { replace: true });
    }
  }, [statusFilter, searchParams, setSearchParams]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState(location.state?.notice || null);

  // Fleet-wide count per account status, returned with every directory page.
  const [statusCounts, setStatusCounts] = useState(null);

  // Only the latest request may write state: a slow response for an older
  // search/filter must not overwrite the list the user is now looking at.
  const loadSeq = useRef(0);
  const load = useCallback(async (pageNum, term, state) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const data = await listOrganizations({
        skip: (pageNum - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
        search: term,
        account_status: state || undefined,
      });
      if (seq !== loadSeq.current) return;
      setOrgs(data.organizations || []);
      setTotal(data.total || 0);
      if (data.status_counts) setStatusCounts(data.status_counts);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setError(err?.message || "Failed to load organizations.");
      setOrgs([]);
      setTotal(0);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(page, search, statusFilter);
  }, [load, page, search, statusFilter]);

  // Success notices dismiss themselves; the X still closes one early.
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (location.state?.notice) {
      // Clear the router state so a page refresh doesn't re-show the banner.
      navigate(location.pathname, { replace: true, state: {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSearch = useCallback((value) => {
    setSearch(value);
    setPage(1);
  }, []);

  const selectStatus = useCallback((state) => {
    setStatusFilter(state);
    setPage(1);
  }, []);

  // Bumped on clear to remount SearchInput, so text still inside its debounce
  // window is discarded instead of re-applying the search a moment later.
  const [searchResetKey, setSearchResetKey] = useState(0);
  const hasActiveFilters = Boolean(search || statusFilter);
  const clearFilters = useCallback(() => {
    setSearchResetKey((k) => k + 1);
    setSearch("");
    setStatusFilter("");
    setPage(1);
  }, []);

  const openOrg = useCallback((id) => navigate(`/super-admin/organizations/${id}`), [navigate]);

  const columns = useMemo(
    () => [
      {
        key: "organization",
        label: "Organization",
        // A guaranteed share of the fixed-layout table, and the name wraps
        // (up to two lines) instead of being cut to "Acme Interna…".
        width: "34%",
        render: (row) => (
          <div className="flex min-w-0 items-center gap-3">
            <OrgAvatar name={row.organization_name} seed={row.id} />
            <span className="min-w-0">
              <span className="line-clamp-2 break-words text-sm font-semibold leading-snug text-slate-900" title={row.organization_name}>
                {row.organization_name}
              </span>
              <span className="block truncate text-xs text-slate-500" title={row.organization_code}>
                {row.organization_code}
                {row.country ? ` · ${row.country}` : ""}
              </span>
            </span>
          </div>
        ),
      },
      {
        key: "account_status",
        label: "Status",
        width: "15%",
        render: (row) => {
          const trial = row.account_status === "trial"
            ? formatTrialRemaining(asUtc(row.trial_ends_at), row.subscription_status, asUtc(row.recovery_ends_at))
            : null;
          const pastDue = row.subscription_status === "past_due";
          return (
            <div className="flex flex-col items-start gap-1.5 min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <AccountStatusBadge value={row.account_status} />
                {pastDue && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-bold text-orange-700">
                    <AlertTriangle size={10} /> Past due
                  </span>
                )}
              </div>
              {trial && (
                <div className="w-full min-w-0">
                  <div className="mb-1 text-[10px] font-semibold text-slate-600 truncate">{trial.label}</div>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-slate-200">
                    <div className="h-full rounded-full bg-blue-500 transition-[width]" style={{ width: `${trial.percent ?? 0}%` }} />
                  </div>
                </div>
              )}
            </div>
          );
        },
      },
      {
        key: "subscription_plan",
        label: "Plan",
        width: "17%",
        hideBelow: "md",
        render: (row) => {
          const subStatus = SUBSCRIPTION_STATUS_OPTIONS.find((s) => s.value === row.subscription_status);
          const trial = row.account_status === "trial"
            ? formatTrialRemaining(asUtc(row.trial_ends_at), row.subscription_status, asUtc(row.recovery_ends_at))
            : null;
          const hasPlan = Boolean(row.subscription_plan_code);
          const planName = row.subscription_plan_name || row.subscription_plan_code || null;

          if (!hasPlan) {
            return (
              <div className="flex flex-col items-start gap-1 min-w-0">
                <span className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-400 bg-slate-50">
                  <MinusCircle size={12} className="text-slate-400" /> No plan
                </span>
                <span className="text-[10px] font-medium text-slate-400">Unassigned</span>
              </div>
            );
          }

          const isTrial = trial && row.subscription_status === "trialing";
          const isActive = row.subscription_status === "active";
          const isPastDue = row.subscription_status === "past_due";

          return (
            <div className="flex flex-col items-start gap-1.5 min-w-0">
              <div className="flex min-w-0 max-w-full items-center gap-2">
                <span className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-xl border px-2.5 py-1 text-xs font-semibold ${
                  isTrial ? "bg-blue-50 border-blue-100 text-blue-700" :
                  isActive ? "bg-emerald-50 border-emerald-100 text-emerald-700" :
                  isPastDue ? "bg-orange-50 border-orange-100 text-orange-700" :
                  subStatus?.color || "bg-slate-100 border-slate-200 text-slate-700"
                }`} title={planName}>
                  {isTrial ? <Clock size={12} className="shrink-0 text-blue-600" /> : <CreditCard size={12} className="shrink-0 text-slate-500" />}
                  <span className="truncate">{planName}</span>
                </span>
              </div>
              <span className="text-[10px] font-medium text-slate-500 truncate" title={subStatus?.label || row.subscription_status}>
                {subStatus?.label || row.subscription_status || "Status unknown"}
              </span>
            </div>
          );
        },
      },
      {
        key: "source",
        label: "Billing",
        width: "11%",
        // Only on very wide screens — it competed with the name for space.
        hideBelow: "2xl",
        render: (row) => (
          <BillingBadge classification={row.billing_classification} source={row.billing_source} />
        ),
      },
      {
        key: "users",
        label: "Users",
        width: "9%",
        hideBelow: "lg",
        render: (row) => <UsersMeter active={row.active_users || 0} total={row.total_users || 0} admins={row.org_admins || 0} />,
      },
      {
        key: "activity",
        label: "Last activity",
        width: "9%",
        hideBelow: "lg",
        render: (row) => (
          <span className="block text-xs leading-5">
            <span className="block font-medium text-slate-700" title={row.last_activity_at ? formatDateTime(asUtc(row.last_activity_at)) : undefined}>
              {relativeTime(row.last_activity_at) || <span className="font-normal text-slate-400">No activity</span>}
            </span>
            <span className="block text-slate-400" title={`Created ${formatDateTime(asUtc(row.created_at))}`}>
              Joined {relativeTime(row.created_at) || "—"}
            </span>
          </span>
        ),
      },
      {
        key: "open",
        label: "",
        width: "5%",
        align: "right",
        headerClassName: "px-2",
        render: () => <ChevronRight size={15} className="ml-auto text-slate-300" />,
      },
    ],
    []
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const fleetTotal = statusCounts ? Object.values(statusCounts).reduce((a, b) => a + b, 0) : null;

  return (
    <div className="min-w-0 max-w-full space-y-8 overflow-x-hidden bg-[#0B1F4B]/3 py-8 sm:py-12 px-6 sm:px-8">
      <PageHeader
        title="Organizations"
        description="Every tenant on the platform — account status, plan, trial time and users. Select a row to open the organization. Financial records stay behind privileged access."
        icon={Building2}
        accent="navy"
        meta={fleetTotal != null ? `${displayValue(fleetTotal)} organization(s) on the platform` : undefined}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
            New Organization
          </Button>
        }
      />

      {notice && <SuccessMessage message={notice} onDismiss={() => setNotice(null)} />}

      <AccountStatusOverview counts={statusCounts} selected={statusFilter} onSelect={selectStatus} />

      <div className="min-w-0">
        <section className="min-w-0 rounded-3xl border border-[#0B1F4B]/20 bg-white shadow-[0_20px_50px_-10px_rgba(11,31,75,0.15)]" aria-label="Organization directory">
          <div className="flex flex-wrap items-center gap-3 border-b border-[#0B1F4B]/10 p-6 sm:p-8">
            <SearchInput
              key={searchResetKey}
              value={search}
              onChange={onSearch}
              placeholder="Search by name, code or legal name…"
              className="w-full min-w-0 flex-1 sm:max-w-sm"
            />
            <span className="text-xs font-medium text-slate-500" aria-live="polite">
              {loading ? "Loading…" : `${displayValue(total)} result${total === 1 ? "" : "s"}`}
              {statusFilter && ` · ${ACCOUNT_STATUS[statusFilter]?.label || statusFilter}`}
            </span>
            <button
              type="button"
              onClick={clearFilters}
              disabled={!hasActiveFilters}
              title={hasActiveFilters ? "Reset search and status filter" : "No filters applied"}
              className="ml-auto inline-flex items-center gap-1 whitespace-nowrap rounded-xl border border-[#0B1F4B]/30 px-3 py-2 text-xs font-medium text-[#0B1F4B] hover:bg-[#0B1F4B]/10 hover:text-[#0B1F4B] disabled:cursor-not-allowed disabled:text-slate-400 disabled:border-slate-200 disabled:hover:bg-transparent"
            >
              <X size={14} />
              Clear filters
            </button>
          </div>

          <div className="p-4 sm:p-6">
            {error ? (
              <ErrorState message={error} onRetry={() => load(page, search, statusFilter)} title="Unable to load organizations" />
            ) : loading && orgs.length === 0 ? (
              <Spinner className="mx-auto" />
            ) : (
              <DataTable
                columns={columns}
                data={orgs}
                loading={loading}
                onRowClick={(row) => openOrg(row.id)}
                emptyTitle="No organizations found"
                emptyMessage={hasActiveFilters ? "No organizations match your filters." : "Organizations will appear here once they are provisioned."}
                emptyAction={
                  hasActiveFilters ? (
                    <Button variant="secondary" size="sm" icon={X} onClick={clearFilters}>Clear filters</Button>
                  ) : (
                    <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreating(true)}>New Organization</Button>
                  )
                }
                minWidth={720}
                tableClassName="table-fixed [&_th]:align-middle [&_td]:align-top"
                stickyHeader={false}
                striped
              />
            )}
          </div>

          {!error && totalPages > 1 && (
            <div className="border-t border-[#0B1F4B]/10 px-4 py-4 sm:p-6">
              <Pagination page={page} totalPages={totalPages} onPageChange={setPage}>
                {displayValue(total)} organization(s)
              </Pagination>
            </div>
          )}
        </section>
      </div>

      <CreateOrganizationModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(org) => {
          setCreating(false);
          setNotice(`Organization "${org?.organization_name || "New organization"}" created.`);
          // Changing the page re-runs the load effect; on page 1 reload directly.
          if (page === 1) load(1, search, statusFilter);
          else setPage(1);
        }}
      />
    </div>
  );
}
