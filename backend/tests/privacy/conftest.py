import json
import os
from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

_evidence_records = []


def pytest_configure(config):
    config.addinivalue_line("markers", "control(*ids): map test to security/privacy control IDs (e.g. AUD-01, FIN-07)")


def control(*ids):
    """Marker helper to tag tests with control IDs for automated evidence generation."""
    return pytest.mark.control(*ids)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    if report.when == "call":
        controls = []
        for marker in item.iter_markers(name="control"):
            controls.extend(marker.args)
        if controls:
            _evidence_records.append({
                "test": item.nodeid,
                "controls": list(controls),
                "outcome": report.outcome,
                "duration": round(report.duration, 4),
                "timestamp": datetime.utcnow().isoformat(),
            })


def pytest_sessionfinish(session, exitstatus):
    if _evidence_records:
        evidence_dir = os.path.join(os.getcwd(), "evidence")
        try:
            import subprocess
            try:
                commit_sha = subprocess.check_output(
                    ["git", "rev-parse", "HEAD"], stderr=subprocess.DEVNULL, text=True
                ).strip()
            except Exception:
                commit_sha = os.environ.get("GITHUB_SHA", "unknown")
            os.makedirs(evidence_dir, exist_ok=True)
            report_path = os.path.join(evidence_dir, "privacy_control_report.json")
            with open(report_path, "w", encoding="utf-8") as f:
                json.dump({
                    "generated_at": datetime.utcnow().isoformat(),
                    "git_commit_sha": commit_sha,
                    "total_tests": len(_evidence_records),
                    "records": _evidence_records,
                }, f, indent=2)
        except Exception:
            pass


from app.database import Base

from app.core.dependencies import get_current_user
from app.database import get_db
from app.main import app
from app.modules.auth.models import PlatformRole, User, UserRole
from app.modules.billing.models import (
    CreditNote,
    CreditNoteApplication,
    CreditNoteStatus,
    CreditNoteType,
    DunningCase,
    DunningStatus,
    InvoiceStatus,
    PaymentAllocation,
    PaymentStatus,
    Refund,
    RefundStatus,
    RefundType,
    WriteOff,
    WriteOffStatus,
    WriteOffType,
)
from tests.conftest import make_customer, make_invoice, make_organization, make_payment

SECRET_CUSTOMER = "SECRET-CUSTOMER-{}"
SECRET_INVOICE = "INV-SECRET-{}"
SECRET_STRINGS_PREFIXES = ("SECRET-CUSTOMER", "INV-SECRET", "CN-SECRET", "RF-SECRET", "WO-SECRET", "PAY-SECRET")

# Endpoints whose shape changed in ZB-SEC-PRIV-001.
AGGREGATE_ENDPOINTS = [
    "/api/super-admin/billing-command-center/overdue-invoices",
    "/api/super-admin/billing-command-center/collections-risk",
    "/api/super-admin/billing-command-center/recent-activity",
    "/api/super-admin/financial-operations/failed-payments",
    "/api/super-admin/financial-operations/dunning-cases",
    "/api/super-admin/financial-operations/allocation-exceptions",
    "/api/super-admin/financial-operations/credit-applications",
    "/api/super-admin/financial-operations/credit-notes",
    "/api/super-admin/financial-operations/refunds",
    "/api/super-admin/financial-operations/write-offs",
    "/api/super-admin/financial-consistency",
]


@pytest.fixture()
def db_session():
    """In-memory SQLite shared across threads (StaticPool). The parent
    conftest's engine gives each thread its own empty :memory: database, which
    breaks TestClient requests (they run in a worker thread)."""
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def make_super_admin(db, email, platform_role):
    user = User(
        email=email, hashed_password="x", role=UserRole.SUPER_ADMIN, organization_id=None,
        first_name="S", last_name="A", is_active=True, is_verified=True,
        platform_role=platform_role,
    )
    db.add(user)
    db.commit()
    return user


@pytest.fixture()
def client_for(db_session):
    def _make(user):
        app.dependency_overrides[get_db] = lambda: db_session
        app.dependency_overrides[get_current_user] = lambda: user
        return TestClient(app, raise_server_exceptions=False)

    yield _make
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)


@pytest.fixture()
def platform_admin(db_session):
    return make_super_admin(db_session, "padmin@privacy.example", PlatformRole.PLATFORM_ADMINISTRATOR)


@pytest.fixture()
def auditor(db_session):
    return make_super_admin(db_session, "auditor@privacy.example", PlatformRole.AUDITOR)


@pytest.fixture()
def finance_readonly(db_session):
    return make_super_admin(db_session, "fin@privacy.example", PlatformRole.FINANCE_READONLY)


def seed_tenant(db, tag, name, n, currency="USD"):
    """Create one tenant with `n` of every record kind, all carrying
    unmistakable identifying strings (customer name, document numbers,
    free-text reasons)."""
    org = make_organization(db, code=f"ORG-{tag}", name=name)
    customer = make_customer(db, org.id, code=f"C-{tag}", currency=currency, email=f"secret-{tag.lower()}@leak.example")
    customer.company_name = SECRET_CUSTOMER.format(tag)
    customer.display_name = SECRET_CUSTOMER.format(tag)
    db.flush()
    for i in range(n):
        inv = make_invoice(
            db, org.id, customer.id, status=InvoiceStatus.OVERDUE, total_amount="100.00",
            currency=currency, invoice_number=f"{SECRET_INVOICE.format(tag)}-{i}",
        )
        inv.due_date = date.today() - timedelta(days=45)
        inv.sent_at = None
        pay = make_payment(
            db, org.id, customer.id, amount="10.00", status=PaymentStatus.FAILED,
            currency=currency, payment_number=f"PAY-SECRET-{tag}-{i}",
        )
        pay.failure_code = "card_declined"
        pay.failure_reason = f"{SECRET_CUSTOMER.format(tag)} card declined"
        db.add(DunningCase(
            organization_id=org.id, customer_id=customer.id, invoice_id=inv.id,
            status=DunningStatus.ACTIVE, current_level=1,
            total_overdue_amount=Decimal("100.00"), days_overdue=45,
        ))
        cn = CreditNote(
            organization_id=org.id, customer_id=customer.id, credit_note_number=f"CN-SECRET-{tag}-{i}",
            credit_note_type=CreditNoteType.PARTIAL_CREDIT, status=CreditNoteStatus.ISSUED,
            total_amount="10.00", remaining_amount="10.00", currency=currency,
            reason=f"{SECRET_CUSTOMER.format(tag)} goodwill", issue_date=date.today(),
        )
        db.add(cn)
        db.flush()
        db.add(CreditNoteApplication(organization_id=org.id, credit_note_id=cn.id, invoice_id=inv.id, amount=Decimal("5.00")))
        db.add(Refund(
            organization_id=org.id, customer_id=customer.id, refund_number=f"RF-SECRET-{tag}-{i}",
            refund_type=RefundType.FULL, status=RefundStatus.COMPLETED, amount="7.00", currency=currency,
            reason=f"{SECRET_CUSTOMER.format(tag)} refund",
        ))
        db.add(WriteOff(
            organization_id=org.id, customer_id=customer.id, write_off_number=f"WO-SECRET-{tag}-{i}",
            write_off_type=list(WriteOffType)[0], status=WriteOffStatus.EXECUTED, amount="3.00",
            currency=currency, reason=f"{SECRET_CUSTOMER.format(tag)} write-off",
        ))
        # over-allocated payment -> allocation exception + reconciliation exception
        db.add(PaymentAllocation(
            organization_id=org.id, payment_id=pay.id, invoice_id=inv.id, amount=Decimal("500.00"),
        ))
    db.commit()
    return org
