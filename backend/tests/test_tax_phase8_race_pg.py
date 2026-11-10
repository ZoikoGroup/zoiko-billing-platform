"""tests/test_tax_phase8_race_pg.py
--------------------------------
ZB-TAX-ARCH-001 Phase 8 PR 3: a rollback approval and the activation job
racing on the same pack end in exactly one consistent outcome.

V is the open-ended version, S is scheduled to follow it, and a proposed
rollback of V acknowledges cancelling S. The approval locks S then V (FOR
UPDATE); the job locks S with SKIP LOCKED. Run together, either:
  * the rollback wins: V ROLLED_BACK, S back to APPROVED, R ACTIVE, the job
    activated nothing; or
  * the job wins: S ACTIVE, V closed by S, and the approval is refused
    (V is now followed by S), leaving the request PROPOSED.
Never both.

Like the Phase 4d-0 race test this one COMMITS, so it runs only with
TAX_PG_TEST_URL plus TAX_PG_RACE_COMMITS=1, last and alone in the CI tax step.
"""
import os
import threading
import time
from datetime import date, datetime, timedelta, timezone

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

from app.modules.auth.models import PlatformRole, UserRole  # noqa: E402
from app.modules.tax import policy_service  # noqa: E402
from app.modules.tax import rule_pack_integrity as rpi  # noqa: E402
from app.modules.tax.activation import activate_due  # noqa: E402
from app.modules.tax.engines import RULE_PACK_VERSIONS, RULE_PACKS  # noqa: E402
from app.modules.tax.enums import PlatformVersionStatus as S  # noqa: E402
from app.modules.tax.policy_models import TaxRollbackRequest, TaxRulePackVersion  # noqa: E402
from app.modules.tax.registry_service import RegistryStateError  # noqa: E402
from app.modules.tax import rollback_service as rb  # noqa: E402
from app.modules.tax.rollback_service import RollbackService  # noqa: E402
from app.modules.tax.rule_packs import UkVatDomesticServices  # noqa: E402
from tests.test_tax_phase3b_packs import GOLDEN, _user  # noqa: E402

UTC = timezone.utc


@pytest.fixture(scope="module")
def engine():
    eng = create_engine(PG_URL, pool_size=4)
    assert eng.dialect.name == "postgresql"
    yield eng
    eng.dispose()


def _row(cls, status, valid_from, **kw):
    d = cls.declaration()
    now = datetime.now(UTC)
    return TaxRulePackVersion(
        code=cls.code, version=cls.version, markets=d["markets"], rounding_rule=d["rounding_rule"],
        rounding_mode=d["rounding_mode"], required_facts=d["required_facts"], coverage=d["coverage"],
        source_dependencies=[], golden_test_report=GOLDEN, code_hash=rpi.compute_hash(cls), valid_from=valid_from,
        status=status, created_at=now, published_at=now if status != S.SCHEDULED else None, **kw)


def test_rollback_approval_and_activation_job_never_both_win(engine, monkeypatch):
    code = f"ZZ-RACE-{os.getpid() % 100000}"
    classes = {v: type(f"Race{v}", (UkVatDomesticServices,), {"code": code, "version": v}) for v in ("1", "2", "3")}
    for v, cls in classes.items():
        monkeypatch.setitem(RULE_PACK_VERSIONS, (code, v), cls)
    monkeypatch.setitem(RULE_PACKS, code, classes["3"])
    real = policy_service.source_dependency_status
    monkeypatch.setattr(policy_service, "source_dependency_status",
                        lambda db, ref: {**real(db, ref), "approved": True, "reason": None})
    rpi.clear_cache()

    setup = Session(bind=engine)
    tag = f"{os.getpid() % 100000}"
    a = _user(setup, f"race-a-{tag}@p8.example", UserRole.SUPER_ADMIN, platform_role=PlatformRole.TAX_PUBLISHER)
    b = _user(setup, f"race-b-{tag}@p8.example", UserRole.SUPER_ADMIN, platform_role=PlatformRole.TAX_PUBLISHER)
    p = _row(classes["1"], S.ACTIVE, None, valid_to=date(2031, 1, 1))
    v = _row(classes["2"], S.ACTIVE, date(2031, 1, 1))
    s = _row(classes["3"], S.SCHEDULED, date(2032, 1, 1), activate_at=datetime.now(UTC) - timedelta(minutes=1),
             activate_at_local="2026-01-01T00:00", activate_tz="Europe/London", scheduled_by_user_id=a.id)
    setup.add_all([p, v, s])
    setup.flush()
    request = RollbackService(setup).propose(actor_id=a.id, kind="rule_pack", version_id=v.id, restore_to_id=p.id,
                                             reason="race", severity="SEV1", cancel_schedule=True,
                                             timezone="Europe/London")
    setup.commit()
    ids = {"p": p.id, "v": v.id, "s": s.id, "request": request.id}
    setup.close()

    slow_apply = RollbackService._apply_pack

    def held_apply(self, *args, **kw):
        time.sleep(0.3)                                       # hold the locks so the job runs meanwhile
        return slow_apply(self, *args, **kw)

    monkeypatch.setattr(RollbackService, "_apply_pack", held_apply)
    barrier, outcome = threading.Barrier(2), {}

    def approve():
        db = Session(bind=engine)
        try:
            barrier.wait()
            RollbackService(db).decide(actor_id=b.id, request_id=ids["request"], approve=True)
            db.commit()
            outcome["rollback"] = "applied"
        except RegistryStateError as exc:
            db.rollback()
            outcome["rollback"] = f"refused: {exc.message}"
        finally:
            db.close()

    def job():
        db = Session(bind=engine)
        try:
            barrier.wait()
            time.sleep(0.05)
            outcome["job"] = activate_due(db)
        finally:
            db.close()

    threads = [threading.Thread(target=approve), threading.Thread(target=job)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    check = Session(bind=engine)
    try:
        v_now, s_now = check.get(TaxRulePackVersion, ids["v"]), check.get(TaxRulePackVersion, ids["s"])
        req = check.get(TaxRollbackRequest, ids["request"])
        rollback_won = (req.status == "APPROVED" and v_now.status == S.ROLLED_BACK and s_now.status == S.APPROVED
                        and s_now.activate_at is None and outcome.get("rollback") == "applied")
        job_won = (s_now.status == S.ACTIVE and v_now.status == S.ACTIVE and v_now.valid_to == date(2032, 1, 1)
                   and req.status == "PROPOSED" and "already followed" in outcome.get("rollback", ""))
        assert rollback_won != job_won, (outcome, req.status, v_now.status, s_now.status)
        if rollback_won:
            r = check.query(TaxRulePackVersion).filter(TaxRulePackVersion.rollback_of_id == ids["v"]).one()
            assert r.status == S.ACTIVE and r.code_version == "1"
            assert outcome["job"]["activated"] == []
        assert check.query(TaxRulePackVersion).filter(TaxRulePackVersion.code == code,
                                                      TaxRulePackVersion.status == S.ACTIVE,
                                                      TaxRulePackVersion.valid_to.is_(None)).count() == 1
    finally:
        check.close()
        rpi.clear_cache()
