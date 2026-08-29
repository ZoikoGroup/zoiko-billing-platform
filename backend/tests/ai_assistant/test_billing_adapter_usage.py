"""Architecture §11.1 / C-09 guard: the chatbot must never read the billing
ledger (Invoice / Payment / CreditNote) with ad hoc ORM queries from its
handlers.

Direct SQL access to Billing production ledgers is prohibited (Architecture
§2.1 forbidden shortcuts, §11.1 data-access pattern). Every ledger read in the
conversation handlers is routed through the single Billing API Adapter so org
scoping, exact-Decimal money handling and per-currency grouping stay in one
place instead of drifting (the §30 multi-currency bug class). This test is an
AST scan over the source so it fails at review time if a handler re-introduces
self.db.query(...) against the ledger.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

_ENGINE = Path(__file__).resolve().parents[2] / "app/modules/chatbot/conversation/engine.py"
_ADAPTER = Path(__file__).resolve().parents[2] / "app/modules/chatbot/billing_adapter.py"

# Handlers migrated onto the adapter in the §30 / C-09 pass.
_HANDLERS = [
    "_refund_total_response",
    "_credit_note_count_response",
    "_paid_period_response",
    "_customer_balance_response",
    "_list_invoices",
    "_list_payments",
    "_lookup_overdue",
    "_handle_reconciliation",
    "_lookup_invoice",
    "_lookup_payment",
    "_count_payments",
    "_lookup_account_balance",
    "_handle_dashboard",
    "_metric_definition_response",
]

_ADAPTER_METHODS = [
    "refund_totals",
    "credit_note_totals",
    "paid_revenue_totals",
    "open_invoices_for_customer",
    "list_invoices",
    "list_payments",
    "list_overdue",
    "reconciliation_payments",
    "lookup_invoice",
    "lookup_payment",
    "count_invoices_for_org",
    "count_payments_for_org",
]


def _conversation_engine_class(tree: ast.AST):
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == "ConversationEngine":
            return node
    raise AssertionError("ConversationEngine not found")


@pytest.fixture(scope="module")
def engine_tree() -> ast.Module:
    assert _ENGINE.exists(), f"engine.py missing: {_ENGINE}"
    return ast.parse(_ENGINE.read_text(encoding="utf-8"), filename=str(_ENGINE))


@pytest.mark.parametrize("handler", _HANDLERS)
def test_handler_reads_ledger_only_through_adapter(engine_tree: ast.Module, handler: str) -> None:
    cls = _conversation_engine_class(engine_tree)
    method = next((n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == handler), None)
    assert method is not None, f"handler {handler} not found"

    for node in ast.walk(method):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "query"
        ):
            pytest.fail(
                f"{handler} still calls self.db.query(...) at line {node.lineno} — "
                "ledger reads must go through the BillingAdapter (Architecture §11.1)."
            )


def test_engine_constructs_billing_adapter(engine_tree: ast.Module) -> None:
    init = next(
        n
        for n in _conversation_engine_class(engine_tree).body
        if isinstance(n, ast.FunctionDef) and n.name == "__init__"
    )
    constructed = any(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "BillingAdapter"
        for node in ast.walk(init)
    )
    assert constructed, "ConversationEngine.__init__ must construct the BillingAdapter"


@pytest.mark.parametrize("adapter_method", _ADAPTER_METHODS)
def test_adapter_exposes_ledger_read_gateway(adapter_method: str) -> None:
    assert _ADAPTER.exists(), f"billing_adapter.py missing: {_ADAPTER}"
    tree = ast.parse(_ADAPTER.read_text(encoding="utf-8"), filename=str(_ADAPTER))
    cls = next((n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == "BillingAdapter"), None)
    assert cls is not None, "BillingAdapter class missing"
    names = {n.name for n in cls.body if isinstance(n, ast.FunctionDef)}
    assert adapter_method in names, f"BillingAdapter.{adapter_method} missing"