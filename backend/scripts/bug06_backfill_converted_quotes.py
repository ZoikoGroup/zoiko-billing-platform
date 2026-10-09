"""
scripts/bug06_backfill_converted_quotes.py
------------------------------------------
Batch 7 BUG-06 one-off backfill. Until Batch 7,
ContractService.convert_quotation_to_contract created the contract but left
the quotation ACCEPTED, so converted quotes kept counting toward the open
pipeline. The service now marks them CONVERTED atomically; this fixes rows
written before that change.

Deliberately NOT an Alembic migration: deploy.yml runs `alembic upgrade head`
on every deploy, which would apply a data change before anyone reviewed it.
This script never runs on its own.

Candidates: quotations whose status is ACCEPTED (any casing -- stored as enum
names, older rows may be lowercase) that are linked from at least one
non-deleted contract in the SAME organization (contracts.quotation_id).
Only quotations.status (-> CONVERTED) and updated_at change; amounts,
currency and items are never touched.

Usage (from backend/, database from BILLING_DATABASE_URL as for the app):

    # 1. Dry run -- read-only transaction, writes the review file:
    python -m scripts.bug06_backfill_converted_quotes --out bug06_candidates.csv

    # 2. After the ids in that file are reviewed and approved:
    python -m scripts.bug06_backfill_converted_quotes --execute \\
        --approved bug06_candidates.csv --out bug06_executed.csv

--execute updates ONLY the rows in the approved file, in one transaction,
and aborts without writing anything if any of them changed since review
(status, updated_at, organization or contract link). Candidates that
appeared after the review are listed but never touched. Re-running is a
no-op (nothing is ACCEPTED any more) and therefore aborts as "changed".

Rollback: the approved file is the reversal record. Restore each row with
    UPDATE quotations SET status = '<status>', updated_at = '<updated_at>'
    WHERE id = <id> AND organization_id = <organization_id>;
Do not revert quotes the application converted after the backfill.
"""
import argparse
import csv
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import sqlalchemy as sa  # noqa: E402

from app.modules.billing.models import Contract, Quotation, QuoteStatus  # noqa: E402

FIELDS = ["id", "organization_id", "status", "updated_at"]

_q = Quotation.__table__
_c = Contract.__table__


def _candidate_filter():
    linked = (
        sa.select(sa.literal(1))
        .where(
            _c.c.quotation_id == _q.c.id,
            _c.c.organization_id == _q.c.organization_id,
            _c.c.deleted_at.is_(None),
        )
        .exists()
    )
    return sa.and_(sa.func.upper(sa.cast(_q.c.status, sa.String)) == "ACCEPTED", linked)


def _row(r) -> Dict:
    return {"id": r.id, "organization_id": r.organization_id, "status": r.status, "updated_at": r.updated_at}


def find_candidates(conn) -> List[Dict]:
    """Every current candidate, ordered by id (read only)."""
    stmt = (
        sa.select(_q.c.id, _q.c.organization_id,
                  sa.cast(_q.c.status, sa.String).label("status"), _q.c.updated_at)
        .where(_candidate_filter())
        .order_by(_q.c.id)
    )
    return [_row(r) for r in conn.execute(stmt)]


def write_csv(path, rows: List[Dict]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS + (["outcome"] if rows and "outcome" in rows[0] else []))
        w.writeheader()
        for r in rows:
            w.writerow({**r, "updated_at": r["updated_at"].isoformat() if r["updated_at"] else ""})


def start_read_only(conn) -> None:
    """Make the connection's current transaction read-only (PostgreSQL:
    SET TRANSACTION READ ONLY must be the transaction's first statement;
    the server then rejects any write in it). SQLite has no such mode --
    there the dry run simply never issues a write and rolls back."""
    if conn.dialect.name == "postgresql":
        conn.exec_driver_sql("SET TRANSACTION READ ONLY")


class InvalidReviewFile(Exception):
    """The approved CSV is missing, malformed or ambiguous; nothing written."""


class ReviewMismatch(Exception):
    """An approved row no longer matches what was reviewed; nothing written."""


def read_csv(path) -> List[Dict]:
    """Parse the reviewed dry-run CSV strictly: required columns, integer
    ids, ISO timestamps, no duplicate ids. Any problem -> InvalidReviewFile."""
    try:
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            missing = [c for c in FIELDS if c not in (reader.fieldnames or [])]
            if missing:
                raise InvalidReviewFile(f"missing column(s): {missing}")
            rows, seen = [], set()
            for n, r in enumerate(reader, start=2):          # line 1 is the header
                try:
                    row = {"id": int(r["id"]), "organization_id": int(r["organization_id"]),
                           "status": r["status"],
                           "updated_at": datetime.fromisoformat(r["updated_at"]) if r["updated_at"] else None}
                except (TypeError, ValueError) as e:
                    raise InvalidReviewFile(f"line {n}: {e}") from None
                if not row["status"]:
                    raise InvalidReviewFile(f"line {n}: empty status")
                if row["id"] in seen:
                    raise InvalidReviewFile(f"line {n}: duplicate quotation id {row['id']}")
                seen.add(row["id"])
                rows.append(row)
            return rows
    except OSError as e:
        raise InvalidReviewFile(f"cannot read approved file: {e.strerror}") from None


def _same_instant(a, b) -> bool:
    if a is None or b is None:
        return a is b
    if (a.tzinfo is None) != (b.tzinfo is None):        # SQLite drops tzinfo
        a, b = a.replace(tzinfo=None), b.replace(tzinfo=None)
    return a == b


def execute_approved(conn, approved: List[Dict]) -> Dict:
    """Mark exactly the approved rows CONVERTED. Caller owns the transaction
    (commit only on success). Raises ReviewMismatch -- before any write --
    if any approved row changed since the dry run."""
    lock = sa.select(_q.c.id).where(_q.c.id.in_([a["id"] for a in approved]))
    if conn.dialect.name == "postgresql":
        lock = lock.with_for_update()
    conn.execute(lock).all()                           # hold the reviewed rows
    current = {r["id"]: r for r in find_candidates(conn)}

    changed = [
        a["id"] for a in approved
        if a["id"] not in current
        or current[a["id"]]["organization_id"] != a["organization_id"]
        or current[a["id"]]["status"] != a["status"]
        or not _same_instant(current[a["id"]]["updated_at"], a["updated_at"])
    ]
    if changed:
        raise ReviewMismatch(f"{len(changed)} approved row(s) changed since review: {changed}")

    for a in approved:
        res = conn.execute(
            sa.update(_q)
            .where(_q.c.id == a["id"], _q.c.organization_id == a["organization_id"], _candidate_filter())
            .values(status=QuoteStatus.CONVERTED, updated_at=sa.func.now())
        )
        if res.rowcount != 1:
            raise ReviewMismatch(f"quotation {a['id']} did not update exactly one row")
    approved_ids = {a["id"] for a in approved}
    return {
        "updated": [a["id"] for a in approved],
        "unreviewed_new_candidates": sorted(i for i in current if i not in approved_ids),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True, help="CSV to write (dry run: candidates; execute: outcome)")
    parser.add_argument("--execute", action="store_true", help="write changes (requires --approved)")
    parser.add_argument("--approved", help="the reviewed dry-run CSV; only these rows are updated")
    args = parser.parse_args()
    if args.execute and not args.approved:
        parser.error("--execute requires --approved <reviewed dry-run CSV>")

    approved = None
    if args.execute:
        try:
            approved = read_csv(args.approved)          # validated before any connection
        except InvalidReviewFile as e:
            print(f"ABORTED, nothing written: invalid approved file: {e}")
            return 2
        if not approved:
            print("Approved file is empty: nothing to do.")
            return 0

    from app.database import resolve_database_url
    engine = sa.create_engine(resolve_database_url())
    try:
        with engine.connect() as conn:
            if not args.execute:
                start_read_only(conn)
                rows = find_candidates(conn)
                conn.rollback()
                write_csv(args.out, rows)
                print(f"DRY RUN (read-only, nothing written): {len(rows)} candidate(s) -> {args.out}")
                print("ids:", [r["id"] for r in rows])
                return 0

            try:
                result = execute_approved(conn, approved)
            except ReviewMismatch as e:
                conn.rollback()
                print(f"ABORTED, nothing written: {e}. Re-run the dry run and review again.")
                return 2
            except Exception as e:
                # Any database / unexpected error: the whole run is rolled
                # back explicitly. Only the error type is printed (no SQL
                # parameters or connection details).
                conn.rollback()
                print(f"ABORTED, nothing written: {type(e).__name__} during execute; transaction rolled back.")
                return 3
            conn.commit()
            write_csv(args.out, [{**a, "outcome": "converted"} for a in approved])
            print(f"EXECUTED: {len(result['updated'])} quotation(s) set to CONVERTED -> {args.out}")
            if result["unreviewed_new_candidates"]:
                print("Not touched (appeared after review):", result["unreviewed_new_candidates"])
            return 0
    finally:
        engine.dispose()


if __name__ == "__main__":
    sys.exit(main())
