"""
scripts/explain_hot_queries.py   (READ-ONLY)
--------------------------------------------
EXPLAIN (ANALYZE, BUFFERS) representative versions of the hot list queries that
motivate the additive indexes in alembic revision b7e2d9c4a1f8, and print a
plan summary per query plus table sizes, existing indexes and
pg_stat_user_tables seq_scan vs idx_scan evidence.

Safety: only SELECT / EXPLAIN of SELECT / catalog reads are issued, inside a
READ ONLY transaction that is always rolled back. The DB URL is never printed.

Usage (from backend/):
    python -m scripts.explain_hot_queries [--org-id N]

NOTE: at tiny row counts Postgres correctly prefers Seq Scan even when an
index would help at scale. Treat "Seq Scan" at small N as "not slow yet", not
as proof the index is useless; judge by row counts + seq_scan/idx_scan stats.
"""
import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import create_engine, text

from app.database import resolve_database_url

TABLES = [
    "invoices", "payments", "billing_audit_logs", "platform_audit_logs",
    "attention_items", "job_run_logs", "billing_customers",
]


def build_queries(org_id, inv_status, job_name):
    # (label, sql, params)
    return [
        ("invoices list: org + not deleted ORDER BY created_at DESC",
         "SELECT * FROM invoices WHERE organization_id = :org AND deleted_at IS NULL "
         "ORDER BY created_at DESC LIMIT 50 OFFSET 0", {"org": org_id}),
        ("invoices by org + status",
         "SELECT * FROM invoices WHERE organization_id = :org AND status = :st "
         "ORDER BY created_at DESC LIMIT 50", {"org": org_id, "st": inv_status}),
        ("payments by org ORDER BY created_at DESC",
         "SELECT * FROM payments WHERE organization_id = :org AND deleted_at IS NULL "
         "ORDER BY created_at DESC LIMIT 50", {"org": org_id}),
        ("billing_audit_logs ORDER BY timestamp DESC LIMIT",
         "SELECT * FROM billing_audit_logs ORDER BY timestamp DESC LIMIT 50", {}),
        ("platform_audit_logs ORDER BY created_at DESC LIMIT",
         "SELECT * FROM platform_audit_logs ORDER BY created_at DESC LIMIT 50", {}),
        ("attention_items open statuses GROUP BY severity",
         "SELECT severity, count(*) FROM attention_items "
         "WHERE status IN ('OPEN','ACKNOWLEDGED','ASSIGNED','MITIGATING','MONITORING','REOPENED') "
         "GROUP BY severity", {}),
        ("job_run_logs by job_name ORDER BY started_at DESC",
         "SELECT * FROM job_run_logs WHERE job_name = :j ORDER BY started_at DESC LIMIT 20",
         {"j": job_name}),
        ("billing_customers by org + not deleted",
         "SELECT * FROM billing_customers WHERE organization_id = :org AND deleted_at IS NULL "
         "ORDER BY id LIMIT 50", {"org": org_id}),
    ]


def summarize(plan_lines):
    plan = "\n".join(plan_lines)
    nodes = re.findall(r"^\s*(?:->\s*)?([A-Z][A-Za-z ]+?)(?: using (\S+))?(?: on (\S+))?\s+\(cost", plan, re.M)
    kinds = [n[0].strip() for n in nodes]
    ex = re.search(r"Execution Time: ([\d.]+) ms", plan)
    sort_disk = "external merge" in plan
    return {
        "seq_scan": any(k.startswith("Seq Scan") for k in kinds),
        "sort": any(k.startswith("Sort") for k in kinds),
        "sort_disk": sort_disk,
        "indexes": sorted({n[1] for n in nodes if n[1]}),
        "ms": float(ex.group(1)) if ex else None,
        "nodes": kinds,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--org-id", type=int)
    ap.add_argument("--verbose", action="store_true", help="print full plans")
    args = ap.parse_args()

    url = resolve_database_url()
    if not url.startswith("postgresql"):
        print("Postgres only (EXPLAIN BUFFERS); configured DB is not Postgres.")
        return
    eng = create_engine(url)
    with eng.connect() as conn:
        conn.execute(text("SET TRANSACTION READ ONLY"))
        conn.execute(text("SET LOCAL statement_timeout = '30s'"))

        print("== Table sizes (pg_class.reltuples estimate / exact count) ==")
        existing = [t for t in TABLES if conn.execute(
            text("SELECT to_regclass(:t)"), {"t": f"public.{t}"}).scalar()]
        for t in TABLES:
            if t not in existing:
                print(f"  {t:<22} MISSING"); continue
            est = conn.execute(text("SELECT reltuples::bigint FROM pg_class WHERE oid = to_regclass(:t)"),
                               {"t": f"public.{t}"}).scalar()
            exact = conn.execute(text(f'SELECT count(*) FROM "{t}"')).scalar()
            print(f"  {t:<22} reltuples={est:<8} count={exact}")

        print("\n== Existing indexes ==")
        for r in conn.execute(text(
            "SELECT tablename, indexname, indexdef FROM pg_indexes "
            "WHERE schemaname='public' AND tablename = ANY(:t) ORDER BY tablename, indexname"),
            {"t": existing}):
            print(f"  {r[0]:<20} {r[1]:<46} {r[2].split(' USING ')[-1]}")

        print("\n== pg_stat_user_tables (since last stats reset) ==")
        print(f"  {'table':<22}{'seq_scan':>10}{'idx_scan':>10}{'seq_tup_read':>14}{'n_live_tup':>12}")
        for r in conn.execute(text(
            "SELECT relname, seq_scan, idx_scan, seq_tup_read, n_live_tup FROM pg_stat_user_tables "
            "WHERE relname = ANY(:t) ORDER BY relname"), {"t": existing}):
            print(f"  {r[0]:<22}{r[1] or 0:>10}{r[2] or 0:>10}{r[3] or 0:>14}{r[4] or 0:>12}")

        org_id = args.org_id
        if org_id is None:
            org_id = conn.execute(text(
                "SELECT organization_id FROM invoices GROUP BY organization_id "
                "ORDER BY count(*) DESC LIMIT 1")).scalar()
        inv_status = conn.execute(text(
            "SELECT status::text FROM invoices WHERE organization_id=:o "
            "GROUP BY status ORDER BY count(*) DESC LIMIT 1"), {"o": org_id}).scalar()
        job_name = conn.execute(text(
            "SELECT job_name FROM job_run_logs GROUP BY job_name ORDER BY count(*) DESC LIMIT 1")).scalar()
        print(f"\n(sample organization_id={org_id}, invoice status={inv_status}, job_name={job_name})")

        print("\n== EXPLAIN (ANALYZE, BUFFERS) summaries ==")
        for label, sql, params in build_queries(org_id, inv_status, job_name):
            tbl = re.search(r"FROM (\w+)", sql).group(1)
            if tbl not in existing:
                print(f"- {label}: table missing"); continue
            try:
                rows = conn.execute(text("EXPLAIN (ANALYZE, BUFFERS) " + sql), params).fetchall()
            except Exception as exc:  # noqa: BLE001
                conn.rollback(); conn.execute(text("SET TRANSACTION READ ONLY"))
                print(f"- {label}: ERROR {type(exc).__name__}: {str(exc).splitlines()[0][:120]}")
                continue
            lines = [r[0] for r in rows]
            s = summarize(lines)
            flags = []
            if s["seq_scan"]: flags.append("SEQ SCAN")
            if s["sort"]: flags.append("SORT" + (" (disk)" if s["sort_disk"] else ""))
            print(f"- {label}\n    exec={s['ms']} ms  flags={flags or ['none']}  "
                  f"indexes_used={s['indexes'] or '-'}  nodes={s['nodes']}")
            if args.verbose:
                print("\n".join("      " + l for l in lines))
        conn.rollback()


if __name__ == "__main__":
    main()
