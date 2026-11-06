import { useCallback, useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { FileMinus } from "lucide-react";

import { Button, Field, FORM_CONTROL_CLASS, Modal } from "../../../components/billing-ui";
import { governedTaxApi } from "../../../service/billingService";
import { formatDisplayCurrency } from "../../../utils/billing-helpers";

/* Governed credit note (ZB-TAX-ARCH-001 Phase 5d, pilot step 3.4).
 * A credit for a SENT governed invoice is reversed from the invoice's
 * committed tax snapshot: the original components, rates and rounding,
 * never today's rates. The screen previews exactly what the server would
 * credit (the same calculation, nothing written), then confirms through the
 * governed credit-note route. The legacy Credit Notes page is unchanged and
 * still refuses governed invoices. */

const titleize = (v) => String(v || "").replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const STUCK = ["REVIEW_REQUIRED", "UNCERTAIN", "FAILED"];
const ADJUST_LABEL = {
  PENDING: "Adjusting at the provider…", UNCERTAIN: "Checking the provider…", REMOTE_COMMITTED: "Adjusted at the provider, finishing…",
  DONE: "Adjusted at the provider", REVIEW_REQUIRED: "Provider adjustment needs review", FAILED: "Provider refused the adjustment",
  CANCELLED: "Provider adjustment cancelled", VOIDED: "Provider adjustment voided",
};

/** fraction of a line to credit for `qty` units: exact remainder when it completes the line. */
export function fractionFor(line, qty) {
  const quantity = Number(line.quantity);
  const remaining = Number(line.remaining_fraction);
  if (!(qty > 0) || !(quantity > 0)) return null;
  const f = qty / quantity;
  if (f >= remaining - 1e-9) return String(line.remaining_fraction);
  return f.toFixed(10);
}

export function AdjustStatus({ adjust }) {
  if (!adjust) return null;
  return (
    <span className="text-xs">
      <span className={STUCK.includes(adjust.state) ? "text-red-800 font-semibold" : "text-slate-700"}>
        {ADJUST_LABEL[adjust.state] || titleize(adjust.state)}
      </span>
      {adjust.last_error ? <span className="text-slate-600"> · {adjust.last_error}</span> : null}
      {STUCK.includes(adjust.state) && (
        <> · <Link to="/billing/tax/governance/transactions" className="underline text-brand-700">Open stuck transactions</Link></>
      )}
    </span>
  );
}

export default function GovernedCreditNoteModal({ invoiceId, open, onClose, onCreated }) {
  const base = useId();
  const [data, setData] = useState(null);
  const [mode, setMode] = useState("full");
  const [qty, setQty] = useState({});
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState(null);
  const [created, setCreated] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const cur = data?.currency;
  const money = (v) => formatDisplayCurrency(v, cur);

  const load = useCallback(async () => {
    try { setData(await governedTaxApi.creditable(invoiceId)); } catch (err) { setError(err?.message || "Couldn't load the invoice's tax snapshot."); }
  }, [invoiceId]);
  useEffect(() => {
    if (!open) return;
    setPreview(null); setCreated(null); setError(null); setReason(""); setQty({}); setMode("full");
    load();
  }, [open, load]);

  const open_lines = (data?.lines || []).filter((l) => Number(l.remaining_fraction) > 0);
  const requested = () => (mode === "full"
    ? open_lines.map((l) => ({ invoice_item_id: l.invoice_item_id, fraction: String(l.remaining_fraction) }))
    : open_lines.map((l) => ({ invoice_item_id: l.invoice_item_id, fraction: fractionFor(l, Number(qty[l.invoice_item_id])) }))
      .filter((l) => l.fraction));
  const problem = () => {
    if (!reason.trim()) return "Give a reason for the credit.";
    if (!requested().length) return "Choose at least one line and a quantity to credit.";
    return null;
  };

  const run = async (key, fn) => {
    setBusy(key);
    setError(null);
    try { await fn(); } catch (err) { setError(err?.message || "The request failed."); } finally { setBusy(null); }
  };
  const doPreview = () => {
    const p = problem();
    if (p) { setError(p); return; }
    run("preview", async () => setPreview(await governedTaxApi.previewCredit(invoiceId, { lines: requested() })));
  };
  const doConfirm = () => run("confirm", async () => {
    const note = await governedTaxApi.createCredit(invoiceId, {
      lines: requested(), reason: reason.trim(), credit_note_type: mode === "full" ? "full_credit" : "partial_credit",
    });
    setCreated(note);
    await load();
    onCreated?.(note);
  });
  const createdAdjust = created && data?.credit_notes?.find((n) => n.id === created.credit_note_id)?.adjust;

  return (
    <Modal open={open} onClose={busy ? undefined : onClose} title="Create governed credit note" icon={FileMinus} size="lg"
           description="Reversed from this invoice's committed tax snapshot: the original rates and rounding, never today's rates.">
      <div className="space-y-4">
        {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
        {!data && !error && <p className="text-sm text-slate-600">Loading…</p>}

        {data?.credit_notes?.length > 0 && !created && (
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-slate-900">Earlier governed credit notes</h3>
            <ul className="space-y-1 text-sm">
              {data.credit_notes.map((n) => (
                <li key={n.id}>{n.credit_note_number}: {money(n.total_amount)} {n.adjust && <AdjustStatus adjust={n.adjust} />}</li>
              ))}
            </ul>
          </div>
        )}

        {data && !created && (
          <>
            {data.provider_committed && (
              <p className="text-xs text-slate-700">This invoice was committed at the tax provider: the credit also adjusts the provider transaction.</p>
            )}
            {!open_lines.length ? (
              <p className="text-sm text-slate-700">Every line of this invoice is already fully credited.</p>
            ) : (
              <>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-semibold text-slate-900">What to credit</legend>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name={`${base}-mode`} checked={mode === "full"} onChange={() => { setMode("full"); setPreview(null); }} />
                    Full credit of everything not yet credited
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name={`${base}-mode`} checked={mode === "partial"} onChange={() => { setMode("partial"); setPreview(null); }} />
                    Partial: choose lines and quantities
                  </label>
                </fieldset>
                {mode === "partial" && (
                  <table className="min-w-full text-left text-sm">
                    <caption className="sr-only">Lines to credit</caption>
                    <thead><tr className="text-xs uppercase text-slate-600">
                      <th scope="col" className="py-1 pr-3">Line</th><th scope="col" className="py-1 pr-3">Invoiced qty</th>
                      <th scope="col" className="py-1 pr-3">Not yet credited</th><th scope="col" className="py-1">Quantity to credit</th>
                    </tr></thead>
                    <tbody>
                      {open_lines.map((l) => {
                        const left = Number(l.quantity) * Number(l.remaining_fraction);
                        return (
                          <tr key={l.invoice_item_id} className="border-t border-slate-100">
                            <td className="py-1.5 pr-3">{l.line_number}. {l.description}</td>
                            <td className="py-1.5 pr-3">{Number(l.quantity)}</td>
                            <td className="py-1.5 pr-3">{Math.round(left * 100) / 100}</td>
                            <td className="py-1.5">
                              <label className="sr-only" htmlFor={`${base}-q-${l.invoice_item_id}`}>Quantity to credit for line {l.line_number}</label>
                              <input id={`${base}-q-${l.invoice_item_id}`} type="number" min="0" step="any" max={left}
                                     className={`${FORM_CONTROL_CLASS} w-28`} value={qty[l.invoice_item_id] ?? ""}
                                     onChange={(e) => { setQty((q) => ({ ...q, [l.invoice_item_id]: e.target.value })); setPreview(null); }} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                <Field label="Reason" htmlFor={`${base}-r`} required>
                  <input id={`${base}-r`} className={FORM_CONTROL_CLASS} value={reason} aria-required="true"
                         onChange={(e) => { setReason(e.target.value); }} />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" loading={busy === "preview"} onClick={doPreview}>Preview credit</Button>
                  {preview && <Button size="sm" variant="primary" loading={busy === "confirm"} onClick={doConfirm}>Confirm credit note</Button>}
                </div>
              </>
            )}

            {preview && (
              <div className="space-y-2" aria-live="polite">
                <h3 className="text-sm font-semibold text-slate-900">Preview: what will be reversed</h3>
                <table className="min-w-full text-left text-sm">
                  <caption className="sr-only">Credit preview by line</caption>
                  <thead><tr className="text-xs uppercase text-slate-600">
                    <th scope="col" className="py-1 pr-3">Line</th><th scope="col" className="py-1 pr-3">Net</th>
                    <th scope="col" className="py-1 pr-3">Tax</th><th scope="col" className="py-1">Legal treatment</th>
                  </tr></thead>
                  <tbody>
                    {preview.lines.map((l) => (
                      <tr key={l.invoice_item_id} className="border-t border-slate-100 align-top">
                        <td className="py-1.5 pr-3">{l.line_number}. {l.description}</td>
                        <td className="py-1.5 pr-3">{money(l.credited_net)}</td>
                        <td className="py-1.5 pr-3">
                          {l.components.map((c) => (
                            <div key={c.component_code}>{c.label || c.component_code} {Number(c.rate_percent)}%: {money(c.credited_tax)}</div>
                          ))}
                        </td>
                        <td className="py-1.5">{titleize(l.outcome)}{l.legal_reason ? ` · ${l.legal_reason}` : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <dl className="grid grid-cols-3 gap-2 text-sm">
                  <div><dt className="text-slate-600">Net</dt><dd className="font-semibold">{money(preview.subtotal)}</dd></div>
                  <div><dt className="text-slate-600">Tax</dt><dd className="font-semibold">{money(preview.tax_amount)}</dd></div>
                  <div><dt className="text-slate-600">Gross</dt><dd className="font-semibold">{money(preview.total_amount)}</dd></div>
                </dl>
              </div>
            )}
          </>
        )}

        {created && (
          <div role="status" className="space-y-2">
            <p className="text-sm font-semibold text-slate-900">
              Credit note {created.credit_note_number} created: {money(created.total_amount)} (tax {money(created.tax_amount)}).
            </p>
            {data?.provider_committed && (
              <div className="flex flex-wrap items-center gap-2">
                <AdjustStatus adjust={createdAdjust} />
                <Button size="sm" variant="secondary" loading={busy === "refresh"} onClick={() => run("refresh", load)}>Refresh status</Button>
              </div>
            )}
            <Button size="sm" onClick={onClose}>Close</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
