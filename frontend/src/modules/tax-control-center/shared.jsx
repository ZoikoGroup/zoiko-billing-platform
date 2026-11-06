import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AlertCircle, AlertTriangle, Archive, BadgeCheck, CheckCircle2, Circle, Clock, FileEdit, KeyRound,
  Lock, MinusCircle, ShieldCheck, XCircle,
} from "lucide-react";

import { Button, Field, FORM_CONTROL_CLASS, FormModal, Modal } from "../../components/billing-ui";
import { fetchAllPages, listApprovalsInbox, listTaxPeople } from "./taxRegistryService";

/* Shared foundations of the Tax Control Center (Phase 5a): cursor lists,
 * status badges (icon + text, never colour alone), the MFA step-up prompt
 * with one retry, the maker-checker action bar, the version timeline, and
 * the no-access page. */

export const PANEL = "rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 dark:border-slate-700 dark:bg-slate-900";
export const MUTED = "text-slate-500 dark:text-slate-400";
export const STRONG = "text-slate-900 dark:text-slate-100";

// ── Status badges ────────────────────────────────────────────────────────

const STATUS_STYLES = {
  ACTIVE: { icon: CheckCircle2, label: "Active", tone: "green" },
  PUBLISHED: { icon: CheckCircle2, label: "Published", tone: "green" },
  PASSED: { icon: CheckCircle2, label: "Passed", tone: "green" },
  CAPTURED: { icon: CheckCircle2, label: "Evidence captured", tone: "green" },
  APPROVED: { icon: BadgeCheck, label: "Approved", tone: "blue" },
  VALIDATED: { icon: ShieldCheck, label: "Validated", tone: "blue" },
  IN_APPROVAL: { icon: Clock, label: "In approval", tone: "amber" },
  PENDING_REVIEW: { icon: FileEdit, label: "Draft", tone: "slate" },
  NOT_STARTED: { icon: Circle, label: "Not started", tone: "slate" },
  NOT_CAPTURED: { icon: Circle, label: "Evidence not captured", tone: "amber" },
  NOT_APPLICABLE: { icon: MinusCircle, label: "Not applicable", tone: "slate" },
  VALIDATION_FAILED: { icon: AlertTriangle, label: "Validation failed", tone: "red" },
  CONFLICT_ESCALATED: { icon: AlertTriangle, label: "Conflict escalated", tone: "red" },
  FAILED: { icon: XCircle, label: "Failed", tone: "red" },
  REJECTED: { icon: XCircle, label: "Rejected", tone: "red" },
  SUPERSEDED: { icon: Archive, label: "Superseded", tone: "slate" },
  // Tenant Settings → Taxes (Phase 5b)
  PROPOSED: { icon: Clock, label: "Proposed", tone: "amber" },
  WITHDRAWN: { icon: MinusCircle, label: "Withdrawn", tone: "slate" },
  OPEN: { icon: AlertTriangle, label: "Open", tone: "amber" },
  RESOLVED: { icon: CheckCircle2, label: "Resolved", tone: "green" },
  REVOKED: { icon: XCircle, label: "Revoked", tone: "red" },
  EXPIRED: { icon: Clock, label: "Expired", tone: "red" },
  STALE: { icon: AlertTriangle, label: "Stale", tone: "amber" },
  AMBIGUOUS: { icon: AlertTriangle, label: "Ambiguous", tone: "amber" },
  NOT_FOUND: { icon: XCircle, label: "Not found", tone: "red" },
  NOT_RESOLVED: { icon: Circle, label: "Not resolved", tone: "slate" },
  VERIFIED: { icon: BadgeCheck, label: "Verified", tone: "green" },
  UNVERIFIED: { icon: Circle, label: "Unverified", tone: "slate" },
  INVALID: { icon: XCircle, label: "Invalid", tone: "red" },
  GOVERNED: { icon: ShieldCheck, label: "Governed", tone: "blue" },
  LEGACY_MANUAL: { icon: FileEdit, label: "Legacy manual", tone: "slate" },
  EFFECTIVE: { icon: CheckCircle2, label: "In effect", tone: "green" },
  NOT_EFFECTIVE: { icon: XCircle, label: "Not in effect", tone: "red" },
  SUSPENDED: { icon: Lock, label: "Suspended", tone: "red" },
};

const TONES = {
  green: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  blue: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200",
  amber: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
  red: "border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
  slate: "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
};

export function humanize(value) {
  if (!value) return "—";
  const s = String(value).replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A status as icon + text: the meaning never depends on colour. */
export function TaxStatusBadge({ status }) {
  const meta = STATUS_STYLES[status] || { icon: Circle, label: humanize(status), tone: "slate" };
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONES[meta.tone]}`}>
      <Icon size={13} aria-hidden="true" />
      <span>{meta.label}</span>
    </span>
  );
}

export function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

// ── Reference lists and tax-staff names (Phase 5b) ───────────────────────

/** All pages of a small reference list, loaded once per mount when `enabled`. */
export function useReferenceList(fetchPage, enabled = true) {
  const [items, setItems] = useState([]);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    fetchAllPages((args) => fetchRef.current(args)).then((all) => { if (!cancelled) setItems(all); }).catch(() => {});
    return () => { cancelled = true; };
  }, [enabled]);
  return items;
}

let peoplePromise = null;
/** Test hook: forget the cached tax-staff names. */
export function resetPeopleCache() { peoplePromise = null; }

const ROLE_NAMES = { TAX_REVIEWER: "Tax Reviewer", TAX_PUBLISHER: "Tax Publisher" };

/**
 * `nameOf(id)` → "Mara Maker (Tax Reviewer)" for platform tax staff (the
 * /people lookup, fetched once and shared), else "user #id" until loaded or
 * when the id isn't tax staff.
 */
export function usePeopleNames() {
  const [people, setPeople] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (!peoplePromise) peoplePromise = fetchAllPages(listTaxPeople).catch(() => { peoplePromise = null; return []; });
    peoplePromise.then((all) => { if (!cancelled) setPeople(new Map(all.map((p) => [p.id, p]))); });
    return () => { cancelled = true; };
  }, []);
  return useCallback((id) => {
    if (id == null) return null;
    const p = people?.get(id);
    return p ? `${p.name} (${ROLE_NAMES[p.platform_role] || humanize(p.platform_role)})` : `user #${id}`;
  }, [people]);
}

// ── Cursor lists (B3) ────────────────────────────────────────────────────

/**
 * Loads the first page of a B3 list and follows next_cursor on "Load more".
 * `fetchPage({ cursor })` returns `{ items, next_cursor }`. `deps` reload
 * from the first page (filters).
 */
export function useCursorList(fetchPage, deps = []) {
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const generation = useRef(0);

  const load = useCallback(async (cursor) => {
    const gen = cursor ? generation.current : ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchRef.current({ cursor: cursor || undefined });
      if (gen !== generation.current) return;
      const page = data?.items || [];
      setItems((prev) => (cursor ? [...prev, ...page] : page));
      setNextCursor(data?.next_cursor || null);
    } catch (err) {
      if (gen === generation.current) setError(err?.message || "Couldn't load this list.");
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {
    items, loading, error, hasMore: Boolean(nextCursor),
    loadMore: () => nextCursor && load(nextCursor),
    reload: () => load(null),
  };
}

export function LoadMore({ list, noun = "items" }) {
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <p className={`text-xs ${MUTED}`} aria-live="polite">
        Showing {list.items.length} {noun}{list.hasMore ? " — more available" : ""}
      </p>
      {list.hasMore && (
        <Button size="sm" onClick={list.loadMore} loading={list.loading}>
          Load more
        </Button>
      )}
    </div>
  );
}

export function InlineError({ message }) {
  if (!message) return null;
  return (
    <div role="alert" className="mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

// ── MFA step-up: prompt, then retry the action once ──────────────────────

export const STEP_UP_ERROR = "TAX_REGISTRY_STEP_UP_REQUIRED";

function StepUpModal({ open, onCancel, onSubmit, busy, error }) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState("");
  const inputId = useId();
  useEffect(() => { if (open) { setValue(""); setUseRecovery(false); } }, [open]);
  return (
    <FormModal
      open={open}
      onClose={onCancel}
      onSubmit={() => onSubmit(useRecovery ? { recovery_code: value.trim() } : { code: value.trim() })}
      title="Confirm with MFA"
      description="Approving and publishing tax registry changes needs a fresh authenticator code."
      icon={KeyRound}
      busy={busy}
      error={error}
      submitLabel="Confirm"
    >
      <Field label={useRecovery ? "Recovery code" : "Authenticator code"} htmlFor={inputId} required>
        <input
          id={inputId}
          className={FORM_CONTROL_CLASS}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          inputMode={useRecovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          minLength={6}
          maxLength={useRecovery ? 20 : 8}
          required
          autoFocus
        />
      </Field>
      <button
        type="button"
        className="text-sm font-medium text-brand-700 underline underline-offset-2 dark:text-brand-300"
        onClick={() => setUseRecovery((v) => !v)}
      >
        {useRecovery ? "Use an authenticator code instead" : "Use a recovery code instead"}
      </button>
    </FormModal>
  );
}

/**
 * `run(action, body)` calls `action(body)`. If the backend answers
 * TAX_REGISTRY_STEP_UP_REQUIRED, it prompts for a code and retries the
 * action once with it. Resolves with the action's result, or null when the
 * user cancels; other errors reject.
 */
export function useStepUp() {
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = useCallback(async (action, body = {}) => {
    try {
      return await action(body);
    } catch (err) {
      if (err?.code !== STEP_UP_ERROR) throw err;
      return new Promise((resolve, reject) => {
        setError(null);
        setPending({ action, body, resolve, reject });
      });
    }
  }, []);

  const submit = async (factor) => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const result = await pending.action({ ...pending.body, ...factor });
      pending.resolve(result);
      setPending(null);
    } catch (err) {
      // A wrong code is shown in the prompt; the user may try another code.
      setError(err?.message || "Step-up failed.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    if (busy) return;
    pending?.resolve(null);
    setPending(null);
  };

  const modal = <StepUpModal open={Boolean(pending)} onCancel={cancel} onSubmit={submit} busy={busy} error={error} />;
  return { run, modal };
}

// ── The backend's approve verdict for one version ────────────────────────

/**
 * For a version IN_APPROVAL, the inbox's can_approve / reason_if_not for
 * the current user (the backend's own maker-checker answer). Pages through
 * the inbox for that kind until the item is found. `fallback` is used for
 * other statuses (e.g. publish after approval).
 */
export function useApprovalVerdict(kind, version, fallbackReason) {
  const [verdict, setVerdict] = useState(null);
  const id = version?.id;
  const inApproval = version?.status === "IN_APPROVAL";
  useEffect(() => {
    let cancelled = false;
    setVerdict(null);
    if (!inApproval || id == null) return undefined;
    (async () => {
      let cursor;
      for (let page = 0; page < 20; page += 1) {
        const data = await listApprovalsInbox({ kind, cursor });
        const hit = (data?.items || []).find((i) => i.id === id);
        if (hit) {
          if (!cancelled) setVerdict({ canApprove: hit.can_approve, reason: hit.reason_if_not });
          return;
        }
        if (!data?.next_cursor) break;
        cursor = data.next_cursor;
      }
      if (!cancelled) setVerdict({ canApprove: !fallbackReason, reason: fallbackReason });
    })().catch(() => { if (!cancelled) setVerdict({ canApprove: !fallbackReason, reason: fallbackReason }); });
    return () => { cancelled = true; };
  }, [kind, id, inApproval, fallbackReason]);
  if (!inApproval) return { canApprove: !fallbackReason, reason: fallbackReason, loading: false };
  return verdict ? { ...verdict, loading: false } : { canApprove: false, reason: null, loading: true };
}

// ── Reason prompt (submit / reject need a reason) ────────────────────────

export function ReasonModal({ open, title, description, submitLabel, busy, error, onCancel, onSubmit, minLength = 1 }) {
  const [reason, setReason] = useState("");
  const id = useId();
  useEffect(() => { if (open) setReason(""); }, [open]);
  return (
    <FormModal open={open} onClose={onCancel} onSubmit={() => onSubmit(reason.trim())} title={title}
               description={description} busy={busy} error={error} submitLabel={submitLabel}>
      <Field label="Reason" htmlFor={id} required hint="Recorded in the approval record and the audit log.">
        <textarea id={id} className={FORM_CONTROL_CLASS} rows={3} value={reason} minLength={minLength}
                  onChange={(e) => setReason(e.target.value)} required />
      </Field>
    </FormModal>
  );
}

// ── Maker-checker action bar ─────────────────────────────────────────────

/**
 * actions: [{ key, label, onClick, variant, disabled, reason, hidden }].
 * A disabled action shows why, as text tied to the button (never only a
 * greyed-out control). The backend enforces the same rules.
 */
export function ActionBar({ actions, busyKey }) {
  const visible = actions.filter((a) => !a.hidden);
  if (!visible.length) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {visible.map((a) => (
          <Button
            key={a.key}
            variant={a.variant || "secondary"}
            size="sm"
            onClick={a.onClick}
            disabled={Boolean(a.reason) || a.disabled}
            loading={busyKey === a.key}
            aria-describedby={a.reason ? `why-${a.key}` : undefined}
          >
            {a.label}
          </Button>
        ))}
      </div>
      {visible.filter((a) => a.reason).map((a) => (
        <p key={a.key} id={`why-${a.key}`} className={`flex items-start gap-1.5 text-xs ${MUTED}`}>
          <Lock size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span><strong>{a.label} unavailable:</strong> {a.reason}</span>
        </p>
      ))}
    </div>
  );
}

// ── Version timeline (history) ───────────────────────────────────────────

/** The version's lifecycle from its own timestamps and people. */
export function VersionTimeline({ version }) {
  const nameOf = usePeopleNames();
  const entries = [
    ["Drafted", version.created_at, version.created_by_user_id ?? version.maker_user_id],
    ["Submitted for approval", version.submitted_at, version.maker_user_id],
    ["Approved", version.approved_at, version.checker_user_id],
    ["Published", version.published_at, version.publisher_user_id],
    ["Superseded", version.superseded_at, null],
  ].filter(([, at]) => at);
  if (version.status === "REJECTED") entries.push(["Rejected", null, version.checker_user_id]);
  return (
    <ol className="space-y-2" aria-label="Version history">
      {entries.map(([label, at, who]) => (
        <li key={label} className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className={`font-semibold ${STRONG}`}>{label}</span>
          <span className={MUTED}>{formatDateTime(at)}{who != null ? ` · ${nameOf(who)}` : ""}</span>
        </li>
      ))}
      {version.rejection_reason && (
        <li className={`text-sm ${MUTED}`}>Reason: {version.rejection_reason}</li>
      )}
      {version.predecessor_id && (
        <li className={`text-sm ${MUTED}`}>Replaces version #{version.predecessor_id}</li>
      )}
    </ol>
  );
}

export function ValidationList({ title, items, tone = "red" }) {
  if (!items?.length) return null;
  const color = tone === "red" ? "text-red-800 dark:text-red-200" : "text-amber-900 dark:text-amber-200";
  return (
    <div>
      <p className={`text-xs font-semibold uppercase tracking-wider ${MUTED}`}>{title}</p>
      <ul className={`mt-1 list-disc space-y-1 pl-5 text-sm ${color}`}>
        {items.map((e) => <li key={e}>{e}</li>)}
      </ul>
    </div>
  );
}

// ── Detail drawer and no-access page ─────────────────────────────────────

export function DetailModal({ open, onClose, title, description, children }) {
  return (
    <Modal open={open} onClose={onClose} title={title} description={description} size="lg" ariaLabel={title}>
      <div className="space-y-5">{children}</div>
    </Modal>
  );
}

export function DefinitionList({ rows }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      {rows.filter(Boolean).map(([term, value]) => (
        <div key={term} className="min-w-0">
          <dt className={`text-xs font-semibold uppercase tracking-wider ${MUTED}`}>{term}</dt>
          <dd className={`break-words text-sm ${STRONG}`}>{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function NoAccess() {
  return (
    <div className={`${PANEL} mx-auto max-w-xl text-center`} role="alert">
      <Lock className="mx-auto mb-3 h-8 w-8 text-slate-500" aria-hidden="true" />
      <h1 className={`text-lg font-bold ${STRONG}`}>No access to the Tax Control Center</h1>
      <p className={`mt-2 text-sm ${MUTED}`}>
        This console is for Zoiko tax staff with the Tax Reviewer or Tax Publisher platform role. Other platform
        roles, including Platform Administrator, have no access by default. Ask a platform administrator to assign a
        tax role if you need it.
      </p>
    </div>
  );
}

/** A simple accessible table: caption for screen readers, rows clickable via a button. */
export function TaxTable({ caption, columns, rows, onOpen, empty = "Nothing here yet." }) {
  if (!rows.length) return <p className={`py-6 text-center text-sm ${MUTED}`}>{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className={`border-b border-slate-200 text-xs uppercase tracking-wider dark:border-slate-700 ${MUTED}`}>
            {columns.map((c) => <th key={c.key} scope="col" className="px-3 py-2 font-semibold">{c.label}</th>)}
            {onOpen && <th scope="col" className="px-3 py-2"><span className="sr-only">Open</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id ?? row.key} className="border-b border-slate-100 dark:border-slate-800">
              {columns.map((c) => (
                <td key={c.key} className={`px-3 py-2 align-top ${STRONG}`}>{c.render ? c.render(row) : row[c.key] ?? "—"}</td>
              ))}
              {onOpen && (
                <td className="px-3 py-2 text-right">
                  <Button size="sm" onClick={() => onOpen(row)} aria-label={`Open ${row.title || `#${row.id}`}`}>
                    Open
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
