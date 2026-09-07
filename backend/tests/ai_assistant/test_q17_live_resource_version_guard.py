"""
tests/ai_assistant/test_q17_live_resource_version_guard.py
-----------------------------------------------------------
CRIT-Q17 remediation — LIVE end-to-end proof that the 412 stale-write guard
now fires on REAL version changes (not via monkeypatch).

Previously `resource_version_vector` was always empty/None and
`_check_resource_versions` was a `return False` stub, so the confirm/execute
guards could never actually trigger. After the remediation:
  - `_preview_invoice_draft` records the REAL optimistic-lock `version` of the
    customer + billing-config rows the preview depends on.
  - `_check_resource_versions` re-queries those same rows at confirm/execute
    time and returns stale (True) when either version has changed since the
    preview was captured.

These tests drive a REAL ActionEngine against a real in-memory SQLite DB and
mutate the underlying rows through the real billing services (which bump the
`version` column) — so the 412 is produced by the production guard with real
inputs, end to end.
"""

from datetime import date

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.modules.billing.models import (
    Base,
    BillingCustomer,
    BillingConfiguration,
    Invoice,
)
from app.modules.billing.services.customer_service import CustomerService
from app.modules.billing.services.settings_service import BillingConfigurationService
from app.modules.chatbot.actions.action_engine import ActionEngine, ActionEngineError
from app.modules.chatbot.context.ai_context import AIContext
from app.modules.chatbot.models import (
    AIActionExecution,
    AIActionPreview,
    AIConversation,
    ConversationStatus,
    PreviewStatus,
)
from app.modules.organizations.models import Organization


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture()
def org(db):
    o = Organization(organization_name="Q17 Live", organization_code="Q17L")
    db.add(o)
    db.flush()
    return o


@pytest.fixture()
def customer(db, org):
    c = BillingCustomer(
        organization_id=org.id,
        customer_code="Q17C",
        company_name="Q17 Customer",
        display_name="Q17 Customer",
        legal_name="Q17 Customer",
        currency="USD",
        is_active=True,
    )
    db.add(c)
    db.flush()
    assert c.version == 1, "fresh customer must start at version 1"
    return c


@pytest.fixture()
def ctx(org):
    return AIContext(
        organization_id=org.id, user_id=1, tenant_context_id=1,
        role="org_admin", permissions=[], request_id="q17-live",
    )


def _draft(ae, ctx, customer_id, amount="100"):
    conv = AIConversation(
        conversation_uid=f"q17-{ctx.organization_id}",
        tenant_context_id=ctx.tenant_context_id,
        organization_id=ctx.organization_id,
        user_id=ctx.user_id,
        title="t",
        conversation_status=ConversationStatus.OPEN,
    )
    ae.db.add(conv)
    ae.db.flush()
    return ae.create_draft(
        ctx=ctx,
        action_type="invoice_draft",
        proposed_params={
            "customer_id": customer_id,
            "currency": "USD",
            "description": "q17",
            "line_items": [{"description": "q17", "quantity": 1, "unit_price": amount}],
        },
        conversation_id=conv.id,
    )


def _preview(ae, ctx, draft):
    return ae.generate_preview(ctx=ctx, action_uid=draft["action_uid"])


def _confirm(ae, ctx, draft, preview):
    return ae.confirm_action(
        ctx=ctx,
        action_uid=draft["action_uid"],
        preview_uid=preview["preview_uid"],
        preview_hash=preview["preview_hash"],
    )


def _config_id(db, org):
    cfg = db.query(BillingConfiguration).filter(
        BillingConfiguration.organization_id == org.id,
    ).first()
    assert cfg is not None, "billing config should exist after preview"
    return cfg.id


class TestLiveQ17Guard:
    def test_unchanged_resources_execute_normally(self, db, org, customer, ctx):
        """(a) no mutation between preview and execute -> the guard passes and
        the invoice is created."""
        ae = ActionEngine(db)
        draft = _draft(ae, ctx, customer.id)
        preview = _preview(ae, ctx, draft)

        # The preview must have captured a REAL version vector (not empty/None).
        preview_row = (
            db.query(AIActionPreview)
            .filter(AIActionPreview.preview_uid == preview["preview_uid"])
            .first()
        )
        assert preview_row.resource_version_vector
        assert preview_row.resource_version_vector["customer"]["version"] == customer.version
        assert preview_row.resource_version_vector["config"]["version"] == 1

        confirm = _confirm(ae, ctx, draft, preview)
        assert confirm["status"] == "confirmed"

        result = ae.execute_action(ctx=ctx, action_uid=draft["action_uid"], idempotency_key="q17-a")
        assert result["status"].lower() in ("succeeded", "executed")
        inv_id = result["result"]["invoice_id"]
        assert db.query(Invoice).filter(Invoice.id == inv_id).count() == 1

    def test_customer_updated_between_preview_and_confirm_rejected_412(self, db, org, customer, ctx):
        """(b) the customer row is mutated (version bumped) AFTER the preview
        is captured but BEFORE confirm -> confirm_action rejects with 412 and
        marks the preview SUPERSEDED, for real (no monkeypatch)."""
        ae = ActionEngine(db)
        draft = _draft(ae, ctx, customer.id)
        preview = _preview(ae, ctx, draft)

        preview_row = (
            db.query(AIActionPreview)
            .filter(AIActionPreview.preview_uid == preview["preview_uid"])
            .first()
        )
        captured_customer_version = preview_row.resource_version_vector["customer"]["version"]

        # Real write-path mutation: update the customer via the billing service,
        # which bumps the version column.
        CustomerService(db).update_customer(
            customer.id, org.id, updated_by=1, company_name="Q17 Customer Renamed",
        )
        db.expire_all()
        db.refresh(customer)
        assert customer.version == captured_customer_version + 1

        with pytest.raises(ActionEngineError) as exc:
            _confirm(ae, ctx, draft, preview)
        assert exc.value.status_code == 412
        assert "Resource versions" in str(exc.value)

        db.refresh(preview_row)
        assert preview_row.preview_status == PreviewStatus.SUPERSEDED

    def test_config_updated_between_confirm_and_execute_rejected_412(self, db, org, customer, ctx):
        """(c) after preview+confirm succeed, the billing config is mutated
        (version bumped) before execute -> execute_action rechecks and rejects
        with 412 before writing the invoice."""
        ae = ActionEngine(db)
        draft = _draft(ae, ctx, customer.id)
        preview = _preview(ae, ctx, draft)

        config_id = _config_id(db, org)
        captured_config_version = (
            db.query(AIActionPreview)
            .filter(AIActionPreview.preview_uid == preview["preview_uid"])
            .first()
        ).resource_version_vector["config"]["version"]

        _confirm(ae, ctx, draft, preview)

        # Real write-path mutation of the billing config (bumps version).
        svc = BillingConfigurationService(db)
        cfg = svc.get_configuration(org.id)
        BillingConfigurationService(db).update_configuration(
            org.id, updated_by=1, enable_discounts=not bool(cfg.enable_discounts),
        )
        db.expire_all()
        fresh_cfg = db.query(BillingConfiguration).filter(BillingConfiguration.id == config_id).first()
        assert fresh_cfg.version == captured_config_version + 1

        with pytest.raises(ActionEngineError) as exc:
            ae.execute_action(ctx=ctx, action_uid=draft["action_uid"], idempotency_key="q17-b")
        assert exc.value.status_code == 412
        assert "versions" in str(exc.value).lower()

        # No invoice was created — the write was blocked.
        assert db.query(Invoice).count() == 0
        assert db.query(AIActionExecution).count() == 0
