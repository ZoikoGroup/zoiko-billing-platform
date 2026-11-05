"""ZB-TAX-ARCH-001 Phase 5a: the two additive backend changes the Tax
Control Center needs.

1. A missing step-up code returns error code TAX_REGISTRY_STEP_UP_REQUIRED
   (still 400, same message), so the UI can prompt and retry once.
2. GET /staged-rates/{id}/comparison: the staged rate beside the version it
   supersedes and the ACTIVE versions its period overlaps, with the current
   checks. Platform tax roles only; platform data only.
"""
from datetime import date

import pytest

from app.core.exceptions import BadRequestException
from app.modules.auth.models import PlatformRole
from app.modules.tax import registry_router
from app.modules.tax.registry_schemas import StepUpRequest
from tests.privacy.conftest import make_super_admin
from tests.test_tax_phase1_registry import _publish, _stage, people, registry  # noqa: F401 (fixtures)


def test_missing_step_up_has_its_own_error_code(db_session, registry, people):  # noqa: F811
    p = registry["pipeline"]
    row = _stage(registry, people["maker"])
    p.validate(actor_id=people["maker"].id, staged_id=row.id)
    p.submit(actor_id=people["maker"].id, staged_id=row.id, reason="r")
    db_session.commit()
    with pytest.raises(BadRequestException, match="step-up is required") as exc:
        registry_router.approve_staged_rate(staged_id=row.id, data=StepUpRequest(), db=db_session,
                                            current_user=people["checker"])
    assert exc.value.status_code == 400 and exc.value.error_code == "TAX_REGISTRY_STEP_UP_REQUIRED"


def test_missing_step_up_over_http(db_session, client_for, registry, people):  # noqa: F811
    p = registry["pipeline"]
    row = _stage(registry, people["maker"])
    p.validate(actor_id=people["maker"].id, staged_id=row.id)
    p.submit(actor_id=people["maker"].id, staged_id=row.id, reason="r")
    db_session.commit()
    response = client_for(people["checker"]).post(f"/api/v1/super-admin/tax-registry/staged-rates/{row.id}/approve",
                                                  json={})
    assert response.status_code == 400 and response.json()["error"] == "TAX_REGISTRY_STEP_UP_REQUIRED"


def test_comparison_shows_the_superseded_and_overlapping_versions(db_session, client_for, registry, people):  # noqa: F811
    current = _publish(registry, people, rate="20", valid_from=date(2011, 1, 4))
    replacement = _stage(registry, people["maker"], rate="21", valid_from=date(2026, 12, 1), supersedes=current.id)
    clash = _stage(registry, people["maker2"], rate="22", valid_from=date(2026, 12, 1))
    db_session.commit()

    client = client_for(people["maker"])
    body = client.get(f"/api/v1/super-admin/tax-registry/staged-rates/{replacement.id}/comparison").json()
    assert body["staged"]["id"] == replacement.id and str(body["staged"]["rate_percent"]) in ("21", "21.000000")
    assert body["superseded"]["id"] == current.id and body["overlapping_active"] == []
    assert body["component"]["code"] == "GB-VAT" and body["component"]["jurisdiction_code"] == "GB"
    assert body["component"]["tax_type"] == "VAT"
    assert [v["id"] for v in body["active_for_key"]] == [current.id]
    assert any("staged proposal" in c for c in body["conflicts"])           # the clashing proposal

    other = client.get(f"/api/v1/super-admin/tax-registry/staged-rates/{clash.id}/comparison").json()
    assert other["superseded"] is None and [v["id"] for v in other["overlapping_active"]] == [current.id]
    assert any(f"active version {current.id}" in c for c in other["conflicts"])


@pytest.mark.parametrize("role", [PlatformRole.PLATFORM_ADMINISTRATOR, PlatformRole.SUPPORT_OPERATOR])
def test_comparison_is_for_tax_roles_only(db_session, client_for, registry, people, role):  # noqa: F811
    row = _stage(registry, people["maker"])
    db_session.commit()
    staff = client_for(make_super_admin(db_session, f"{role.value}@p5a.example", role))
    assert staff.get(f"/api/v1/super-admin/tax-registry/staged-rates/{row.id}/comparison").status_code == 403
