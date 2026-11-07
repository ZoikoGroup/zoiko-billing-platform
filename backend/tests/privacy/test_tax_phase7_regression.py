"""ZB-TAX-ARCH-001 Phase 7 PR 2: the historical regression runner and its
approval gate (rule packs and staged rates)."""
from datetime import date, timedelta
from decimal import Decimal

import pytest

from app.config import settings
from app.modules.tax.enums import StagedRateStatus
from app.modules.tax.policy_service import RulePackService
from app.modules.tax.registry_service import RegistryStateError
from app.modules.tax.regression import runner
from app.modules.tax.regression_models import TaxRegressionReport
from tests.test_tax_phase1_registry import _publish, _stage, people, registry  # noqa: F401 (fixtures)


@pytest.fixture()
def gate_on(monkeypatch):
    monkeypatch.setattr(settings, "TAX_REGRESSION_REQUIRED", True)


def _in_approval(registry, people, **kwargs):  # noqa: F811
    p = registry["pipeline"]
    row = _stage(registry, people["maker"], **kwargs)
    p.validate(actor_id=people["maker"].id, staged_id=row.id)
    assert row.status == StagedRateStatus.VALIDATED, row.validation_errors
    p.submit(actor_id=people["maker"].id, staged_id=row.id, reason="New HMRC rate")
    return row


def test_fixtures_are_anonymised_shapes_with_a_stable_hash():
    fixtures = runner.load_fixtures()
    assert fixtures["names"] == ["uk_au_v1"] and len(fixtures["cases"]) >= 9
    assert runner.load_fixtures()["hash"] == fixtures["hash"]
    allowed = {"id", "pack", "seller_country", "buyer_country", "business", "currency", "tax_date",
               "transaction_class", "lines"}
    for case in fixtures["cases"]:
        assert set(case) <= allowed, case                                   # no names, emails, invoice numbers
        assert all(set(line) <= {"net", "supply_category", "scope"} for line in case["lines"])


def test_a_rate_change_shows_every_changed_outcome(db_session, registry, people):  # noqa: F811
    current = _publish(registry, people)                                          # 20% from 2011
    db_session.commit()
    candidate = _in_approval(registry, people, rate="21", valid_from=date(2026, 1, 1), supersedes=current.id)
    report = runner.build_report(db_session, "rate", candidate.id, people["maker"].id)
    changed = {c["case"]: c for c in report.report["changed"]}
    one = changed["GB-B2B-ONE-LINE"]
    assert one["before"]["tax"] == "20.00" and one["after"]["tax"] == "21.00"
    assert one["before"]["lines"][0]["rate"] == "20" and one["after"]["lines"][0]["rate"] == "21"
    assert "GB-EXPORT-OUTSIDE" not in changed                                     # NOT_DETERMINED both times
    assert all(not c.startswith("AU-") for c in report.report["results"])          # other component: not run
    assert report.changed_count == len(changed) and report.case_count == 6
    runner.run(db_session, [], {})                                                # nothing else written
    assert db_session.query(TaxRegressionReport).count() == 1


def test_a_rate_outside_the_fixture_dates_changes_nothing(db_session, registry, people):  # noqa: F811
    current = _publish(registry, people)
    db_session.commit()
    future = _in_approval(registry, people, rate="25", valid_from=date(2030, 1, 1), supersedes=current.id)
    assert runner.build_report(db_session, "rate", future.id, people["maker"].id).report["changed"] == []


def test_rate_approval_is_refused_without_a_current_report(db_session, registry, people, gate_on, monkeypatch):  # noqa: F811
    p = registry["pipeline"]
    row = _in_approval(registry, people, rate="20")
    with pytest.raises(RegistryStateError, match="no regression report"):
        p.approve(actor_id=people["checker"].id, staged_id=row.id)
    runner.build_report(db_session, "rate", row.id, people["maker"].id)
    assert runner.currency_problem(db_session, "rate", row.id) is None
    real = runner.load_fixtures
    monkeypatch.setattr(runner, "load_fixtures", lambda: {**real(), "hash": "different"})
    with pytest.raises(RegistryStateError, match="fixtures changed"):
        p.approve(actor_id=people["checker"].id, staged_id=row.id)
    monkeypatch.setattr(runner, "load_fixtures", real)
    p.approve(actor_id=people["checker"].id, staged_id=row.id)
    assert row.status == StagedRateStatus.APPROVED


def test_a_report_goes_stale_when_the_baseline_changes_or_it_ages(db_session, registry, people, monkeypatch):  # noqa: F811
    _publish(registry, people, rate="20", valid_from=date(2011, 1, 4), valid_to=date(2020, 1, 1))
    first = _in_approval(registry, people, rate="21", valid_from=date(2026, 1, 1))
    runner.build_report(db_session, "rate", first.id, people["maker"].id)
    _publish(registry, people, rate="19", valid_from=date(2021, 1, 1), valid_to=date(2025, 1, 1))   # baseline changes
    monkeypatch.setattr(settings, "TAX_REGRESSION_REQUIRED", True)
    assert "baseline" in runner.currency_problem(db_session, "rate", first.id)
    report = runner.build_report(db_session, "rate", first.id, people["maker"].id)
    assert runner.currency_problem(db_session, "rate", first.id) is None
    report.generated_at = report.generated_at - timedelta(hours=73)
    db_session.flush()
    assert "older than 72 hours" in runner.currency_problem(db_session, "rate", first.id)


def test_rule_pack_reports_compare_with_the_active_version_and_gate_approval(db_session, registry, people, monkeypatch):  # noqa: F811
    _publish(registry, people)                                                   # GB 20%
    pack = RulePackService(db_session).register(actor_id=people["maker"].id, code="GB-VAT-DOMESTIC-SERVICES")
    db_session.commit()
    monkeypatch.setattr(settings, "TAX_REGRESSION_REQUIRED", True)
    with pytest.raises(RegistryStateError, match="regression report"):
        RulePackService(db_session)._before_approve(pack)
    report = runner.build_report(db_session, "rule_pack", pack.id, people["maker"].id)
    assert report.baseline_ref == "rule_pack:none" and set(report.report["new_cases"]) >= {"GB-B2B-ONE-LINE"}
    results = report.report["results"]
    assert results["GB-B2B-ONE-LINE"]["tax"] == "20.00"
    assert results["GB-B2C-THREE-LINES"]["tax"] == "20.01"                       # PER_LINE: 6.67 + 6.67 + 6.67
    assert results["GB-EXPORT-OUTSIDE"]["lines"][0]["outcome"] == "NOT_DETERMINED"
    assert results["GB-WRONG-CURRENCY"]["tax"] is None and results["GB-GOODS-OUTSIDE"]["tax"] is None
    RulePackService(db_session)._before_approve(pack)                            # current: passes


def test_au_per_document_rounding_differs_from_per_line(db_session, registry, people):  # noqa: F811
    from app.modules.tax.engines import registered_rule_packs
    from app.modules.tax.registry_models import TaxComponent, TaxJurisdiction, TaxTypeDefinition, TaxAuthority
    from tests.test_tax_phase3a_governed import registry_rate

    au = TaxJurisdiction(code="AU", name="Australia", level="country", country_code="AU", timezone="Australia/Sydney")
    gst = TaxTypeDefinition(code="GST", name="GST")
    db_session.add_all([au, gst])
    db_session.flush()
    authority = TaxAuthority(code="AU-ATO", name="ATO", jurisdiction_id=au.id)
    db_session.add(authority)
    db_session.flush()
    component = TaxComponent(code="AU-GST", name="GST", jurisdiction_id=au.id, tax_type_id=gst.id,
                             authority_id=authority.id)
    db_session.add(component)
    db_session.flush()
    registry_rate(db_session, component, "10", date(2000, 7, 1))
    case = next(c for c in runner.load_fixtures()["cases"] if c["id"] == "AU-B2C-PER-DOCUMENT")
    result = runner.run_case(db_session, case, registered_rule_packs()["AU-GST-DOMESTIC-SERVICES"])
    assert [l["tax"] for l in result["lines"]] == ["0.01", "0.01", "0.01"]       # 0.005 each, rounded per line
    assert result["tax"] == "0.02"                                               # 0.015 rounded once per document
    assert Decimal(result["lines"][0]["rate"]) == 10


def test_regression_routes(db_session, client_for, registry, people):  # noqa: F811
    row = _in_approval(registry, people, rate="20")
    db_session.commit()
    maker = client_for(people["maker"])
    ran = maker.post(f"/api/v1/super-admin/tax-registry/regression/rate/{row.id}")
    assert ran.status_code == 200 and ran.json()["current_problem"] is None and ran.json()["cases"] >= 1
    got = maker.get(f"/api/v1/super-admin/tax-registry/regression/rate/{row.id}").json()
    assert got["report"]["id"] == ran.json()["id"]
    assert maker.post("/api/v1/super-admin/tax-registry/regression/widget/1").status_code == 400
    checker = client_for(people["checker"])                                       # publisher: read only
    assert checker.post(f"/api/v1/super-admin/tax-registry/regression/rate/{row.id}").status_code == 403
    assert checker.get(f"/api/v1/super-admin/tax-registry/regression/rate/{row.id}").status_code == 200
