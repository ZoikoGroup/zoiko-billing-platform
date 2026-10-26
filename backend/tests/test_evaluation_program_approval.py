"""
tests/test_evaluation_program_approval.py
-----------------------------------------
§B3: an evaluation program cannot be activated without a logged approval.
Before the approve endpoint existed, approved_by could only be set at
creation (and the UI never sent it), so every program's Activate button was
permanently disabled.
"""

from types import SimpleNamespace

import pytest

from app.core.exceptions import BadRequestException
from app.modules.commercial.commercial_billing_router import (
    EvaluationProgramStatusRequest,
    approve_evaluation_program,
    set_evaluation_program_status,
)
from app.modules.commercial.models import CommercialEvaluationProgram
from app.modules.super_admin.models import PlatformAuditLog
from tests.test_commercial_entitlements import _plan


def _program(db, code, created_by=7):
    plan = _plan(db, code)
    program = CommercialEvaluationProgram(plan_id=plan.id, duration_days=30, created_by=created_by)
    db.add(program)
    db.commit()
    return program


def test_unapproved_program_cannot_be_activated(db_session):
    program = _program(db_session, "EVNOAPP")
    with pytest.raises(BadRequestException, match="Approve it first"):
        set_evaluation_program_status(
            program.id, EvaluationProgramStatusRequest(is_active=True),
            db=db_session, current_user=SimpleNamespace(id=7),
        )


def test_creator_can_approve_then_activate_and_both_are_audited(db_session):
    program = _program(db_session, "EVAPP", created_by=7)
    admin = SimpleNamespace(id=7)  # the creator approves their own program

    approved = approve_evaluation_program(program.id, db=db_session, current_user=admin)
    assert approved["approved_by"] == 7
    assert approved["is_active"] is False  # approval alone never activates

    activated = set_evaluation_program_status(
        program.id, EvaluationProgramStatusRequest(is_active=True), db=db_session, current_user=admin,
    )
    assert activated["is_active"] is True

    logs = (
        db_session.query(PlatformAuditLog)
        .filter(PlatformAuditLog.entity_type == "CommercialEvaluationProgram", PlatformAuditLog.entity_id == program.id)
        .order_by(PlatformAuditLog.id)
        .all()
    )
    assert [log.metadata_ and log.metadata_.get("event") for log in logs][0] == "evaluation_program_approved"
    assert [str(getattr(log.action, "value", log.action)) for log in logs] == ["update", "activate"]


def test_already_approved_program_is_not_re_approved(db_session):
    program = _program(db_session, "EVTWICE")
    approve_evaluation_program(program.id, db=db_session, current_user=SimpleNamespace(id=7))
    with pytest.raises(BadRequestException, match="already approved"):
        approve_evaluation_program(program.id, db=db_session, current_user=SimpleNamespace(id=8))
