"""tests/test_tax_phase8_retro_race_pg.py
--------------------------------------
ZB-TAX-ARCH-001 Phase 8 PR 4: two live retroactive-analysis workers against
PostgreSQL analyse each document exactly once.

Two organizations each have committed quotes made with a quarantined
(rolled-back) pack version. Two workers run the job together, in small
batches, each on its own connection: FOR UPDATE SKIP LOCKED on the
per-organization run must give each tenant to one worker at a time, the
results' unique key keeps each document once, and the analysis finishes
exactly once.

COMMITS, so it runs only with TAX_PG_TEST_URL plus TAX_PG_RACE_COMMITS=1,
last and alone in the CI tax step.
"""
import os
import threading
import traceback
from datetime import date, datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

PG_URL = os.environ.get("TAX_PG_TEST_URL", "").strip()
COMMITS_ALLOWED = os.environ.get("TAX_PG_RACE_COMMITS") == "1"

pytestmark = pytest.mark.skipif(
    not (PG_URL and COMMITS_ALLOWED),
    reason="needs TAX_PG_TEST_URL and TAX_PG_RACE_COMMITS=1 (commits to a throwaway PostgreSQL database)",
)

if os.environ.get("TAX_PG_TESTS_REQUIRED") and not PG_URL:
    raise RuntimeError("TAX_PG_TESTS_REQUIRED is set but TAX_PG_TEST_URL is empty")
if PG_URL and not PG_URL.startswith(("postgresql://", "postgresql+")):
    raise RuntimeError(f"TAX_PG_TEST_URL must be a PostgreSQL URL, got {PG_URL.split(':', 1)[0]!r}")

from app.modules.tax import retro_service as rs  # noqa: E402
from app.modules.tax.enums import EngineKind, PlatformVersionStatus, TaxQuoteStatus  # noqa: E402
from app.modules.tax.policy_models import TaxRollbackRequest, TaxRulePackVersion  # noqa: E402
from app.modules.tax.quote_models import TaxQuote  # noqa: E402
from app.modules.tax.retro_models import TaxRetroAnalysis, TaxRetroOrgRun, TaxRetroResult  # noqa: E402
from tests.conftest import make_organization  # noqa: E402

UTC = timezone.utc
PER_ORG = 7


@pytest.fixture(scope="module")
def engine():
    eng = create_engine(PG_URL, pool_size=4)
    assert eng.dialect.name == "postgresql"
    yield eng
    eng.dispose()


def test_two_workers_analyse_each_document_once(engine):
    tag = f"{os.getpid() % 100000}"
    now = datetime.now(UTC)
    setup = Session(bind=engine)
    v = TaxRulePackVersion(code=f"ZZ-RETRO-{tag}", version="2", markets=[], rounding_rule="PER_LINE",
                           rounding_mode="HALF_UP", status=PlatformVersionStatus.ROLLED_BACK, created_at=now,
                           valid_from=date(2031, 1, 1), valid_to=date(2031, 3, 1), superseded_at=now)
    setup.add(v)
    setup.flush()
    orgs = [make_organization(setup, code=f"R{tag}{i}", name=f"Retro race {i}") for i in range(2)]
    quote_ids = []
    for org in orgs:
        for n in range(PER_ORG):
            q = TaxQuote(organization_id=org.id, document_type="invoice", document_id=10_000 + n,
                         status=TaxQuoteStatus.COMMITTED, engine_kind=EngineKind.NATIVE_RULE_PACK,
                         engine_name=v.code, engine_version="2", currency="GBP", tax_date=date(2031, 2, 1),
                         context_fingerprint="f" * 64, document_hash="d" * 64, request_hash=f"{tag}{org.id}{n}",
                         rule_pack_version_id=v.id, tax_amount=0, created_at=now)
            setup.add(q)
            setup.flush()
            quote_ids.append(q.id)
    request = TaxRollbackRequest(kind="rule_pack", version_id=v.id, restore_to_id=None, reason="race",
                                 severity="SEV2", cancel_schedule=False, status="APPROVED", created_at=now,
                                 result={"rolled_back_version_id": v.id, "range_from": "2031-01-01",
                                         "range_to": "2031-03-01", "quarantine_only": True})
    setup.add(request)
    setup.flush()
    analysis = rs.enqueue(setup, rs.rollback_trigger(setup, request))
    setup.commit()
    ids = {"analysis": analysis.id}
    setup.close()

    barrier, errors = threading.Barrier(2), []

    def worker():
        db = Session(bind=engine)
        try:
            barrier.wait()
            for _ in range(4):
                rs.run_retro_analyses(db, batch=2)
        except Exception:                                   # surfaced below, never swallowed
            errors.append(traceback.format_exc())
        finally:
            db.close()

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert not errors, errors[0]

    check = Session(bind=engine)
    try:
        results = check.query(TaxRetroResult).filter(TaxRetroResult.analysis_id == ids["analysis"]).all()
        assert sorted(r.quote_id for r in results) == sorted(quote_ids)          # each document exactly once
        assert all(r.status == "MANUAL_REVIEW_REQUIRED" for r in results)
        owner = {q.id: q.organization_id for q in check.query(TaxQuote).filter(TaxQuote.id.in_(quote_ids))}
        assert all(r.organization_id == owner[r.quote_id] for r in results)       # never mixes tenants
        runs = check.query(TaxRetroOrgRun).filter(TaxRetroOrgRun.analysis_id == ids["analysis"]).all()
        assert len(runs) == 2 and all(r.status == "DONE" and r.documents == PER_ORG for r in runs)
        done = check.get(TaxRetroAnalysis, ids["analysis"])
        assert done.status == "DONE" and done.aggregates["documents"] == 2 * PER_ORG
        assert done.aggregates["by_status"] == {"MANUAL_REVIEW_REQUIRED": 2 * PER_ORG}
    finally:
        check.close()
