"""
app/modules/tax/anomaly_service.py
----------------------------------
Live anomaly monitoring (ZB-TAX-ARCH-001 Phase 7 PR 3, handoff §10.1 step 08).

A daily job looks at issued invoices. It never changes one.

Per invoice (tenant review items, deduplicated while open):
  TAX_SNAPSHOT_MISMATCH   a governed invoice's tax, subtotal, total or a line's
                          tax no longer equals its committed quote, to the cent
  PROVIDER_DRIFT          the provider's committed total tax differs from ours
  CREDIT_EXCEEDS_ORIGINAL credit notes (not voided) total more than the invoice,
                          or credit more tax than it charged

Per market (platform alerts via the Attention Engine; aggregate only):
  zero tax                the share of governed invoices with zero tax jumped
                          against the trailing baseline
  rate mix                the share of an effective rate shifted sharply

Each run's aggregate counts are kept in tax_anomaly_runs (no identifiers).
"""
import logging
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Callable, Optional

from sqlalchemy.orm import Session

from app.config import settings
from app.modules.billing.models import CreditNote, CreditNoteStatus, Invoice, InvoiceItem
from app.modules.tax.enums import OutboxOperation, OutboxState, ReviewItemKind, ReviewItemStatus, TaxQuoteStatus
from app.modules.tax.models import TaxReviewItem

logger = logging.getLogger("zoiko_billing.tax.anomalies")
CENT = Decimal("0.01")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _d(v) -> Decimal:
    return Decimal(str(v if v is not None else 0))


def thresholds() -> dict:
    s = settings
    return {
        "lookback_days": int(getattr(s, "TAX_ANOMALY_LOOKBACK_DAYS", 2)),
        "window_days": int(getattr(s, "TAX_ANOMALY_WINDOW_DAYS", 1)),
        "baseline_days": int(getattr(s, "TAX_ANOMALY_BASELINE_DAYS", 30)),
        "min_invoices": int(getattr(s, "TAX_ANOMALY_MIN_INVOICES", 10)),
        "zero_tax_shift": float(getattr(s, "TAX_ANOMALY_ZERO_TAX_SHIFT", 0.2)),
        "rate_mix_shift": float(getattr(s, "TAX_ANOMALY_RATE_MIX_SHIFT", 0.3)),
    }


class AnomalyService:
    def __init__(self, db: Session, now: Callable = _now):
        self.db = db
        self.now = now
        self.t = thresholds()

    # ── review items (tenant) ──
    def _finding(self, organization_id: int, kind: ReviewItemKind, subject_type: str, subject_id: int, detail: str,
                 owner_role: str) -> int:
        open_item = self.db.query(TaxReviewItem).filter(
            TaxReviewItem.organization_id == organization_id, TaxReviewItem.kind == kind,
            TaxReviewItem.subject_type == subject_type, TaxReviewItem.subject_id == subject_id,
            TaxReviewItem.status == ReviewItemStatus.OPEN).first()
        if open_item is not None:
            return 0
        self.db.add(TaxReviewItem(organization_id=organization_id, kind=kind, subject_type=subject_type,
                                  subject_id=subject_id, detail=detail, owner_role=owner_role, created_at=self.now()))
        self.db.flush()
        return 1

    def _issued_since(self, since: date):
        from app.modules.tax.report_service import ISSUED_STATUSES

        return self.db.query(Invoice).filter(Invoice.status.in_(ISSUED_STATUSES), Invoice.issue_date >= since)

    # ── 1. governed invoices reconcile to their snapshot ──
    def check_snapshots(self, since: date) -> dict:
        from app.modules.tax.quote_models import TaxQuote

        checked = mismatched = raised = 0
        for inv in self._issued_since(since).filter(Invoice.tax_quote_id.isnot(None)):
            quote = self.db.get(TaxQuote, inv.tax_quote_id)
            checked += 1
            problems = []
            if quote is None or quote.status != TaxQuoteStatus.COMMITTED:
                problems.append("its tax quote is missing or not committed")
            else:
                for field in ("tax_amount", "subtotal", "total_amount"):
                    if _d(getattr(inv, field)) != _d(getattr(quote, field)):
                        problems.append(f"{field} {_d(getattr(inv, field))} ≠ snapshot {_d(getattr(quote, field))}")
                items = {i.id: i for i in self.db.query(InvoiceItem).filter(InvoiceItem.invoice_id == inv.id)}
                for line in quote.lines:
                    item = items.get(line.document_line_id)
                    if item is None:
                        problems.append(f"line {line.line_number} is missing")
                    elif _d(item.tax_amount) != _d(line.tax_amount):
                        problems.append(f"line {line.line_number} tax {_d(item.tax_amount)} ≠ snapshot {_d(line.tax_amount)}")
            if problems:
                mismatched += 1
                raised += self._finding(inv.organization_id, ReviewItemKind.TAX_SNAPSHOT_MISMATCH, "Invoice", inv.id,
                                        f"Invoice {inv.invoice_number}: " + "; ".join(problems)
                                        + ". The invoice was not changed; investigate how it diverged.", "org_admin")
        return {"checked": checked, "found": mismatched, "review_items": raised}

    # ── 2. provider totals match ours ──
    def check_provider_drift(self, since: date) -> dict:
        from app.modules.tax.provider_models import TaxProviderOutbox
        from app.modules.tax.quote_models import TaxQuote

        start = datetime.combine(since, datetime.min.time(), tzinfo=timezone.utc)
        checked = found = raised = 0
        rows = self.db.query(TaxProviderOutbox).filter(TaxProviderOutbox.operation == OutboxOperation.COMMIT,
                                                       TaxProviderOutbox.state == OutboxState.DONE,
                                                       TaxProviderOutbox.created_at >= start)
        for row in rows:
            snapshot = row.remote_snapshot or {}
            quote = self.db.get(TaxQuote, row.tax_quote_id) if getattr(row, "tax_quote_id", None) else None
            if quote is None or snapshot.get("total_tax") is None:
                continue
            checked += 1
            if _d(snapshot["total_tax"]) != _d(quote.tax_amount):
                found += 1
                raised += self._finding(row.organization_id, ReviewItemKind.PROVIDER_DRIFT, "TaxProviderOutbox", row.id,
                                        f"The provider holds total tax {snapshot['total_tax']} for this invoice; we "
                                        f"charged {_d(quote.tax_amount)}. Nothing was changed.", "billing_admin")
        return {"checked": checked, "found": found, "review_items": raised}

    # ── 3. credit notes never exceed the original ──
    def check_credits(self, since: date) -> dict:
        from app.modules.tax.quote_models import CreditNoteTaxLine

        start = datetime.combine(since, datetime.min.time())
        invoice_ids = {cid for (cid,) in self.db.query(CreditNote.invoice_id).filter(
            CreditNote.invoice_id.isnot(None), CreditNote.created_at >= start).distinct()}
        checked = found = raised = 0
        for inv in self.db.query(Invoice).filter(Invoice.id.in_(invoice_ids or [-1])):
            checked += 1
            notes = self.db.query(CreditNote).filter(CreditNote.invoice_id == inv.id,
                                                     CreditNote.status != CreditNoteStatus.VOIDED).all()
            credited = sum((_d(n.total_amount) for n in notes), Decimal("0"))
            credited_tax = -sum((_d(r.credited_tax) for r in self.db.query(CreditNoteTaxLine).filter(
                CreditNoteTaxLine.invoice_id == inv.id, CreditNoteTaxLine.credit_note_id.in_([n.id for n in notes] or [-1]))),
                Decimal("0"))
            problems = []
            if credited > _d(inv.total_amount) + CENT:
                problems.append(f"credit notes total {credited} against an invoice total of {_d(inv.total_amount)}")
            if inv.tax_quote_id is not None and credited_tax > _d(inv.tax_amount):
                problems.append(f"credited tax {credited_tax} exceeds the tax charged {_d(inv.tax_amount)}")
            if problems:
                found += 1
                raised += self._finding(inv.organization_id, ReviewItemKind.CREDIT_EXCEEDS_ORIGINAL, "Invoice", inv.id,
                                        f"Invoice {inv.invoice_number}: " + "; ".join(problems) + ".", "finance_approver")
        return {"checked": checked, "found": found, "review_items": raised}

    # ── 4/5. per-market zero-tax share and rate mix (aggregate) ──
    def _market_rows(self, start: date, end: date) -> dict:
        """{market: [(tax_amount, frozenset(rates))]} for governed invoices issued in [start, end)."""
        from app.modules.tax.quote_models import TaxQuote, TaxQuoteComponent

        out = defaultdict(list)
        q = (self._issued_since(start).filter(Invoice.tax_quote_id.isnot(None), Invoice.issue_date < end)
             .join(TaxQuote, TaxQuote.id == Invoice.tax_quote_id).with_entities(TaxQuote.id, TaxQuote.tax_amount,
                                                                                TaxQuote.supply_address))
        rows = q.all()
        rates = defaultdict(set)
        for qid, rate in self.db.query(TaxQuoteComponent.tax_quote_id, TaxQuoteComponent.rate_percent).filter(
                TaxQuoteComponent.tax_quote_id.in_([r.id for r in rows] or [-1])):
            rates[qid].add(format(_d(rate).normalize(), "f"))
        for r in rows:
            addr = r.supply_address if isinstance(r.supply_address, dict) else {}
            market = (addr.get("country_code") or "UNKNOWN").upper()
            out[market].append((_d(r.tax_amount), frozenset(rates.get(r.id) or {"0"})))
        return out

    def check_markets(self, today: date) -> dict:
        t = self.t
        window_start = today - timedelta(days=t["window_days"])
        current = self._market_rows(window_start, today + timedelta(days=1))
        baseline = self._market_rows(window_start - timedelta(days=t["baseline_days"]), window_start)
        markets = {}
        for market, rows in sorted(current.items()):
            base = baseline.get(market, [])
            n, bn = len(rows), len(base)
            zero = sum(1 for tax, _ in rows if tax == 0) / n if n else 0.0
            bzero = sum(1 for tax, _ in base if tax == 0) / bn if bn else 0.0
            mix = Counter(r for _, rs in rows for r in rs)
            bmix = Counter(r for _, rs in base for r in rs)
            shift = max((abs(mix[k] / n - (bmix[k] / bn if bn else 0.0)) for k in set(mix) | set(bmix)), default=0.0) \
                if n else 0.0
            enough = n >= t["min_invoices"]
            markets[market] = {
                "invoices": n, "baseline_invoices": bn, "zero_tax_share": round(zero, 4),
                "baseline_zero_tax_share": round(bzero, 4), "rate_mix": dict(sorted(mix.items())),
                "baseline_rate_mix": dict(sorted(bmix.items())), "max_rate_mix_shift": round(shift, 4),
                "zero_tax_alert": enough and zero - bzero >= t["zero_tax_shift"],
                "rate_mix_alert": enough and bn >= t["min_invoices"] and shift >= t["rate_mix_shift"],
            }
        return markets

    # ── run ──
    def run(self) -> dict:
        from app.modules.tax.anomaly_models import TaxAnomalyRun
        from app.modules.tax.monitoring import publish
        from app.modules.super_admin.models import AttentionSeverity

        now = self.now()
        today = now.date()
        since = today - timedelta(days=self.t["lookback_days"])
        result = {"snapshot": self.check_snapshots(since), "provider_drift": self.check_provider_drift(since),
                  "credits": self.check_credits(since), "markets": self.check_markets(today)}
        alerts = []
        for key, title in (("snapshot", "Tax: governed invoices differ from their tax snapshot"),
                           ("provider_drift", "Tax: provider totals differ from ours"),
                           ("credits", "Tax: credit notes exceed the original invoice")):
            n = result[key]["found"]
            alerts.append({"key": f"tax.anomaly.{key}", "firing": n > 0, "title": title,
                           "description": f"{n} invoice(s) found in the last {self.t['lookback_days']} day(s); each "
                                          f"tenant has a review item. No invoice was changed.",
                           "severity": AttentionSeverity.P1 if key != "credits" else AttentionSeverity.P2})
        for market, m in result["markets"].items():
            alerts.append({"key": f"tax.anomaly.zero_tax:{market}", "firing": m["zero_tax_alert"],
                           "title": f"Tax: unusual zero-tax share in {market}",
                           "description": f"{m['zero_tax_share']:.0%} of {m['invoices']} governed invoices in {market} had "
                                          f"zero tax (baseline {m['baseline_zero_tax_share']:.0%}).",
                           "severity": AttentionSeverity.P2})
            alerts.append({"key": f"tax.anomaly.rate_mix:{market}", "firing": m["rate_mix_alert"],
                           "title": f"Tax: sudden rate mix change in {market}",
                           "description": f"Rates {m['rate_mix']} over {m['invoices']} invoices vs baseline "
                                          f"{m['baseline_rate_mix']} (shift {m['max_rate_mix_shift']:.0%}).",
                           "severity": AttentionSeverity.P3})
        published = publish(self.db, alerts)
        summary = {k: {kk: vv for kk, vv in v.items() if kk != "review_items"} for k, v in result.items() if k != "markets"}
        self.db.add(TaxAnomalyRun(started_at=now, finished_at=self.now(), counts=summary, markets=result["markets"],
                                  alerts_fired=published["fired"]))
        self.db.commit()
        return {**result, **published}


def run_tax_anomaly_job() -> dict:
    """Scheduler entry point (daily by default)."""
    from app.database import SessionLocal

    if not getattr(settings, "TAX_ANOMALY_ENABLED", True):
        return {"skipped": "TAX_ANOMALY_ENABLED is off"}
    db = SessionLocal()
    try:
        out = AnomalyService(db).run()
        return {"fired": out["fired"], "cleared": out["cleared"]}
    finally:
        db.close()
