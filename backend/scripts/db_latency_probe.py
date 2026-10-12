"""
scripts/db_latency_probe.py
---------------------------
Measure round-trip latency between THIS machine and the configured database
(BILLING_DATABASE_URL) using trivial `SELECT 1` statements. Read-only.

IMPORTANT: run it FROM THE API HOST (same container/VM/region the FastAPI app
runs on). Run from a dev laptop it measures dev -> DB latency, which says
nothing about the production API -> DB path.

Usage (from backend/):
    python -m scripts.db_latency_probe [--samples 50]

Reports p50/p95/min/max (ms) for:
  * fresh connection  : TCP + TLS + auth + SELECT 1 (cost of a pool miss)
  * pooled connection : SELECT 1 on an already-open connection (per-query RTT)

The database URL is never printed.
"""
import argparse
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.database import resolve_database_url


def _pct(values, pct):
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round(pct / 100.0 * (len(s) - 1)))))
    return s[k]


def _summary(label, values):
    print(
        f"{label:<18} n={len(values):<3} p50={_pct(values, 50):8.2f} ms  "
        f"p95={_pct(values, 95):8.2f} ms  min={min(values):8.2f}  "
        f"max={max(values):8.2f}  mean={statistics.mean(values):8.2f}"
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--samples", type=int, default=50)
    args = ap.parse_args()

    url = resolve_database_url()
    if url.startswith("sqlite"):
        print("Configured DB is SQLite (local file); latency is not meaningful.")
        return

    # Fresh connection each time (NullPool): full connect + SELECT 1.
    fresh_engine = create_engine(url, poolclass=NullPool)
    fresh = []
    for _ in range(args.samples):
        t0 = time.perf_counter()
        with fresh_engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        fresh.append((time.perf_counter() - t0) * 1000)
    fresh_engine.dispose()

    # Pooled connection: open once, time only the statement.
    pooled_engine = create_engine(url, pool_size=1, max_overflow=0)
    pooled = []
    with pooled_engine.connect() as conn:
        conn.execute(text("SELECT 1"))  # warm-up, not measured
        for _ in range(args.samples):
            t0 = time.perf_counter()
            conn.execute(text("SELECT 1"))
            pooled.append((time.perf_counter() - t0) * 1000)
    pooled_engine.dispose()

    print("DB round-trip latency (run from the API host for meaningful numbers)")
    _summary("fresh connection", fresh)
    _summary("pooled SELECT 1", pooled)

    rtt = _pct(pooled, 50)
    print("\nGuidance:")
    if rtt < 2:
        print("  <2 ms p50: DB is co-located with this host (same region/AZ). Good.")
    elif rtt < 10:
        print("  2-10 ms p50: same region, different AZ/network hop. Acceptable; "
              "N+1 query patterns will still add up.")
    elif rtt < 40:
        print("  10-40 ms p50: likely cross-region or cross-provider. A page that "
              "issues 20 queries pays 0.2-0.8 s purely in network. Move the API "
              "and DB into the same region.")
    else:
        print(">=40 ms p50: far apart (or running from a dev machine). Every query "
              "pays this. If measured on the API host, co-locate API and DB; "
              "if measured from a laptop, re-run on the API host.")
    print(f"  Fresh-connect p50 {_pct(fresh, 50):.0f} ms: this is what each pool "
          "miss costs; keep pool_pre_ping/pool_recycle sane and avoid NullPool.")


if __name__ == "__main__":
    main()
