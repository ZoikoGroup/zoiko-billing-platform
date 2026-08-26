"""
migrations/add_plane1_billing_tables.py
----------------------------------------
Idempotent, additive-only migration that creates the Plane 1 transactional
billing tables on EXISTING databases (PostgreSQL or the dev SQLite fallback).

Fresh databases receive the tables automatically from Base.metadata.create_all.
This script exists only because create_all does NOT alter existing databases.

Tables created (topologically sorted):
  platform_invoice_number_sequences, platform_invoices,
  platform_payments, platform_credit_notes, platform_refunds,
  platform_payment_allocations, commercial_quotes,
  commercial_quote_items, platform_invoice_items

Safe to run any number of times:
  - only creates tables when they are missing
  - never drops anything, never deletes data, never alters existing tables

Usage:
    python -m migrations.add_plane1_billing_tables            # apply
    python -m migrations.add_plane1_billing_tables --check    # report only
"""

import argparse
import sys
from pathlib import Path
from graphlib import TopologicalSorter

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import inspect  # type: ignore[import]

from app.database import Base, engine
from app.modules.commercial.models import (  # noqa: F401  (registers tables)
    CommercialAccount,
    CommercialPlan,
    CommercialQuote,
    CommercialQuoteItem,
    CommercialSubscription,
    PlatformCreditNote,
    PlatformInvoice,
    PlatformInvoiceItem,
    PlatformInvoiceNumberSequence,
    PlatformPayment,
    PlatformPaymentAllocation,
    PlatformRefund,
)

TABLE_NAMES = [
    "commercial_quotes",
    "commercial_quote_items",
    "platform_invoices",
    "platform_invoice_items",
    "platform_invoice_number_sequences",
    "platform_payments",
    "platform_payment_allocations",
    "platform_credit_notes",
    "platform_refunds",
]


def _topo_sorted_names() -> list[str]:
    """Return TABLE_NAMES sorted by FK dependency order."""
    sorter = TopologicalSorter()
    for name in TABLE_NAMES:
        table = Base.metadata.tables[name]
        deps = set()
        for fk in table.foreign_key_constraints:
            target = fk.referred_table.name
            if target in TABLE_NAMES and target != name:
                deps.add(target)
        sorter.add(name, *deps)
    return list(sorter.static_order())


def _missing_tables() -> list[str]:
    return [t for t in TABLE_NAMES if not inspect(engine).has_table(t)]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Add Plane 1 billing tables (idempotent, additive).",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Only report which tables are missing; do not change the database.",
    )
    args = parser.parse_args()

    missing = _missing_tables()

    if args.check:
        if missing:
            print(f"Missing tables: {', '.join(missing)}.")
        else:
            print(f"All tables present: {', '.join(TABLE_NAMES)}.")
        return

    sorted_names = _topo_sorted_names()

    for name in sorted_names:
        if name in missing:
            Base.metadata.tables[name].create(bind=engine, checkfirst=True)
            print(f"Created table {name}.")
        else:
            print(f"Table {name} already exists.")


if __name__ == "__main__":
    main()
