"""
PHASE 3C tests — platform-wide lifecycle & onboarding read model.

Coverage:
    1  Empty database: zero counts, every state present, empty lists,
       PLATFORM plane marker.
    2  Registered org lands in the PROVISIONING/ONBOARDING pipeline with
       evidence-based readiness and blockers.
    3  Governed suspend/reactivate transitions record recent_transitions
       events (from/to/reason/actor/correlation) and counts track state.
    4  SUSPENDED org appears under blocked_organizations with the latest
       recorded transition reason and timestamp.
    5  Endpoint handler returns the validated response model directly.

Handlers are invoked directly (no HTTP layer) on the isolated in-memory
SQLite fixture — never BILLING_DATABASE_URL. conftest is untouched.
"""
from app.modules.auth.models import User, UserRole
from app.modules.auth.schemas import RegisterRequest
from app.modules.auth.service import register_enterprise
from app.modules.organizations.models import TenantLifecycleState
from app.modules.super_admin.lifecycle_service import TenantLifecycleService
from app.modules.super_admin.router import (
    get_super_admin_platform_lifecycle,
    transition_super_admin_organization_lifecycle,
)
from tests.conftest import make_organization


# ── helpers ─────────────────────────────────────────────────────────────────

class _TransitionSchema:
    def __init__(self, target: str, reason: str):
        self.target = target
        self.reason = reason


def _sa_user(db):
    user = User(
        email="sa@p3c.example",
        hashed_password="x",
        role=UserRole.SUPER_ADMIN,
        organization_id=None,
        first_name="S",
        last_name="A",
        phone="",
        is_active=True,
        is_verified=True,
    )
    db.add(user)
    db.flush()
    return user


def _org(db, code="P3C", name=None):
    org = make_organization(db, code=code, name=name or f"Org {code}")
    db.commit()
    return org


def _overview(db):
    return get_super_admin_platform_lifecycle(current_user=None, db=db)


def _transition(db, sa, org_id, target, reason="Operational decision"):
    return transition_super_admin_organization_lifecycle(
        organization_id=org_id,
        data=_TransitionSchema(target=target, reason=reason),
        current_user=sa,
        db=db,
    )


# ── tests ───────────────────────────────────────────────────────────────────

def test_empty_platform_overview_shape(db_session):
    data = _overview(db_session)

    assert data.total_organizations == 0
    # Every lifecycle state is represented so UI badges stay stable.
    assert set(data.counts_by_state.keys()) == {s.value for s in TenantLifecycleState}
    assert all(count == 0 for count in data.counts_by_state.values())
    assert data.onboarding_pipeline == []
    assert data.blocked_organizations == []
    assert data.recent_transitions == []
    assert data.plane == "PLATFORM"
    assert data.generated_at is not None


def test_registered_org_enters_onboarding_pipeline_with_readiness(db_session):
    register_enterprise(
        db_session,
        RegisterRequest(
            organization="Pipeline Co",
            name="Pipe Admin",
            email="pipe@register.example",
            password="StrongPass123!",
            currency="USD",
            intended_plan="essentials",
        ),
    )

    data = _overview(db_session)

    assert data.counts_by_state["onboarding"] == 1
    assert len(data.onboarding_pipeline) == 1
    item = data.onboarding_pipeline[0]
    assert item.organization_code  # generated code, non-empty
    assert item.state == "onboarding"
    assert item.registered_at is not None
    readiness = item.onboarding_readiness
    assert readiness["administrator"] == "ready"  # register_enterprise seeds an ORG_ADMIN
    assert readiness["configuration"] == "ready"  # ...and a BillingConfiguration row
    assert readiness["billing"] == "pending"      # no commercial subscription yet
    assert readiness["integration"] == "unknown"  # honestly unknown — never guessed
    assert "No open commercial subscription" in item.blockers
    assert "Integration status unknown" in item.blockers


def test_transition_events_recorded_and_counts_track_state(db_session):
    org = _org(db_session, "P3CA", "Pipeline A Co")
    sa = _sa_user(db_session)

    # Governed path from the default ACTIVE state: suspend, then reactivate.
    # ACTIVE -> PROVISIONING is invalid by design (forward-only-ish map).
    _transition(db_session, sa, org.id, "suspended", reason="Payment abuse investigation")
    result = _transition(db_session, sa, org.id, "active", reason="Investigation cleared")

    assert result.current_state == "active"

    data = _overview(db_session)
    assert data.counts_by_state["active"] == 1
    assert data.counts_by_state["suspended"] == 0
    assert data.onboarding_pipeline == []

    events = [e for e in data.recent_transitions if e.organization_id == org.id]
    assert len(events) == 2
    latest = events[0]  # ordered newest-first
    assert latest.from_state == "suspended"
    assert latest.to_state == "active"
    assert latest.reason == "Investigation cleared"
    assert latest.actor_email == sa.email
    assert latest.correlation_id.startswith("lc-")
    assert latest.organization_code == org.organization_code


def test_suspended_org_listed_as_blocked_with_last_transition_evidence(db_session):
    org = _org(db_session, "P3CB", "Blocked Co")
    sa = _sa_user(db_session)
    _transition(db_session, sa, org.id, "suspended", reason="Payment abuse investigation")

    data = _overview(db_session)

    assert data.counts_by_state["suspended"] == 1
    assert len(data.blocked_organizations) == 1
    blocked = data.blocked_organizations[0]
    assert blocked.id == org.id
    assert blocked.lifecycle_state == "suspended"
    assert blocked.last_transition_reason == "Payment abuse investigation"
    assert blocked.last_transition_at is not None


def test_endpoint_returns_validated_response_model(db_session):
    _org(db_session, "P3CC", "Model Co")

    response = get_super_admin_platform_lifecycle(current_user=None, db=db_session)

    assert type(response).__name__ == "PlatformLifecycleResponse"
    assert response.total_organizations == 1
    service_view = TenantLifecycleService(db_session).platform_overview()
    assert response.counts_by_state == service_view["counts_by_state"]
