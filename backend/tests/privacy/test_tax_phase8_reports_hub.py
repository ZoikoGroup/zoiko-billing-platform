"""ZB-TAX-ARCH-001 Phase 8 PR 6: the review-items kind filter behind the
Reports hub's anomaly card and the Review items screen (same rows, same count)."""
from datetime import datetime, timezone

from app.modules.auth.models import UserRole
from app.modules.tax.enums import ReviewItemKind, ReviewItemStatus
from app.modules.tax.models import TaxReviewItem
from tests.conftest import make_organization
from tests.privacy.test_tax_phase3a_reports_access import _tenant_user

ANOMALIES = "TAX_SNAPSHOT_MISMATCH,CREDIT_EXCEEDS_ORIGINAL"


def test_kind_filter_returns_exactly_the_anomaly_kinds(db_session, client_for):
    db = db_session
    org = make_organization(db, code="P8H", name="Hub Org")
    other = make_organization(db, code="P8HX", name="Other")
    now = datetime.now(timezone.utc)
    for org_id, kind, status in ((org.id, ReviewItemKind.TAX_SNAPSHOT_MISMATCH, ReviewItemStatus.OPEN),
                                 (org.id, ReviewItemKind.CREDIT_EXCEEDS_ORIGINAL, ReviewItemStatus.OPEN),
                                 (org.id, ReviewItemKind.TAX_SNAPSHOT_MISMATCH, ReviewItemStatus.RESOLVED),
                                 (org.id, ReviewItemKind.REGISTRATION_EXPIRING, ReviewItemStatus.OPEN),
                                 (other.id, ReviewItemKind.TAX_SNAPSHOT_MISMATCH, ReviewItemStatus.OPEN)):
        db.add(TaxReviewItem(organization_id=org_id, kind=kind, subject_type="Invoice", subject_id=1, status=status,
                             detail="x", created_at=now))
    db.commit()
    client = client_for(_tenant_user(db, org, UserRole.ORG_ADMIN, "a@p8h.example"))
    filtered = client.get("/api/v1/tax/review-items", params={"kind": ANOMALIES}).json()["items"]
    assert sorted(i["kind"] for i in filtered) == ["CREDIT_EXCEEDS_ORIGINAL", "TAX_SNAPSHOT_MISMATCH"]
    everything = client.get("/api/v1/tax/review-items").json()["items"]
    assert len(everything) == 3                                                   # open items, all kinds
    assert len([i for i in everything if i["kind"] in ANOMALIES.split(",")]) == len(filtered)
    with_resolved = client.get("/api/v1/tax/review-items", params={"kind": ANOMALIES, "include_resolved": True})
    assert len(with_resolved.json()["items"]) == 3                                # never another organization's
