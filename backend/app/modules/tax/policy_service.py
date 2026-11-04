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
from typing import Optional

from sqlalchemy import event, func, inspect
from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException, NotFoundException
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
    TaxCode,
    TaxCodeSetVersion,
    TaxMarketAvailabilityVersion,
)
from app.modules.tax.registry_models import TaxJurisdiction, TaxTypeDefinition
from app.modules.tax.registry_service import MakerCheckerError, RegistryImmutabilityError, RegistryStateError, utcnow

logger = logging.getLogger("zoiko_billing.tax.policy")

#: Gates that can never be waived as NOT_APPLICABLE for a calculating mode.
MANDATORY_GATES = frozenset({
    MarketGate.LEGAL_AUTHORITY_AND_USAGE_RIGHTS,
    MarketGate.SOURCE_PROVENANCE_AND_FRESHNESS,
    MarketGate.GOLDEN_TESTS_SIGNED_OFF,
})


# ── ORM guard: content frozen once submitted; ACTIVE only -> SUPERSEDED ──

_CONTENT = {TaxMarketAvailabilityVersion: AVAILABILITY_CONTENT_FIELDS, TaxCodeSetVersion: CODE_SET_CONTENT_FIELDS}


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
            if old_status == PlatformVersionStatus.SUPERSEDED and changed:
                raise RegistryImmutabilityError(f"{type(obj).__name__} {obj.id} is superseded and immutable.")
            if old_status == PlatformVersionStatus.ACTIVE and changed - {"status", "superseded_at"}:
                raise RegistryImmutabilityError(f"{type(obj).__name__} {obj.id} is active: it can only be superseded.")
        elif isinstance(obj, TaxCode) and obj.code_set_version.status not in EDITABLE_PLATFORM_STATUSES:
            raise RegistryImmutabilityError("Tax codes of a submitted code-set version are frozen.")
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

    def publish(self, *, actor_id: int, version_id: int):
        row = self.get(version_id)
        if row.status != PlatformVersionStatus.APPROVED:
            raise RegistryStateError(f"{self.entity_type} {row.id} is {row.status.name}, not APPROVED.")
        self._assert_not_maker(row, actor_id, "publish")
        errors = self.errors(row)
        if errors:
            raise RegistryStateError("Validation no longer passes: " + "; ".join(errors))
        now = utcnow()
        current = self.current_for(row)
        if current is not None:
            # Supersede first: the one-ACTIVE-per-key unique index is immediate.
            current.status = PlatformVersionStatus.SUPERSEDED
            current.superseded_at = now
            self.db.flush()
            row.predecessor_id = current.id
        row.status = PlatformVersionStatus.ACTIVE
        row.published_at = now
        row.publisher_user_id = actor_id
        self.db.flush()
        self._log(actor_id, PlatformAuditAction.UPDATE, row,
                  metadata={"published": True, "predecessor_id": row.predecessor_id})
        return row

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
                if gate in MANDATORY_GATES and status != GateStatus.PASSED:
                    errors.append(f"A calculating mode requires gate {gate.name} PASSED (§13.2).")
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


def active_code_set(db: Session, code: str = "ZB-TC") -> Optional[TaxCodeSetVersion]:
    return db.query(TaxCodeSetVersion).filter(
        TaxCodeSetVersion.code == code, TaxCodeSetVersion.status == PlatformVersionStatus.ACTIVE,
    ).first()


def view_availability(row: TaxMarketAvailabilityVersion) -> dict:
    return {
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
