"""
PHASE 3D tests — per-tenant operational health overview (Domain C purity).

Coverage:
    1  Empty database: zero summary, empty org list, PLATFORM plane marker.
    2  Per-org operational rows carry lifecycle state, user counts and
       open-incident evidence — and NEVER commercial/monetary fields.
    3  Lifecycle counts reflect real states (registration -> onboarding).
    4  Open vs resolved incidents: only open statuses count; worst open
       severity and last incident timestamp are reported.
    5  Job health counters are honest zeros when no jobs have run.
    6  Endpoint returns the validated response model.

Handlers/services are invoked directly (no HTTP layer) on the isolated
in-memory SQLite fixture — never BILLING_DATABASE_URL. conftest is untouched.
"""
from app.modules.auth.models import User, UserRole
from app.modules.auth.schemas import RegisterRequest
from app.modules.auth.service import register_enterprise
from app.modules.organizations.models import TenantLifecycleState
from app.modules.super_admin.models import AttentionItem, AttentionSeverity, AttentionStatus
from app.modules.super_admin.telemetry_service import TelemetryService
from app.modules.super_admin.router import get_tenant_health_overview
from tests.conftest import make_organization


# ── helpers ─────────────────────────────────────────────────────────────────

def _org(db, code="P3D", name=None):
    org = make_organization(db, code=code, name=name or f"Org {code}")
    db.commit()
    return org


def _org_user(db, org_id, email, role=UserRole.ORG_ADMIN, is_active=True, is_verified=True):
    user = User(
        email=email,
        hashed_password="x",
        role=role,
        organization_id=org_id,
        first_name="A",
        last_name="B",
        phone="",
        is_active=is_active,
        is_verified=is_verified,
    )
    db.add(user)
    db.flush()
    return user


def _incident(db, org_id, key, severity=AttentionSeverity.P1, status=AttentionStatus.OPEN):
    item = AttentionItem(
        source="job_failure",
        source_key=key,
        title=f"Incident {key}",
        description=None,
        severity=severity,
        status=status,
        organization_id=org_id,
        owner_user_id=None,
        correlation_id=f"corr-{key}",
    )
    db.add(item)
    db.flush()
    return item


def _overview(db):
    return TelemetryService(db).get_tenant_health_overview()


# ── tests ───────────────────────────────────────────────────────────────────

def test_empty_overview_shape(db_session):
    data = _overview(db_session)

    assert data["summary"]["total_organizations"] == 0
    assert set(data["summary"]["counts_by_lifecycle_state"].keys()) == {
        s.value for s in TenantLifecycleState
    }
    assert data["summary"]["open_incident_total"] == 0
    assert data["organizations"] == []
    assert data["plane"] == "PLATFORM"


def test_org_rows_are_operational_only(db_session):
    org = _org(db_session, "P3DA", "Health Co")
    _org_user(db_session, org.id, "admin@health.example")
    _org_user(db_session, org.id, "suspended@health.example", is_active=False)
    data = _overview(db_session)

    row = next(r for r in data["organizations"] if r["id"] == org.id)
    assert row["organization_code"] == "P3DA"
    assert row["lifecycle_state"] == "active"
    assert row["total_users"] == 2
    assert row["active_users"] == 1
    assert row["suspended_users"] == 1
    assert row["org_admins"] == 1
    # Domain C purity: no money, no commercial account/subscription fields.
    forbidden = {"can_charge", "subscription_status", "subscription_plan_code",
                 "commercial_account_status", "currency", "billing_classification"}
    assert not (forbidden & set(row.keys()))


def test_lifecycle_counts_reflect_real_states(db_session):
    register_enterprise(
        db_session,
        RegisterRequest(
            organization="Onboarding Health Co",
            name="OH Admin",
            email="oh@register.example",
            password="StrongPass123!",
            currency="USD",
            intended_plan="essentials",
        ),
    )
    _org(db_session, "P3DB", "Legacy Active Co")

    data = _overview(db_session)
    counts = data["summary"]["counts_by_lifecycle_state"]
    assert counts["onboarding"] == 1
    assert counts["active"] == 1
    assert data["summary"]["total_organizations"] == 2


def test_only_open_incidents_counted_with_worst_severity(db_session):
    org = _org(db_session, "P3DC", "Incident Co")
    _incident(db_session, org.id, "p3d-a", severity=AttentionSeverity.P2)
    _incident(db_session, org.id, "p3d-b", severity=AttentionSeverity.P0)
    _incident(db_session, org.id, "p3d-c", severity=AttentionSeverity.P1, status=AttentionStatus.RESOLVED)

    data = _overview(db_session)
    row = next(r for r in data["organizations"] if r["id"] == org.id)

    assert row["open_incident_count"] == 2
    assert row["worst_open_severity"] == "p0"
    assert row["last_incident_at"] is not None
    assert data["summary"]["open_incident_total"] == 2


def test_job_health_counters_honest_without_runs(db_session):
    data = _overview(db_session)

    assert data["summary"]["jobs_tracked"] == 0
    assert data["summary"]["jobs_with_failures_24h"] == 0
    assert data["summary"]["jobs_not_fresh"] == 0


def test_endpoint_returns_validated_model(db_session):
    _org(db_session, "P3DD", "Model Co")

    response = get_tenant_health_overview(current_user=None, db=db_session)

    assert type(response).__name__ == "TenantHealthOverviewResponse"
    assert response.summary.total_organizations == 1
    assert response.organizations[0].organization_code == "P3DD"
