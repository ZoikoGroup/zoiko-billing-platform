"""
app/modules/tax/policy_service.py
---------------------------------
Platform tax policy workflows (ZB-TAX-ARCH-001 Phase 2): market availability
(§05, §13.2) and the product tax-code taxonomy (§07, §11).

Both follow the Phase 1 registry pattern: draft -> validate -> TAX_REVIEWER
submits -> a different TAX_PUBLISHER approves and publishes (MFA step-up is
enforced at the route). The decision itself is an ``approval_requests`` row,
so ApprovalService's self-approval guard applies. Publishing supersedes the
previous ACTIVE version first, then activates the new one; nothing decided is
ever edited in place. Nothing here commits.
"""
import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import event, func, inspect
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, object_session

from app.core.capabilities import has_capability
from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException
from app.modules.super_admin.approval_service import ApprovalService, SelfApprovalError
from app.modules.super_admin.audit_service import PlatformAuditService
from app.modules.super_admin.models import PlatformAuditAction
from app.modules.tax.enums import (
    CALCULATING_MODES,
    EDITABLE_PLATFORM_STATUSES,
    PLATFORM_AVAILABILITY_MODES,
    GateStatus,
    MarketGate,
    PlatformVersionStatus,
    SupplyCategory,
    TaxOperatingMode,
    TransactionClass,
)
from app.modules.tax.policy_models import (
    AVAILABILITY_CONTENT_FIELDS,
    CODE_SET_CONTENT_FIELDS,
    RULE_PACK_CONTENT_FIELDS,
    TaxActivationCancellation,
    TaxCode,
    TaxCodeSetVersion,
    TaxMarketAvailabilityVersion,
    TaxRulePackVersion,
)
from app.modules.tax.registry_models import TaxJurisdiction, TaxLegalSourceRevision, TaxTypeDefinition
from app.modules.tax.registry_service import MakerCheckerError, RegistryImmutabilityError, RegistryStateError, utcnow
from app.modules.tax.rule_pack_integrity import code_hash

logger = logging.getLogger("zoiko_billing.tax.policy")


def rule_pack_class(code: str, version: str):
    """The exact pack version in the running code (lazy: engines imports this module's dependencies)."""
    from app.modules.tax.engines import rule_pack_class as lookup

    return lookup(code, version)

#: Gates that can never be waived as NOT_APPLICABLE for a calculating mode.
MANDATORY_GATES = frozenset({
    MarketGate.LEGAL_AUTHORITY_AND_USAGE_RIGHTS,
    MarketGate.SOURCE_PROVENANCE_AND_FRESHNESS,
    MarketGate.GOLDEN_TESTS_SIGNED_OFF,
})


#: Gate 05 is about the external provider: it can be NOT_APPLICABLE for a
#: native pack or tenant rate, never for a provider market (launch-gate gap G1).
PROVIDER_MANDATORY_GATES = MANDATORY_GATES | {MarketGate.PROVIDER_CONTRACTS_AND_RECOVERY}


def mandatory_gates(mode: TaxOperatingMode) -> frozenset:
    return PROVIDER_MANDATORY_GATES if mode == TaxOperatingMode.PROVIDER_APPROVED else MANDATORY_GATES


# ── ORM guard: content frozen once submitted; ACTIVE only -> SUPERSEDED ──

_CONTENT = {TaxMarketAvailabilityVersion: AVAILABILITY_CONTENT_FIELDS, TaxCodeSetVersion: CODE_SET_CONTENT_FIELDS,
            TaxRulePackVersion: RULE_PACK_CONTENT_FIELDS}


def _committed(obj, key):
    hist = inspect(obj).attrs[key].history
    return hist.deleted[0] if hist.deleted else getattr(obj, key)


@event.listens_for(Session, "before_flush")
def _guard_policy_versions(session, flush_context, instances):
    for obj in session.deleted:
        if isinstance(obj, tuple(_CONTENT)) and _committed(obj, "status") not in EDITABLE_PLATFORM_STATUSES:
            raise RegistryImmutabilityError(f"{type(obj).__name__} {obj.id} has been submitted and cannot be deleted.")
        if isinstance(obj, TaxCode) and obj.code_set_version.status not in EDITABLE_PLATFORM_STATUSES:
            raise RegistryImmutabilityError("Tax codes of a submitted code-set version are frozen.")
    for obj in session.dirty:
        if isinstance(obj, tuple(_CONTENT)):
            state = inspect(obj)
            changed = {a.key for a in state.mapper.column_attrs if state.attrs[a.key].history.has_changes()}
            old_status = _committed(obj, "status")
            if old_status not in EDITABLE_PLATFORM_STATUSES and changed & set(_CONTENT[type(obj)]):
                raise RegistryImmutabilityError(f"{type(obj).__name__} {obj.id} content is frozen once submitted.")
            if old_status in (PlatformVersionStatus.SUPERSEDED, PlatformVersionStatus.ROLLED_BACK) and changed:
                raise RegistryImmutabilityError(
                    f"{type(obj).__name__} {obj.id} is {old_status.name.lower()} and immutable.")
            allowed = {"status", "superseded_at"}
            if isinstance(obj, TaxRulePackVersion) and _committed(obj, "valid_to") is None:
                allowed.add("valid_to")                    # Phase 8 PR 2: the end date, set once
            if old_status == PlatformVersionStatus.ACTIVE and changed - allowed:
                raise RegistryImmutabilityError(f"{type(obj).__name__} {obj.id} is active: it can only be superseded.")
        elif isinstance(obj, TaxCode) and obj.code_set_version.status not in EDITABLE_PLATFORM_STATUSES:
            raise RegistryImmutabilityError("Tax codes of a submitted code-set version are frozen.")
    for obj in list(session.dirty) + list(session.deleted):
        if isinstance(obj, TaxActivationCancellation):
            if obj in session.deleted:
                raise RegistryImmutabilityError(f"Activation cancellation {obj.id} cannot be deleted.")
            if _committed(obj, "status") != "PROPOSED":
                raise RegistryImmutabilityError(f"Activation cancellation {obj.id} is decided and final.")
        from app.modules.tax.policy_models import TaxRollbackRequest

        if isinstance(obj, TaxRollbackRequest):                       # Phase 8 PR 3
            if obj in session.deleted:
                raise RegistryImmutabilityError(f"Rollback request {obj.id} cannot be deleted.")
            if _committed(obj, "status") != "PROPOSED":
                raise RegistryImmutabilityError(f"Rollback request {obj.id} is decided and final.")
    for obj in session.new:
        if isinstance(obj, TaxCode) and obj.code_set_version is not None \
                and obj.code_set_version.status not in EDITABLE_PLATFORM_STATUSES:
            raise RegistryImmutabilityError("Tax codes of a submitted code-set version are frozen.")


# ── Shared maker-checker workflow ────────────────────────────────────────

class _VersionWorkflow:
    model = None
    request_type = ""
    entity_type = ""

    def __init__(self, db: Session):
        self.db = db
        self.audit = PlatformAuditService(db)
        self.approvals = ApprovalService(db)

    def get(self, version_id: int):
        row = self.db.get(self.model, version_id)
        if row is None:
            raise NotFoundException(self.entity_type, version_id)
        return row

    def _log(self, actor_id, action, row, **kw):
        self.audit.log_no_commit(actor_id=actor_id, actor_role="super_admin" if actor_id else "system",
                                 action=action, entity_type=self.entity_type, entity_id=row.id, **kw)

    def errors(self, row) -> list[str]:
        raise NotImplementedError

    def describe(self, row) -> dict:
        raise NotImplementedError

    def _key_filter(self, row):
        raise NotImplementedError

    def _require_editable(self, row):
        if row.status not in EDITABLE_PLATFORM_STATUSES:
            raise RegistryStateError(f"{self.entity_type} {row.id} is {row.status.name}; it can no longer be edited.")

    def _reset(self, row):
        row.status = PlatformVersionStatus.PENDING_REVIEW
        row.validation_errors = None

    def validate(self, *, actor_id: Optional[int], version_id: int):
        row = self.get(version_id)
        self._require_editable(row)
        errors = self.errors(row)
        row.validation_errors = errors or None
        row.status = PlatformVersionStatus.VALIDATION_FAILED if errors else PlatformVersionStatus.VALIDATED
        self.db.flush()
        self._log(actor_id, PlatformAuditAction.UPDATE, row, metadata={"validated": not errors, "errors": errors})
        return row

    def submit(self, *, actor_id: int, version_id: int, reason: str):
        row = self.get(version_id)
        if row.status != PlatformVersionStatus.VALIDATED:
            raise RegistryStateError(f"{self.entity_type} {row.id} is {row.status.name}; validate it before submitting.")
        errors = self.errors(row)
        if errors:
            raise RegistryStateError("Validation no longer passes: " + "; ".join(errors))
        current = self.current_for(row)
        request = self.approvals.create_request(
            request_type=self.request_type, requested_by_user_id=actor_id, reason=reason,
            scope={"version_id": row.id}, before_state=self.describe(current) if current else None,
            proposed_state=self.describe(row), correlation_id=f"{self.model.__tablename__}:{row.id}",
        )
        row.approval_request_id = request.id
        row.maker_user_id = actor_id
        row.submitted_at = utcnow()
        row.status = PlatformVersionStatus.IN_APPROVAL
        self.db.flush()
        self._log(actor_id, PlatformAuditAction.UPDATE, row, reason=reason,
                  metadata={"submitted": True, "approval_request_id": request.id})
        return row

    def _assert_not_maker(self, row, actor_id: int, action: str):
        if actor_id in {row.maker_user_id, row.created_by_user_id} - {None}:
            raise MakerCheckerError(f"You prepared this version; a different person must {action} it.")

    def approve(self, *, actor_id: int, version_id: int):
        row = self.get(version_id)
        if row.status != PlatformVersionStatus.IN_APPROVAL:
            raise RegistryStateError(f"{self.entity_type} {row.id} is {row.status.name}, not IN_APPROVAL.")
        self._assert_not_maker(row, actor_id, "approve")
        errors = self.errors(row)
        if errors:
            raise RegistryStateError("Validation no longer passes: " + "; ".join(errors))
        self._before_approve(row)
        request = self.approvals.get_request(row.approval_request_id)
        try:
            self.approvals.approve(request, approver_user_id=actor_id)
        except SelfApprovalError as exc:
            raise MakerCheckerError(str(exc))
        row.checker_user_id = actor_id
        row.approved_at = utcnow()
        row.status = PlatformVersionStatus.APPROVED
        self.db.flush()
        self._log(actor_id, PlatformAuditAction.UPDATE, row, metadata={"approved": True})
        return row

    def _before_approve(self, row) -> None:
        """Hook for workflow-specific approval gates."""

    def reject(self, *, actor_id: int, version_id: int, reason: str):
        row = self.get(version_id)
        if row.status == PlatformVersionStatus.IN_APPROVAL:
            self._assert_not_maker(row, actor_id, "reject")
            try:
                self.approvals.reject(self.approvals.get_request(row.approval_request_id),
                                      approver_user_id=actor_id, rejection_reason=reason)
            except SelfApprovalError as exc:
                raise MakerCheckerError(str(exc))
            row.checker_user_id = actor_id
        elif row.status not in EDITABLE_PLATFORM_STATUSES | {PlatformVersionStatus.APPROVED}:
            raise RegistryStateError(f"{self.entity_type} {row.id} is {row.status.name}; it cannot be rejected.")
        elif row.status == PlatformVersionStatus.APPROVED:
            self._assert_not_maker(row, actor_id, "reject")
        row.status = PlatformVersionStatus.REJECTED
        row.rejection_reason = reason
        self.db.flush()
        self._log(actor_id, PlatformAuditAction.UPDATE, row, reason=reason, metadata={"rejected": True})
        return row

    def publish(self, *, actor_id: int, version_id: int, activate_at_local: Optional[str] = None,
                timezone: Optional[str] = None, utc_offset: Optional[str] = None):
        """Publish now, or (Phase 8 PR 2) schedule: a future local activation
        time makes the version SCHEDULED until the activation job runs."""
        from app.modules.tax.activation import local_to_utc

        row = self.get(version_id)
        if row.status != PlatformVersionStatus.APPROVED:
            raise RegistryStateError(f"{self.entity_type} {row.id} is {row.status.name}, not APPROVED.")
        self._assert_not_maker(row, actor_id, "publish")
        errors = self.errors(row)
        if errors:
            raise RegistryStateError("Validation no longer passes: " + "; ".join(errors))
        now = utcnow()
        tz = (timezone or "").strip() or self._timezone(row)
        if activate_at_local:
            if not hasattr(self.model, "activate_at"):
                raise BadRequestException(f"A {self.entity_type} can't be scheduled; publish it now.")
            if not tz:
                raise BadRequestException("This jurisdiction spans several time zones: choose the time zone the "
                                          "activation time is in.")
            when = local_to_utc(activate_at_local, tz, utc_offset)
            if when > now:
                return self._schedule(row, actor_id, when, activate_at_local.strip(), tz)
        self._before_activate(row, now, tz)
        return self._activate(row, actor_id, now)

    # ── Phase 8 PR 2 hooks and steps ──
    def _timezone(self, row) -> Optional[str]:
        """The legal time zone of the version's jurisdiction, if it has one."""
        return None

    def _before_activate(self, row, when: datetime, tz: Optional[str]) -> None:
        """Checks that depend on the activation time (packs: date ranges)."""

    def _close_predecessor(self, row, now: datetime) -> None:
        current = self.current_for(row)
        if current is not None:
            # Supersede first: the one-ACTIVE-per-key unique index is immediate.
            current.status = PlatformVersionStatus.SUPERSEDED
            current.superseded_at = now
            self.db.flush()
            row.predecessor_id = current.id

    def _schedule(self, row, actor_id: int, when: datetime, local: str, tz: str):
        other = self.db.query(self.model).filter(self._key_filter(row), self.model.id != row.id,
                                                 self.model.status == PlatformVersionStatus.SCHEDULED).first()
        if other is not None:
            raise RegistryStateError(f"{self.entity_type} {other.id} is already scheduled for this; cancel it first.")
        self._before_activate(row, when, tz)
        row.status = PlatformVersionStatus.SCHEDULED
        row.activate_at, row.activate_at_local, row.activate_tz = when, local, tz
        row.scheduled_by_user_id = actor_id
        row.activation_error = None
        self.db.flush()
        self._log(actor_id, PlatformAuditAction.UPDATE, row, metadata={
            "scheduled": True, "activate_at": when.isoformat(), "activate_at_local": local, "activate_tz": tz})
        return row

    def _activate(self, row, actor_id: Optional[int], now: datetime, scheduled: bool = False):
        self._close_predecessor(row, now)
        row.status = PlatformVersionStatus.ACTIVE
        row.published_at = now
        row.publisher_user_id = actor_id
        if hasattr(row, "activation_error"):
            row.activation_error = None
        self.db.flush()
        meta = {"published": True, "predecessor_id": row.predecessor_id}
        if scheduled:
            meta.update({"activated_by_schedule": True, "activate_at": row.activate_at.isoformat()})
        self._log(actor_id, PlatformAuditAction.UPDATE, row, metadata=meta)
        return row

    def activate_due(self, version_id: int, now: datetime):
        """The activation job's step for one row: lock, re-check, activate.
        A failed re-check leaves it SCHEDULED with activation_error set."""
        from app.modules.tax.activation import aware

        query = self.db.query(self.model).filter(self.model.id == version_id).populate_existing()
        if self.db.get_bind().dialect.name == "postgresql":
            query = query.with_for_update(skip_locked=True)
        row = query.first()
        if row is None or row.status != PlatformVersionStatus.SCHEDULED or aware(row.activate_at) > now:
            return None
        problems = list(self.errors(row))
        if not problems:
            try:
                self._before_approve(row)                   # Phase 7 regression gate
                self._before_activate(row, now, row.activate_tz)
            except SQLAlchemyError:
                raise
            except Exception as exc:                        # noqa: BLE001  (recorded, never swallowed silently)
                problems.append(getattr(exc, "message", None) or str(exc))
        if problems:
            message = "; ".join(problems)[:2000]
            if row.activation_error != message:
                row.activation_error = message
                self.db.flush()
                self._log(row.scheduled_by_user_id, PlatformAuditAction.UPDATE, row,
                          metadata={"activation_failed": True, "errors": problems})
            return None
        return self._activate(row, row.scheduled_by_user_id, now, scheduled=True)

    def current_for(self, row):
        return self.db.query(self.model).filter(
            self._key_filter(row), self.model.status == PlatformVersionStatus.ACTIVE,
            self.model.id != row.id,
        ).first()


# ── Market availability ──────────────────────────────────────────────────

def _gate_template() -> dict:
    return {g.name: {"status": GateStatus.NOT_STARTED.name, "evidence_ref": None, "notes": None} for g in MarketGate}


def current_availability(db: Session, jurisdiction_id: int, tax_type_id: int,
                         transaction_class: TransactionClass) -> Optional[TaxMarketAvailabilityVersion]:
    return db.query(TaxMarketAvailabilityVersion).filter(
        TaxMarketAvailabilityVersion.jurisdiction_id == jurisdiction_id,
        TaxMarketAvailabilityVersion.tax_type_id == tax_type_id,
        TaxMarketAvailabilityVersion.transaction_class == transaction_class,
        TaxMarketAvailabilityVersion.status == PlatformVersionStatus.ACTIVE,
    ).first()


class MarketAvailabilityService(_VersionWorkflow):
    model = TaxMarketAvailabilityVersion
    request_type = "tax_market_availability"
    entity_type = "TaxMarketAvailabilityVersion"

    def _timezone(self, row) -> Optional[str]:
        jurisdiction = self.db.get(TaxJurisdiction, row.jurisdiction_id)
        return jurisdiction.timezone if jurisdiction else None

    def _key_filter(self, row):
        m = TaxMarketAvailabilityVersion
        return (m.jurisdiction_id == row.jurisdiction_id) & (m.tax_type_id == row.tax_type_id) \
            & (m.transaction_class == row.transaction_class)

    def draft(self, *, actor_id: Optional[int], jurisdiction_id: int, tax_type_id: int,
              transaction_class: TransactionClass, mode: TaxOperatingMode, tenant_config_permitted: bool = False,
              gates: Optional[dict] = None, notes: Optional[str] = None) -> TaxMarketAvailabilityVersion:
        row = TaxMarketAvailabilityVersion(
            jurisdiction_id=jurisdiction_id, tax_type_id=tax_type_id, transaction_class=transaction_class,
            mode=mode, tenant_config_permitted=bool(tenant_config_permitted),
            gates=self._merge_gates(gates), notes=notes, created_by_user_id=actor_id, created_at=utcnow(),
            status=PlatformVersionStatus.PENDING_REVIEW,
        )
        self.db.add(row)
        self.db.flush()
        self._log(actor_id, PlatformAuditAction.CREATE, row, new_values=self.describe(row))
        return row

    def amend(self, *, actor_id: int, version_id: int, changes: dict) -> TaxMarketAvailabilityVersion:
        row = self.get(version_id)
        self._require_editable(row)
        allowed = {"mode", "tenant_config_permitted", "gates", "notes"}
        unknown = set(changes) - allowed
        if unknown:
            raise BadRequestException(f"Not editable: {', '.join(sorted(unknown))}")
        before = self.describe(row)
        for key, value in changes.items():
            setattr(row, key, self._merge_gates(value, row.gates) if key == "gates" else value)
        self._reset(row)
        self.db.flush()
        self._log(actor_id, PlatformAuditAction.UPDATE, row, old_values=before, new_values=self.describe(row))
        return row

    @staticmethod
    def _merge_gates(gates: Optional[dict], base: Optional[dict] = None) -> dict:
        merged = {k: dict(v) for k, v in (base or _gate_template()).items()}
        for name, entry in (gates or {}).items():
            merged.setdefault(str(name).upper(), {}).update(entry or {})
        return merged

    def errors(self, row: TaxMarketAvailabilityVersion) -> list[str]:
        errors: list[str] = []
        if self.db.get(TaxJurisdiction, row.jurisdiction_id) is None:
            errors.append("Unknown jurisdiction.")
        if self.db.get(TaxTypeDefinition, row.tax_type_id) is None:
            errors.append("Unknown tax type.")
        if row.mode not in PLATFORM_AVAILABILITY_MODES:
            errors.append(f"{row.mode.name} is not a platform availability mode.")

        gates = row.gates or {}
        expected = {g.name for g in MarketGate}
        if set(gates) != expected:
            errors.append(f"Gates must be exactly: {', '.join(sorted(expected))}.")
        statuses = {}
        for name in expected & set(gates):
            entry = gates[name] or {}
            try:
                status = GateStatus[str(entry.get("status", "")).upper()]
            except KeyError:
                errors.append(f"Gate {name} has an invalid status.")
                continue
            statuses[name] = status
            if status == GateStatus.PASSED and not (entry.get("evidence_ref") or "").strip():
                errors.append(f"Gate {name} is PASSED without an evidence reference.")
            if status == GateStatus.NOT_APPLICABLE and not (entry.get("notes") or "").strip():
                errors.append(f"Gate {name} is NOT_APPLICABLE without a note explaining why.")

        if row.mode in CALCULATING_MODES and statuses:
            for gate in MarketGate:
                status = statuses.get(gate.name)
                if gate in mandatory_gates(row.mode) and status != GateStatus.PASSED:
                    errors.append(f"A {row.mode.name} market requires gate {gate.name} PASSED (§13.2).")
                elif gate not in MANDATORY_GATES and status not in (GateStatus.PASSED, GateStatus.NOT_APPLICABLE):
                    errors.append(f"A calculating mode requires gate {gate.name} PASSED or NOT_APPLICABLE (§13.2).")

        if row.tenant_config_permitted:
            if row.mode in (TaxOperatingMode.SUSPENDED, TaxOperatingMode.UNSUPPORTED):
                errors.append("tenant_config_permitted cannot be set on a SUSPENDED or UNSUPPORTED market.")
            if statuses.get(MarketGate.LEGAL_AUTHORITY_AND_USAGE_RIGHTS.name) != GateStatus.PASSED:
                errors.append("tenant_config_permitted requires gate LEGAL_AUTHORITY_AND_USAGE_RIGHTS PASSED.")
        return errors

    def describe(self, row) -> dict:
        return {
            "id": row.id, "jurisdiction_id": row.jurisdiction_id, "tax_type_id": row.tax_type_id,
            "transaction_class": row.transaction_class.name, "mode": row.mode.name,
            "tenant_config_permitted": row.tenant_config_permitted, "gates": row.gates,
        }


# ── Tax-code taxonomy ────────────────────────────────────────────────────

class TaxCodeSetService(_VersionWorkflow):
    model = TaxCodeSetVersion
    request_type = "tax_code_set"
    entity_type = "TaxCodeSetVersion"

    def _key_filter(self, row):
        return TaxCodeSetVersion.code == row.code

    def draft(self, *, actor_id: Optional[int], code: str = "ZB-TC", notes: Optional[str] = None,
              copy_active: bool = True) -> TaxCodeSetVersion:
        code = (code or "").strip().upper()
        if not code:
            raise BadRequestException("A code-set name is required.")
        latest = self.db.query(func.max(TaxCodeSetVersion.version)).filter(TaxCodeSetVersion.code == code).scalar()
        row = TaxCodeSetVersion(code=code, version=(latest or 0) + 1, notes=notes, created_by_user_id=actor_id,
                                created_at=utcnow(), status=PlatformVersionStatus.PENDING_REVIEW)
        self.db.add(row)
        self.db.flush()
        active = active_code_set(self.db, code)
        if copy_active and active is not None:
            for c in active.codes:
                self.db.add(TaxCode(code_set_version_id=row.id, code=c.code, name=c.name, description=c.description,
                                    parent_code=c.parent_code, supply_category=c.supply_category,
                                    registry_product_scope=c.registry_product_scope))
            self.db.flush()
        self._log(actor_id, PlatformAuditAction.CREATE, row, new_values={"code": code, "version": row.version})
        return row

    def upsert_code(self, *, actor_id: int, version_id: int, code: str, name: str,
                    supply_category: SupplyCategory, description: Optional[str] = None,
                    parent_code: Optional[str] = None, registry_product_scope: str = "GENERAL") -> TaxCode:
        row = self.get(version_id)
        self._require_editable(row)
        code = (code or "").strip().upper()
        if not code or not (name or "").strip():
            raise BadRequestException("A tax code needs a code and a name.")
        existing = self.db.query(TaxCode).filter(TaxCode.code_set_version_id == row.id, TaxCode.code == code).first()
        target = existing or TaxCode(code_set_version_id=row.id, code=code)
        target.code_set_version = row
        target.name = name.strip()
        target.description = description
        target.parent_code = (parent_code or "").strip().upper() or None
        target.supply_category = supply_category
        target.registry_product_scope = (registry_product_scope or "GENERAL").strip().upper()
        if existing is None:
            self.db.add(target)
        self._reset(row)
        self.db.flush()
        self._log(actor_id, PlatformAuditAction.UPDATE, row, new_values={"code": code, "name": target.name})
        return target

    def remove_code(self, *, actor_id: int, version_id: int, code: str) -> None:
        row = self.get(version_id)
        self._require_editable(row)
        target = self.db.query(TaxCode).filter(TaxCode.code_set_version_id == row.id,
                                               TaxCode.code == (code or "").strip().upper()).first()
        if target is None:
            raise NotFoundException("Tax code", code)
        self.db.delete(target)
        self._reset(row)
        self.db.flush()
        self._log(actor_id, PlatformAuditAction.UPDATE, row, old_values={"removed_code": target.code})

    def errors(self, row: TaxCodeSetVersion) -> list[str]:
        codes = self.db.query(TaxCode).filter(TaxCode.code_set_version_id == row.id).all()
        if not codes:
            return ["A code-set version needs at least one tax code."]
        known = {c.code for c in codes}
        return [f"Tax code {c.code} has unknown parent {c.parent_code}." for c in codes
                if c.parent_code and c.parent_code not in known]

    def describe(self, row) -> dict:
        return {"id": row.id, "code": row.code, "version": row.version,
                "codes": sorted(c.code for c in self.db.query(TaxCode).filter(TaxCode.code_set_version_id == row.id))}


# ── Native rule packs (Phase 3b) ─────────────────────────────────────────

def source_dependency_status(db: Session, handoff_ref: str) -> dict:
    """A source-register entry and whether it is approved: evidence captured
    (server-hashed artifact) and reviewed by a named person."""
    source = (db.query(TaxLegalSourceRevision).filter(TaxLegalSourceRevision.handoff_ref == handoff_ref)
              .order_by(TaxLegalSourceRevision.id.desc()).first())
    if source is None:
        return {"handoff_ref": handoff_ref, "source_id": None, "title": None, "approved": False,
                "reason": "not in the source register"}
    revoked = source.redistribution_permission is not None and source.redistribution_permission.name == "DENIED"
    approved = (not revoked and source.evidence_status is not None and source.evidence_status.name == "CAPTURED"
                and source.reviewer_user_id is not None and source.reviewed_at is not None)
    reason = None if approved else ("usage rights revoked (redistribution DENIED)" if revoked
                                    else "evidence not captured and reviewed")
    return {"handoff_ref": handoff_ref, "source_id": source.id, "title": source.title, "approved": approved,
            "reason": reason}


class RulePackService(_VersionWorkflow):
    """Two-person review of a native pack (§09.2): a TAX_REVIEWER registers
    the coded pack (its declarations are copied, not typed), attaches the
    golden-test report and submits; a different TAX_PUBLISHER approves and
    publishes. The author or submitter can never approve or publish. Every
    step is in the platform audit log. Until published the pack is a draft
    and the engine resolver ignores it."""
    model = TaxRulePackVersion
    request_type = "tax_rule_pack"
    entity_type = "TaxRulePackVersion"

    def _before_approve(self, row) -> None:
        from app.modules.tax.regression.runner import require_current

        require_current(self.db, "rule_pack", row.id)       # Phase 7 PR 2: current regression report

    def _key_filter(self, row):
        return TaxRulePackVersion.code == row.code

    @staticmethod
    def catalogue() -> dict:
        from app.modules.tax.engines import registered_rule_packs

        return {code: cls for code, cls in registered_rule_packs().items() if hasattr(cls, "declaration")}

    def register(self, *, actor_id: Optional[int], code: str, notes: Optional[str] = None,
                 valid_from=None, version: Optional[str] = None) -> TaxRulePackVersion:
        """Register the newest version of the pack in code, or (Phase 8 PR 2,
        several versions ship side by side) the exact version given."""
        code = (code or "").strip().upper()
        pack = rule_pack_class(code, str(version).strip()) if version else self.catalogue().get(code)
        if pack is None or not hasattr(pack, "declaration"):
            raise BadRequestException(f"No native rule pack {code!r}{f' version {version}' if version else ''} "
                                      "is registered in code.")
        declared = pack.declaration()
        existing = self.db.query(TaxRulePackVersion).filter(TaxRulePackVersion.code == pack.code,
                                                            TaxRulePackVersion.version == pack.version).first()
        if existing is not None:
            raise RegistryStateError(f"{pack.code} version {pack.version} is already registered (id {existing.id}).")
        row = TaxRulePackVersion(
            code=pack.code, version=pack.version, markets=declared["markets"],
            rounding_rule=declared["rounding_rule"], rounding_mode=declared["rounding_mode"],
            required_facts=declared["required_facts"], coverage=declared["coverage"],
            source_dependencies=[source_dependency_status(self.db, ref) for ref in pack.source_refs],
            notes=notes, created_by_user_id=actor_id, created_at=utcnow(), status=PlatformVersionStatus.PENDING_REVIEW,
            code_hash=code_hash(pack), valid_from=valid_from,
        )
        if row.code_hash is None:
            raise BadRequestException(f"The source of {pack.code} could not be read to compute its code hash.")
        self.db.add(row)
        self.db.flush()
        self._log(actor_id, PlatformAuditAction.CREATE, row, new_values=self.describe(row))
        return row

    def amend(self, *, actor_id: int, version_id: int, changes: dict) -> TaxRulePackVersion:
        row = self.get(version_id)
        self._require_editable(row)
        unknown = set(changes) - {"golden_test_report", "notes", "valid_from"}
        if unknown:
            raise BadRequestException(f"Not editable: {', '.join(sorted(unknown))}")
        before = self.describe(row)
        for key, value in changes.items():
            setattr(row, key, value)
        # Each edit re-records the current approval state of the sources.
        pack = rule_pack_class(row.code, row.version)
        if pack is not None:
            row.source_dependencies = [source_dependency_status(self.db, ref) for ref in pack.source_refs]
            self._fill_hash(row, pack)
        self._reset(row)
        self.db.flush()
        self._log(actor_id, PlatformAuditAction.UPDATE, row, old_values=before, new_values=self.describe(row))
        return row

    @staticmethod
    def _fill_hash(row: TaxRulePackVersion, pack) -> None:
        """A draft registered before Phase 8 gets its code hash on its next
        edit or validation; a recorded hash is never replaced."""
        if row.code_hash is None and row.status in EDITABLE_PLATFORM_STATUSES:
            row.code_hash = code_hash(pack)

    def validate(self, *, actor_id: Optional[int], version_id: int):
        row = self.get(version_id)
        pack = rule_pack_class(row.code, row.version)
        if pack is not None:
            self._fill_hash(row, pack)
        return super().validate(actor_id=actor_id, version_id=version_id)

    def errors(self, row: TaxRulePackVersion) -> list[str]:
        errors: list[str] = []
        from app.modules.tax.policy_models import code_version_of

        pack = rule_pack_class(row.code, code_version_of(row))
        if pack is None:
            return [f"{row.code} version {code_version_of(row)} is not the pack registered in code."]
        running = code_hash(pack)
        if not row.code_hash:
            errors.append("This version has no code hash; validate it again or register a new version.")
        elif running != row.code_hash:
            errors.append("The pack's code changed since this version was registered (code hash differs); "
                          "register a new pack version.")
        declared = pack.declaration()
        for key in ("markets", "rounding_rule", "rounding_mode", "required_facts", "coverage"):
            if getattr(row, key) != declared[key]:
                errors.append(f"The recorded {key} no longer matches the pack's code; register a new version.")
        if not declared["rounding_mode"]:
            errors.append("The pack does not declare a rounding mode.")
        for ref in pack.source_refs:
            status = source_dependency_status(self.db, ref)
            if not status["approved"]:
                errors.append(f"Source {ref} is not approved: {status['reason']}.")
        report = row.golden_test_report or {}
        if not isinstance(report, dict) or not report:
            errors.append("Attach the golden-test report before submitting.")
        else:
            if not str(report.get("commit") or "").strip():
                errors.append("The golden-test report must name the commit it ran against.")
            if int(report.get("passed") or 0) <= 0 or int(report.get("failed") or 0) != 0:
                errors.append("The golden-test report must show passing tests and no failures.")
        return errors

    def describe(self, row) -> dict:
        return {"id": row.id, "code": row.code, "version": row.version, "markets": row.markets,
                "rounding_rule": row.rounding_rule, "rounding_mode": row.rounding_mode,
                "required_facts": row.required_facts, "coverage": row.coverage,
                "source_dependencies": row.source_dependencies, "golden_test_report": row.golden_test_report,
                "code_hash": row.code_hash, "valid_from": row.valid_from.isoformat() if row.valid_from else None}

    # ── Phase 8 PR 2: effective-dated versions ──
    def current_for(self, row):
        """The open-ended ACTIVE version of the same pack (the one a new
        version follows); closed earlier versions stay in force for their
        dates."""
        return self.db.query(TaxRulePackVersion).filter(
            TaxRulePackVersion.code == row.code, TaxRulePackVersion.status == PlatformVersionStatus.ACTIVE,
            TaxRulePackVersion.valid_to.is_(None), TaxRulePackVersion.id != row.id,
        ).first()

    def _timezone(self, row) -> Optional[str]:
        zones = set()
        for market in row.markets or []:
            jurisdiction = self.db.query(TaxJurisdiction).filter(
                TaxJurisdiction.code == market.get("jurisdiction_code")).first()
            zones.add(jurisdiction.timezone if jurisdiction else None)
        return next(iter(zones)) if len(zones) == 1 and None not in zones else None

    def _before_activate(self, row, when: datetime, tz: Optional[str]) -> None:
        from app.modules.tax.activation import local_midnight_utc

        self._retention_check(row)
        pred = self.current_for(row)
        replacing = pred is not None and pred.valid_from == row.valid_from
        if pred is not None and not replacing and pred.valid_from is not None and (
                row.valid_from is None or row.valid_from < pred.valid_from):
            raise RegistryStateError(
                f"{row.code} v{row.version} would start before v{pred.version} (in force from {pred.valid_from}); "
                "a pack version must start on or after the version it follows.")
        others = self.db.query(TaxRulePackVersion).filter(
            TaxRulePackVersion.code == row.code, TaxRulePackVersion.status == PlatformVersionStatus.ACTIVE,
            TaxRulePackVersion.id != row.id).all()
        for other in others:
            if other is pred:
                continue                                    # closed (or superseded) by this activation
            if _overlaps(row.valid_from, None, other.valid_from, other.valid_to):
                raise RegistryStateError(
                    f"{row.code} v{row.version} would overlap v{other.version} "
                    f"({other.valid_from or 'the start'} to {other.valid_to or 'open-ended'}).")
        if row.valid_from is not None and not replacing:
            if not tz:
                raise BadRequestException("This pack's jurisdiction spans several time zones: choose the time zone "
                                          "that governs its start date.")
            start = local_midnight_utc(row.valid_from, tz)
            if when > start:
                # Phase 8 PR 4: retroactive only with a current analysis
                # preview, and only published now (never scheduled).
                if when > utcnow():
                    raise RegistryStateError(
                        f"{row.code} v{row.version} would be retroactive; a retroactive version can't be scheduled. "
                        "Publish it now, with a current retroactive analysis preview.")
                from app.modules.tax import retro_service

                retro_service.require_current_preview(self.db, "rule_pack", row.id)

    def _retention_check(self, row) -> None:
        """Phase 8 PR 3: only a version listed in the retention manifest with
        its hash may be published (so its code keeps shipping)."""
        from app.modules.tax.policy_models import code_version_of
        from app.modules.tax.rule_pack_retention import publish_problem

        problem = publish_problem(row.code, code_version_of(row), row.code_hash)
        if problem:
            raise RegistryStateError(problem)

    def _is_retroactive(self, row, when: datetime) -> bool:
        from app.modules.tax.activation import local_midnight_utc

        pred = self.current_for(row)
        if row.valid_from is None or (pred is not None and pred.valid_from == row.valid_from):
            return False
        tz = (getattr(row, "activate_tz", None) or self._timezone(row))
        return bool(tz) and when > local_midnight_utc(row.valid_from, tz)

    def _activate(self, row, actor_id, now: datetime, scheduled: bool = False):
        retroactive = self._is_retroactive(row, now)
        row = super()._activate(row, actor_id, now, scheduled)
        if retroactive:                                     # Phase 8 PR 4: the full per-tenant analysis
            from app.modules.tax import retro_service

            retro_service.enqueue(self.db, retro_service.pack_trigger(self.db, row, now), actor_id)
        return row

    def _close_predecessor(self, row, now: datetime) -> None:
        pred = self.current_for(row)
        if pred is None:
            return
        if pred.valid_from == row.valid_from:
            pred.status = PlatformVersionStatus.SUPERSEDED     # same start: a full replacement
            pred.superseded_at = now
        else:
            pred.valid_to = row.valid_from                     # the predecessor stays in force before it
        self.db.flush()
        row.predecessor_id = pred.id


def _overlaps(a_from, a_to, b_from, b_to) -> bool:
    """[a_from, a_to) and [b_from, b_to) share a day (None = unbounded)."""
    return (a_from is None or b_to is None or a_from < b_to) and (b_from is None or a_to is None or b_from < a_to)


def _schedule_view(row) -> dict:
    """Phase 8 PR 2 fields shared by the pack and availability views."""
    db = object_session(row)
    pending = None
    if db is not None and row.id is not None:
        kind = "rule_pack" if isinstance(row, TaxRulePackVersion) else "market_availability"
        c = db.query(TaxActivationCancellation).filter(
            TaxActivationCancellation.version_kind == kind, TaxActivationCancellation.version_id == row.id,
            TaxActivationCancellation.status == "PROPOSED").first()
        if c is not None:
            pending = view_cancellation(c)
    if db is None:
        default_tz = None
    elif isinstance(row, TaxRulePackVersion):
        default_tz = RulePackService(db)._timezone(row)
    else:
        default_tz = MarketAvailabilityService(db)._timezone(row)
    rollback = None
    if db is not None and row.id is not None:
        from app.modules.tax.policy_models import TaxRollbackRequest
        from app.modules.tax.rollback_service import view_rollback

        kind = "rule_pack" if isinstance(row, TaxRulePackVersion) else "market_availability"
        req = db.query(TaxRollbackRequest).filter(
            TaxRollbackRequest.kind == kind, TaxRollbackRequest.version_id == row.id,
            TaxRollbackRequest.status.in_(["PROPOSED", "APPROVED"])).order_by(TaxRollbackRequest.id.desc()).first()
        rollback = view_rollback(req) if req is not None else None
    return {"activate_at": row.activate_at, "activate_at_local": row.activate_at_local, "activate_tz": row.activate_tz,
            "scheduled_by_user_id": row.scheduled_by_user_id, "activation_error": row.activation_error,
            "pending_cancellation": pending, "default_timezone": default_tz,
            # Phase 8 PR 3: the open or applied rollback of this version, and
            # what a rollback version restores.
            "rollback": rollback, "restores_id": row.restores_id, "rollback_of_id": row.rollback_of_id}


def view_cancellation(c: TaxActivationCancellation) -> dict:
    return {"id": c.id, "version_kind": c.version_kind, "version_id": c.version_id, "reason": c.reason,
            "status": c.status, "proposed_by": c.proposed_by, "decided_by": c.decided_by, "decided_at": c.decided_at,
            "decision_reason": c.decision_reason, "created_at": c.created_at}


def view_rule_pack(row: TaxRulePackVersion) -> dict:
    from app.modules.tax.rule_pack_integrity import integrity_of

    return {
        **integrity_of(row),
        **_schedule_view(row),
        "valid_from": row.valid_from, "valid_to": row.valid_to, "code_version": row.code_version,
        "id": row.id, "code": row.code, "version": row.version, "markets": row.markets,
        "rounding_rule": row.rounding_rule, "rounding_mode": row.rounding_mode,
        "required_facts": row.required_facts, "coverage": row.coverage,
        "source_dependencies": row.source_dependencies, "golden_test_report": row.golden_test_report,
        "notes": row.notes, "status": row.status.name, "validation_errors": row.validation_errors,
        "predecessor_id": row.predecessor_id, "approval_request_id": row.approval_request_id,
        "created_by_user_id": row.created_by_user_id, "maker_user_id": row.maker_user_id,
        "checker_user_id": row.checker_user_id, "publisher_user_id": row.publisher_user_id,
        "created_at": row.created_at, "submitted_at": row.submitted_at, "approved_at": row.approved_at,
        "published_at": row.published_at, "superseded_at": row.superseded_at,
        "rejection_reason": row.rejection_reason,
    }


def active_code_set(db: Session, code: str = "ZB-TC") -> Optional[TaxCodeSetVersion]:
    return db.query(TaxCodeSetVersion).filter(
        TaxCodeSetVersion.code == code, TaxCodeSetVersion.status == PlatformVersionStatus.ACTIVE,
    ).first()


#: What each published mode means to Sales, Support and tenants (§15: a
#: capability registry with supported / limited / unsupported states).
COVERAGE_STATES = {
    TaxOperatingMode.NATIVE_RULEPACK_APPROVED: ("SUPPORTED", "Calculated by Zoiko's approved rule pack."),
    TaxOperatingMode.PROVIDER_APPROVED: ("SUPPORTED", "Calculated through the contracted tax provider."),
    TaxOperatingMode.TENANT_CONFIG_APPROVED: ("LIMITED", "Calculated from the tenant's own approved rate; "
                                                         "the tenant is responsible for it."),
    TaxOperatingMode.REFERENCE_ONLY: ("LIMITED", "Reference information only; tax is not calculated."),
    TaxOperatingMode.SUSPENDED: ("UNSUPPORTED", "Temporarily suspended; tax is not calculated."),
    TaxOperatingMode.UNSUPPORTED: ("UNSUPPORTED", "Not supported; tax is not calculated."),
}
COVERAGE_STATEMENT = ("Coverage is listed per jurisdiction, tax type and transaction class. Anything not listed is "
                      "UNSUPPORTED. Zoiko Billing does not claim global tax compliance; a tenant's own "
                      "registrations and approvals are still required.")


def coverage(db: Session) -> list:
    """Published market availability only (launch gate 07): no drafts, no
    gate evidence, no tenant data."""
    rows = db.query(TaxMarketAvailabilityVersion).filter(
        TaxMarketAvailabilityVersion.status == PlatformVersionStatus.ACTIVE).all()
    out = []
    for r in rows:
        state, meaning = COVERAGE_STATES.get(r.mode, ("UNSUPPORTED", "Not supported; tax is not calculated."))
        out.append({
            "jurisdiction_code": r.jurisdiction.code if r.jurisdiction else None,
            "jurisdiction_name": r.jurisdiction.name if r.jurisdiction else None,
            "tax_type": r.tax_type.code if r.tax_type else None,
            "transaction_class": r.transaction_class.name, "mode": r.mode.name, "state": state,
            "meaning": meaning, "published_at": r.published_at,
        })
    return sorted(out, key=lambda c: (c["jurisdiction_code"] or "", c["tax_type"] or "", c["transaction_class"]))


def view_availability(row: TaxMarketAvailabilityVersion) -> dict:
    return {
        **_schedule_view(row),
        "id": row.id,
        "jurisdiction_id": row.jurisdiction_id,
        "jurisdiction_code": row.jurisdiction.code if row.jurisdiction else None,
        "tax_type_id": row.tax_type_id,
        "tax_type": row.tax_type.code if row.tax_type else None,
        "transaction_class": row.transaction_class.name,
        "mode": row.mode.name,
        "tenant_config_permitted": row.tenant_config_permitted,
        "gates": row.gates,
        "notes": row.notes,
        "status": row.status.name,
        "validation_errors": row.validation_errors,
        "predecessor_id": row.predecessor_id,
        "approval_request_id": row.approval_request_id,
        "created_by_user_id": row.created_by_user_id,
        "maker_user_id": row.maker_user_id,
        "checker_user_id": row.checker_user_id,
        "publisher_user_id": row.publisher_user_id,
        "created_at": row.created_at,
        "submitted_at": row.submitted_at,
        "approved_at": row.approved_at,
        "published_at": row.published_at,
        "superseded_at": row.superseded_at,
        "rejection_reason": row.rejection_reason,
    }


def view_code_set(db: Session, row: TaxCodeSetVersion) -> dict:
    return {
        "id": row.id, "code": row.code, "version": row.version, "notes": row.notes, "status": row.status.name,
        "validation_errors": row.validation_errors, "predecessor_id": row.predecessor_id,
        "approval_request_id": row.approval_request_id, "maker_user_id": row.maker_user_id,
        "checker_user_id": row.checker_user_id, "publisher_user_id": row.publisher_user_id,
        "created_at": row.created_at, "published_at": row.published_at, "superseded_at": row.superseded_at,
        "codes": [view_tax_code(c) for c in db.query(TaxCode).filter(TaxCode.code_set_version_id == row.id)
                  .order_by(TaxCode.code)],
    }


def view_tax_code(c: TaxCode) -> dict:
    return {"id": c.id, "code": c.code, "name": c.name, "description": c.description,
            "parent_code": c.parent_code, "supply_category": c.supply_category.name,
            "registry_product_scope": c.registry_product_scope}


# ── Phase 8 PR 2: cancelling a scheduled activation (two people, MFA) ───

CANCEL_KINDS = {"rule_pack": RulePackService, "market_availability": MarketAvailabilityService}


class ActivationCancellationService:
    """A TAX_PUBLISHER (or the TAX_REVIEWER who submitted the version)
    proposes with a reason; a different TAX_PUBLISHER approves with MFA
    step-up (enforced at the route). Approving returns the version to
    APPROVED, so it can be published or scheduled again. Once a version is
    ACTIVE, only emergency rollback (PR 3) reverts it."""

    def __init__(self, db: Session):
        self.db = db

    def _version_service(self, kind: str):
        svc_cls = CANCEL_KINDS.get(kind)
        if svc_cls is None:
            raise BadRequestException(f"Unknown version kind {kind!r}.")
        return svc_cls(self.db)

    def get(self, cancellation_id: int) -> TaxActivationCancellation:
        row = self.db.get(TaxActivationCancellation, cancellation_id)
        if row is None:
            raise NotFoundException("Activation cancellation", cancellation_id)
        return row

    def pending_for(self, kind: str, version_id: int) -> Optional[TaxActivationCancellation]:
        return self.db.query(TaxActivationCancellation).filter(
            TaxActivationCancellation.version_kind == kind, TaxActivationCancellation.version_id == version_id,
            TaxActivationCancellation.status == "PROPOSED").first()

    def propose(self, *, actor, kind: str, version_id: int, reason: str) -> TaxActivationCancellation:
        if not (reason or "").strip():
            raise BadRequestException("A reason is required.")
        svc = self._version_service(kind)
        row = svc.get(version_id)
        if row.status != PlatformVersionStatus.SCHEDULED:
            raise RegistryStateError(f"{svc.entity_type} {row.id} is {row.status.name}; only a scheduled activation "
                                     "can be cancelled.")
        publisher = has_capability(actor, "tax_registry.approve")
        submitter = has_capability(actor, "tax_registry.write") and actor.id == row.maker_user_id
        if not (publisher or submitter):
            raise ForbiddenException("A TAX_PUBLISHER, or the reviewer who submitted this version, can propose "
                                     "cancelling its activation.")
        if self.pending_for(kind, row.id) is not None:
            raise RegistryStateError("A cancellation of this activation is already waiting for a decision.")
        c = TaxActivationCancellation(version_kind=kind, version_id=row.id, reason=reason.strip(), status="PROPOSED",
                                      proposed_by=actor.id, created_at=utcnow())
        self.db.add(c)
        self.db.flush()
        svc._log(actor.id, PlatformAuditAction.UPDATE, row, reason=reason.strip(),
                 metadata={"activation_cancel": "proposed", "cancellation_id": c.id})
        return c

    def decide(self, *, actor_id: int, cancellation_id: int, approve: bool,
               reason: Optional[str] = None) -> TaxActivationCancellation:
        c = self.get(cancellation_id)
        if c.status != "PROPOSED":
            raise RegistryStateError(f"Activation cancellation {c.id} is already {c.status}.")
        if actor_id == c.proposed_by:
            raise MakerCheckerError("You proposed this cancellation; a different TAX_PUBLISHER must decide it.")
        svc = self._version_service(c.version_kind)
        row = svc.get(c.version_id)
        reason = (reason or "").strip() or None
        if not approve:
            if not reason:
                raise BadRequestException("A reason is required to reject a cancellation.")
            c.status = "REJECTED"
        else:
            if row.status != PlatformVersionStatus.SCHEDULED:
                raise RegistryStateError(f"{svc.entity_type} {row.id} is already {row.status.name}, so its activation "
                                         "can't be cancelled; an active version is reverted by emergency rollback.")
            row.status = PlatformVersionStatus.APPROVED
            row.activate_at = row.activate_at_local = row.activate_tz = None
            row.scheduled_by_user_id = None
            row.activation_error = None
            c.status = "APPROVED"
        c.decided_by, c.decided_at, c.decision_reason = actor_id, utcnow(), reason
        self.db.flush()
        svc._log(actor_id, PlatformAuditAction.UPDATE, row, reason=reason,
                 metadata={"activation_cancel": c.status.lower(), "cancellation_id": c.id})
        return c

