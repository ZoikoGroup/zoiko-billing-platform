import { useState } from "react";
import { Link } from "react-router-dom";

import { Button, Select } from "../../components/billing-ui";
import { approveInboxItem, listApprovalsInbox } from "./taxRegistryService";
import {
  InlineError, LoadMore, MUTED, PANEL, STRONG, formatDateTime, humanize, useCursorList, usePeopleNames, useStepUp,
} from "./shared";

/* P8 Approvals inbox (B1): every platform change IN_APPROVAL. can_approve /
 * reason_if_not come from the backend for the current user; a disabled
 * Approve shows that reason as text. */

const KINDS = [
  { value: "staged_rate", label: "Rates", section: "rates" },
  { value: "market_availability", label: "Market availability", section: "availability" },
  { value: "rule_pack", label: "Rule packs", section: "rule-packs" },
  { value: "tax_code_set", label: "Tax-code sets", section: null },
];

export default function ApprovalsInboxScreen() {
  const [kind, setKind] = useState("");
  const list = useCursorList(({ cursor }) => listApprovalsInbox({ kind: kind || undefined, cursor }), [kind]);
  const stepUp = useStepUp();
  const nameOf = usePeopleNames();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const approve = async (item) => {
    setBusy(`${item.kind}-${item.id}`);
    setError(null);
    setNotice(null);
    try {
      const result = await stepUp.run((body) => approveInboxItem(item.kind, item.id, body));
      if (result) {
        setNotice(`Approved: ${item.title}. Publish it from its screen.`);
        list.reload();
      }
    } catch (err) {
      setError(err?.message || "Approval failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={PANEL} aria-labelledby="inbox-title">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="inbox-title" className={`text-lg font-bold ${STRONG}`}>Approvals inbox</h2>
          <p className={`text-sm ${MUTED}`}>Oldest submission first. Items you prepared or submitted are read-only for you.</p>
        </div>
        <label className="w-56 text-sm">
          <span className={`mb-1 block text-xs font-semibold uppercase tracking-wider ${MUTED}`}>Kind</span>
          <Select value={kind} onChange={setKind} options={KINDS} placeholder="All kinds" aria-label="Filter by kind" />
        </label>
      </div>
      <InlineError message={error || list.error} />
      {notice && <p role="status" className="mb-3 text-sm font-medium text-emerald-800 dark:text-emerald-200">{notice}</p>}
      {list.items.length === 0 && !list.loading ? (
        <p className={`py-6 text-center text-sm ${MUTED}`}>Nothing is waiting for approval.</p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {list.items.map((item) => {
            const meta = KINDS.find((k) => k.value === item.kind);
            const key = `${item.kind}-${item.id}`;
            return (
              <li key={key} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className={`font-semibold ${STRONG}`}>{item.title}</p>
                  <p className={`text-xs ${MUTED}`}>
                    {meta?.label || humanize(item.kind)} #{item.id} · submitted by {nameOf(item.submitted_by)} ·{" "}
                    {formatDateTime(item.submitted_at)}
                  </p>
                  {!item.can_approve && (
                    <p id={`why-${key}`} className={`mt-1 text-xs ${MUTED}`}>
                      <strong>Approve unavailable:</strong> {item.reason_if_not}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  {meta?.section && (
                    <Link to={`/super-admin/tax/${meta.section}`} className="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-semibold text-brand-700 underline underline-offset-2 dark:text-brand-300">
                      Review
                    </Link>
                  )}
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!item.can_approve}
                    loading={busy === key}
                    aria-describedby={item.can_approve ? undefined : `why-${key}`}
                    onClick={() => approve(item)}
                  >
                    Approve
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <LoadMore list={list} noun="items" />
      {stepUp.modal}
    </section>
  );
}
