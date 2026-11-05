"""
app/modules/tax/tenant_tax_service.py
-------------------------------------
Tenant-private obligations and activation (ZB-TAX-ARCH-001 Phase 2, §05,
§07, §13.2).

  * Registrations: recorded per seller entity, jurisdiction and tax type.
  * Legal bases: a structured, maker-checker-approved record for collecting
    without a registration.
  * Activations: seller entity × jurisdiction × tax type × transaction class
    -> calculating mode. A proposal by org_admin/billing_admin, approved by a
    different user (finance_approver). Approval requires the platform to
    have made that mode available for the market (or, for
    TENANT_CONFIG_APPROVED, the active availability version to set
    tenant_config_permitted), plus a registration or approved legal basis
    valid on the activation date.
  * Effective state is recomputed at use time (effective_state), so a platform
    SUSPENDED/UNSUPPORTED or an expired registration takes effect immediately.
  * Regime eligibility: GOVERNED stays refused until Phase 3; this reports
    whether the entity would qualify.

Every query is scoped by organization_id; another tenant's record is
indistinguishable from a missing one. Methods commit (Phase 0 convention).
"""
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Optional

from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException
from app.modules.billing.models import BillingAuditAction
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.tax.enums import (
    CALCULATING_MODES,
    TENANT_ACTIVATION_MODES,
    EntityTaxRegime,
    RegistrationStatus,
    TaxOperatingMode,
    TenantApprovalStatus,
    TransactionClass,
    VerificationStatus,
)
from app.modules.tax.models import (
    EntityTaxActivation,
    EntityTaxLegalBasis,
    EntityTaxRegistration,
    SellerLegalEntity,
)
from app.modules.tax.policy_service import current_availability
from app.modules.tax.registry_models import TaxJurisdiction, TaxTypeDefinition

TENANT_CONFIG_LABEL = "tenant-configured, not verified by Zoiko"
GOVERNED_NOT_QUALIFIED = (
    "This entity does not qualify for the governed tax regime yet: {reasons}. "
    "GET /api/v1/tax/legal-entities/{id}/regime-eligibility shows the details."
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _in_interval(day: date, start: Optional[date], end: Optional[date]) -> bool:
    return (start is None or start <= day) and (end is None or day < end)


def _name(value):
    return getattr(value, "name", value)


class TenantTaxService:
    def __init__(self, db: Session):
        self.db = db
        self.audit = BillingAuditService(db)

    # ── scoping helpers ──
    def _get(self, model, record_id: int, organization_id: int, label: str):
        row = self.db.query(model).filter(model.id == record_id, model.organization_id == organization_id).first()
        if row is None:
            raise NotFoundException(label, record_id)
        return row

    def _entity(self, entity_id: int, organization_id: int) -> SellerLegalEntity:
        entity = self.db.query(SellerLegalEntity).filter(
            SellerLegalEntity.id == entity_id, SellerLegalEntity.organization_id == organization_id,
        ).first()
        if entity is None:
            raise NotFoundException("Seller legal entity", entity_id)
        return entity

    def _scope_refs(self, jurisdiction_id: int, tax_type_id: int) -> None:
        if self.db.get(TaxJurisdiction, jurisdiction_id) is None:
            raise BadRequestException(f"Jurisdiction {jurisdiction_id} is not in the tax reference registry.")
        if self.db.get(TaxTypeDefinition, tax_type_id) is None:
            raise BadRequestException(f"Tax type {tax_type_id} is not in the tax reference registry.")

    def _log(self, organization_id, actor_id, action, entity_type, entity_id, **kw):
        self.audit.log_no_commit(organization_id, actor_id, action, entity_type, entity_id, **kw)

    @staticmethod
    def _assert_checker(proposer_id: Optional[int], approver_id: int) -> None:
        if proposer_id is not None and proposer_id == approver_id:
            raise ForbiddenException("You proposed this change; a different user must approve or reject it.")

    # ── registrations ──
    def list_registrations(self, organization_id: int, seller_entity_id: Optional[int] = None):
        q = self.db.query(EntityTaxRegistration).filter(EntityTaxRegistration.organization_id == organization_id)
        if seller_entity_id:
            q = q.filter(EntityTaxRegistration.seller_entity_id == seller_entity_id)
        return q.order_by(EntityTaxRegistration.id).all()

    def create_registration(self, organization_id: int, actor_id: int, *, seller_entity_id: int, jurisdiction_id: int,
                            tax_type_id: int, registration_number: str, valid_from: date,
                            valid_to: Optional[date] = None, status: RegistrationStatus = RegistrationStatus.ACTIVE,
                            evidence_ref: Optional[str] = None, notes: Optional[str] = None) -> EntityTaxRegistration:
        self._entity(seller_entity_id, organization_id)
        self._scope_refs(jurisdiction_id, tax_type_id)
        if not (registration_number or "").strip():
            raise BadRequestException("A registration number is required.")
        if valid_to is not None and valid_to <= valid_from:
            raise BadRequestException("valid_to must be after valid_from (the interval is end-exclusive).")
        row = EntityTaxRegistration(
            organization_id=organization_id, seller_entity_id=seller_entity_id, jurisdiction_id=jurisdiction_id,
            tax_type_id=tax_type_id, registration_number=registration_number.strip(), valid_from=valid_from,
            valid_to=valid_to, status=status, evidence_ref=evidence_ref, notes=notes,
            created_by=actor_id, created_at=_now(),
        )
        self.db.add(row)
        self.db.flush()
        self._log(organization_id, actor_id, BillingAuditAction.CREATE, "EntityTaxRegistration", row.id,
                  new_values={"jurisdiction_id": jurisdiction_id, "tax_type_id": tax_type_id,
                              "valid_from": valid_from.isoformat()})
        self.db.commit()
        return row

    def update_registration(self, organization_id: int, actor_id: int, registration_id: int, **changes):
        """Only the end of validity, status, verification facts and notes can be
        recorded after creation; key fields are immutable (new registration)."""
        row = self._get(EntityTaxRegistration, registration_id, organization_id, "Tax registration")
        allowed = {"valid_to", "status", "verification_status", "verification_method", "verification_response",
                   "verified_at", "verification_expires_at", "evidence_ref", "notes"}
        unknown = set(changes) - allowed
        if unknown:
            raise BadRequestException(f"Not editable: {', '.join(sorted(unknown))}. Record a new registration instead.")
        if "valid_to" in changes and changes["valid_to"] is not None and changes["valid_to"] <= row.valid_from:
            raise BadRequestException("valid_to must be after valid_from.")
        if changes.get("verification_status") == VerificationStatus.VERIFIED and not (
            changes.get("verification_method") or row.verification_method
        ):
            raise BadRequestException("A VERIFIED registration needs the verification method recorded.")
        before = {k: _name(getattr(row, k)) for k in changes}
        for key, value in changes.items():
            setattr(row, key, value)
        row.updated_by = actor_id
        row.updated_at = _now()
        self.db.flush()
        self._log(organization_id, actor_id, BillingAuditAction.UPDATE, "EntityTaxRegistration", row.id,
                  old_values=before, new_values={k: _name(v) for k, v in changes.items()})
        self.db.commit()
        return row

    @staticmethod
    def registration_valid_on(row: Optional[EntityTaxRegistration], day: date) -> list[str]:
        if row is None:
            return ["no registration"]
        problems = []
        if row.status != RegistrationStatus.ACTIVE:
            problems.append(f"registration {row.id} is {row.status.name}")
        if not _in_interval(day, row.valid_from, row.valid_to):
            problems.append(f"registration {row.id} is not valid on {day.isoformat()}")
        return problems

    # ── legal bases ──
    def list_legal_bases(self, organization_id: int):
        return self.db.query(EntityTaxLegalBasis).filter(
            EntityTaxLegalBasis.organization_id == organization_id).order_by(EntityTaxLegalBasis.id).all()

    def propose_legal_basis(self, organization_id: int, actor_id: int, *, seller_entity_id: int, jurisdiction_id: int,
                            tax_type_id: int, legal_basis: str, evidence_ref: str, valid_from: date,
                            valid_to: Optional[date] = None, supersedes_id: Optional[int] = None):
        self._entity(seller_entity_id, organization_id)
        self._scope_refs(jurisdiction_id, tax_type_id)
        if not (legal_basis or "").strip() or not (evidence_ref or "").strip():
            raise BadRequestException("A legal basis needs the basis text and an evidence reference.")
        if valid_to is not None and valid_to <= valid_from:
            raise BadRequestException("valid_to must be after valid_from.")
        if supersedes_id is not None:
            self._get(EntityTaxLegalBasis, supersedes_id, organization_id, "Legal basis")
        row = EntityTaxLegalBasis(
            organization_id=organization_id, seller_entity_id=seller_entity_id, jurisdiction_id=jurisdiction_id,
            tax_type_id=tax_type_id, legal_basis=legal_basis.strip(), evidence_ref=evidence_ref.strip(),
            valid_from=valid_from, valid_to=valid_to, predecessor_id=supersedes_id,
            status=TenantApprovalStatus.PROPOSED, recorded_by=actor_id, created_at=_now(),
        )
        self.db.add(row)
        self.db.flush()
        self._log(organization_id, actor_id, BillingAuditAction.CREATE, "EntityTaxLegalBasis", row.id)
        self.db.commit()
        return row

    def decide_legal_basis(self, organization_id: int, actor_id: int, basis_id: int, *, approve: bool,
                           reason: Optional[str] = None):
        row = self._get(EntityTaxLegalBasis, basis_id, organization_id, "Legal basis")
        if row.status != TenantApprovalStatus.PROPOSED:
            raise BadRequestException(f"Legal basis {row.id} is {row.status.name}, not PROPOSED.")
        self._assert_checker(row.recorded_by, actor_id)
        now = _now()
        if approve and row.predecessor_id:
            prior = self._get(EntityTaxLegalBasis, row.predecessor_id, organization_id, "Legal basis")
            if prior.status == TenantApprovalStatus.APPROVED:
                prior.status = TenantApprovalStatus.SUPERSEDED
                prior.superseded_at = now
        row.status = TenantApprovalStatus.APPROVED if approve else TenantApprovalStatus.REJECTED
        row.approved_by = actor_id
        row.approved_at = now
        row.decision_reason = reason
        self.db.flush()
        self._log(organization_id, actor_id, BillingAuditAction.APPROVE if approve else BillingAuditAction.REJECT,
                  "EntityTaxLegalBasis", row.id)
        self.db.commit()
        return row

    @staticmethod
    def legal_basis_valid_on(row: Optional[EntityTaxLegalBasis], day: date) -> list[str]:
        if row is None:
            return ["no legal basis"]
        problems = []
        if row.status != TenantApprovalStatus.APPROVED:
            problems.append(f"legal basis {row.id} is {row.status.name}")
        if not _in_interval(day, row.valid_from, row.valid_to):
            problems.append(f"legal basis {row.id} is not valid on {day.isoformat()}")
        return problems

    # ── activations ──
    def list_activations(self, organization_id: int, seller_entity_id: Optional[int] = None):
        q = self.db.query(EntityTaxActivation).filter(EntityTaxActivation.organization_id == organization_id)
        if seller_entity_id:
            q = q.filter(EntityTaxActivation.seller_entity_id == seller_entity_id)
        return q.order_by(EntityTaxActivation.id).all()

    def propose_activation(self, organization_id: int, actor_id: int, *, seller_entity_id: int, jurisdiction_id: int,
                           tax_type_id: int, transaction_class: TransactionClass, mode: TaxOperatingMode,
                           effective_from: date, effective_to: Optional[date] = None,
                           registration_id: Optional[int] = None, legal_basis_id: Optional[int] = None,
                           tenant_rate_percent: Optional[Decimal] = None, tenant_source_citation: Optional[str] = None,
                           tenant_source_url: Optional[str] = None,
                           provider_connection_id: Optional[int] = None) -> EntityTaxActivation:
        self._entity(seller_entity_id, organization_id)
        self._scope_refs(jurisdiction_id, tax_type_id)
        if mode not in TENANT_ACTIVATION_MODES:
            raise BadRequestException(f"{_name(mode)} is not an activatable mode; choose a calculating mode.")
        if effective_to is not None and effective_to <= effective_from:
            raise BadRequestException("effective_to must be after effective_from.")
        if (registration_id is None) == (legal_basis_id is None):
            raise BadRequestException("Reference exactly one: a registration, or an approved legal basis for "
                                      "collecting without one.")
        if registration_id is not None:
            self._get(EntityTaxRegistration, registration_id, organization_id, "Tax registration")
        if legal_basis_id is not None:
            self._get(EntityTaxLegalBasis, legal_basis_id, organization_id, "Legal basis")
        self._check_tenant_config_fields(mode, tenant_rate_percent, tenant_source_citation, tenant_source_url)
        if (mode == TaxOperatingMode.PROVIDER_APPROVED) != (provider_connection_id is not None):
            raise BadRequestException("A provider activation references exactly one provider connection; other "
                                      "modes reference none.")
        if provider_connection_id is not None:
            from app.modules.tax.provider_models import TaxProviderConnection

            connection = self._get(TaxProviderConnection, provider_connection_id, organization_id, "Provider connection")
            if connection.seller_entity_id != seller_entity_id:
                raise BadRequestException("The provider connection belongs to a different seller entity.")
        row = EntityTaxActivation(
            organization_id=organization_id, seller_entity_id=seller_entity_id, jurisdiction_id=jurisdiction_id,
            tax_type_id=tax_type_id, transaction_class=transaction_class, mode=mode, effective_from=effective_from,
            effective_to=effective_to, registration_id=registration_id, legal_basis_id=legal_basis_id,
            tenant_rate_percent=tenant_rate_percent, tenant_source_citation=tenant_source_citation,
            tenant_source_url=tenant_source_url, provider_connection_id=provider_connection_id,
            status=TenantApprovalStatus.PROPOSED, proposed_by=actor_id,
            created_at=_now(),
        )
        self.db.add(row)
        self.db.flush()
        self._log(organization_id, actor_id, BillingAuditAction.CREATE, "EntityTaxActivation", row.id,
                  new_values={"mode": mode.name, "transaction_class": transaction_class.name})
        self.db.commit()
        return row

    @staticmethod
    def _check_tenant_config_fields(mode, rate, citation, url) -> None:
        tenant_fields = (rate, citation, url)
        if mode != TaxOperatingMode.TENANT_CONFIG_APPROVED:
            if any(v is not None for v in tenant_fields):
                raise BadRequestException("Tenant rate fields are only allowed for TENANT_CONFIG_APPROVED.")
            return
        if rate is None or not (citation or "").strip() or not (url or "").strip().lower().startswith("https://"):
            raise BadRequestException("TENANT_CONFIG_APPROVED needs the tenant's rate, a citation of its own legal "
                                      "source and an https:// URL for it.")
        try:
            rate = Decimal(rate)
        except InvalidOperation:
            raise BadRequestException("tenant_rate_percent is not a decimal number.")
        if rate < 0 or rate >= 100 or rate != rate.quantize(Decimal("0.000001")):
            raise BadRequestException("tenant_rate_percent must be in [0, 100) with at most 6 decimals.")

    def approval_problems(self, row: EntityTaxActivation, on_date: Optional[date] = None) -> list[str]:
        """Why this activation can't be (or no longer is) in force. Empty list
        = OK. Used at approval and, with on_date, at use time."""
        day = on_date or row.effective_from
        problems: list[str] = []
        jurisdiction = self.db.get(TaxJurisdiction, row.jurisdiction_id)
        if jurisdiction is None or not jurisdiction.is_active:
            problems.append("jurisdiction is not active in the tax reference registry")
        availability = current_availability(self.db, row.jurisdiction_id, row.tax_type_id, row.transaction_class)
        if availability is None:
            problems.append("the platform has not made this market available")
        elif availability.mode in (TaxOperatingMode.SUSPENDED, TaxOperatingMode.UNSUPPORTED):
            problems.append(f"the platform has marked this market {availability.mode.name}")
        elif row.mode == TaxOperatingMode.TENANT_CONFIG_APPROVED:
            if not availability.tenant_config_permitted:
                problems.append("the platform does not permit tenant-configured rates for this market")
        elif availability.mode != row.mode:
            problems.append(f"the platform makes this market available as {availability.mode.name}, "
                            f"not {row.mode.name}")
        if row.registration_id is not None:
            problems += self.registration_valid_on(row.registration, day)
            reg = row.registration
            if reg is not None and (reg.seller_entity_id, reg.jurisdiction_id, reg.tax_type_id) != (
                row.seller_entity_id, row.jurisdiction_id, row.tax_type_id
            ):
                problems.append("the registration is for a different entity, jurisdiction or tax type")
        elif row.legal_basis_id is not None:
            problems += self.legal_basis_valid_on(row.legal_basis, day)
            basis = row.legal_basis
            if basis is not None and (basis.seller_entity_id, basis.jurisdiction_id, basis.tax_type_id) != (
                row.seller_entity_id, row.jurisdiction_id, row.tax_type_id
            ):
                problems.append("the legal basis is for a different entity, jurisdiction or tax type")
        else:
            problems.append("no registration or legal basis")
        if row.mode == TaxOperatingMode.PROVIDER_APPROVED:
            # The third approval of a provider market (with the platform's
            # availability and this activation): an approved, usable connection.
            from app.modules.tax.connection_service import ProviderConnectionService
            from app.modules.tax.provider_models import TaxProviderConnection

            connection = self.db.get(TaxProviderConnection, row.provider_connection_id) \
                if row.provider_connection_id else None
            problem = ProviderConnectionService(self.db).usable_problem(connection)
            if problem:
                problems.append(problem)
            elif connection.seller_entity_id != row.seller_entity_id:
                problems.append("the provider connection belongs to a different seller entity")
        return problems

    def decide_activation(self, organization_id: int, actor_id: int, activation_id: int, *, approve: bool,
                          reason: Optional[str] = None) -> EntityTaxActivation:
        row = self._get(EntityTaxActivation, activation_id, organization_id, "Tax activation")
        if row.status != TenantApprovalStatus.PROPOSED:
            raise BadRequestException(f"Activation {row.id} is {row.status.name}, not PROPOSED.")
        self._assert_checker(row.proposed_by, actor_id)
        now = _now()
        if approve:
            problems = self.approval_problems(row)
            if row.mode == TaxOperatingMode.PROVIDER_APPROVED:
                from app.modules.tax.pseudonym import key_fingerprint

                jurisdiction = self.db.get(TaxJurisdiction, row.jurisdiction_id)
                if jurisdiction is not None and jurisdiction.country_code == "US" and key_fingerprint() is None:
                    problems.append("TAX_PROVIDER_PSEUDONYM_KEY is not set (US provider markets send a "
                                    "pseudonymous customer reference)")
            if problems:
                raise BadRequestException("Activation cannot be approved: " + "; ".join(problems) + ".")
            availability = current_availability(self.db, row.jurisdiction_id, row.tax_type_id, row.transaction_class)
            prior = self.db.query(EntityTaxActivation).filter(
                EntityTaxActivation.organization_id == organization_id,
                EntityTaxActivation.seller_entity_id == row.seller_entity_id,
                EntityTaxActivation.jurisdiction_id == row.jurisdiction_id,
                EntityTaxActivation.tax_type_id == row.tax_type_id,
                EntityTaxActivation.transaction_class == row.transaction_class,
                EntityTaxActivation.status == TenantApprovalStatus.APPROVED,
            ).first()
            if prior is not None:
                prior.status = TenantApprovalStatus.SUPERSEDED
                prior.superseded_at = now
                self.db.flush()
                row.predecessor_id = prior.id
            row.availability_version_id = availability.id
            row.status = TenantApprovalStatus.APPROVED
        else:
            row.status = TenantApprovalStatus.REJECTED
        row.approved_by = actor_id
        row.approved_at = now
        row.decision_reason = reason
        self.db.flush()
        if approve and row.mode == TaxOperatingMode.PROVIDER_APPROVED:
            from app.modules.tax.pseudonym import PseudonymKeyService

            PseudonymKeyService(self.db).baseline_on_activation(organization_id, row)
        self._log(organization_id, actor_id, BillingAuditAction.APPROVE if approve else BillingAuditAction.REJECT,
                  "EntityTaxActivation", row.id, new_values={"status": row.status.name})
        self.db.commit()
        return row

    def withdraw(self, model, label: str, organization_id: int, actor_id: int, record_id: int):
        """The proposer (or any proposer-role user) withdraws an undecided proposal."""
        row = self._get(model, record_id, organization_id, label)
        if row.status != TenantApprovalStatus.PROPOSED:
            raise BadRequestException(f"{label} {row.id} is {row.status.name}; only proposals can be withdrawn.")
        row.status = TenantApprovalStatus.WITHDRAWN
        self.db.flush()
        self._log(organization_id, actor_id, BillingAuditAction.CANCEL, model.__name__, row.id)
        self.db.commit()
        return row

    def effective_state(self, row: EntityTaxActivation, on_date: date) -> dict:
        """Recomputed at use time from the current platform availability,
        the tenant activation and registration validity (no waiting for T14)."""
        reasons = []
        if row.status != TenantApprovalStatus.APPROVED:
            reasons.append(f"activation is {row.status.name}")
        if not _in_interval(on_date, row.effective_from, row.effective_to):
            reasons.append(f"activation is not in effect on {on_date.isoformat()}")
        reasons += self.approval_problems(row, on_date)
        availability = current_availability(self.db, row.jurisdiction_id, row.tax_type_id, row.transaction_class)
        return {
            "activation_id": row.id,
            "on_date": on_date,
            "effective": not reasons,
            "reasons": reasons,
            "mode": row.mode.name,
            "availability_version_id": availability.id if availability else None,
            "availability_mode": availability.mode.name if availability else None,
        }

    # ── GOVERNED regime (Phase 3b) ──
    def governed_backing_problem(self, activation: EntityTaxActivation) -> Optional[str]:
        """Why an activation cannot back GOVERNED, or None when it can: a
        native pack whose registry row is published (drafts never qualify),
        an approved positive tenant-configured rate, or a configured provider."""
        from app.modules.tax.engines import EngineResolver

        if activation.mode == TaxOperatingMode.TENANT_CONFIG_APPROVED:
            rate = activation.tenant_rate_percent
            return None if rate is not None and Decimal(rate) > 0 else "its tenant-configured rate is not positive"
        engine, reason = EngineResolver(self.db).engine_for(activation)
        return None if engine is not None else (reason or "no engine applies").rstrip(".")

    def regime_eligibility(self, organization_id: int, entity_id: int, on_date: Optional[date] = None) -> dict:
        entity = self._entity(entity_id, organization_id)
        day = on_date or _now().date()
        activations = self.db.query(EntityTaxActivation).filter(
            EntityTaxActivation.organization_id == organization_id,
            EntityTaxActivation.seller_entity_id == entity.id,
            EntityTaxActivation.status == TenantApprovalStatus.APPROVED,
        ).all()
        by_id = {a.id: a for a in activations}
        states = [self.effective_state(a, day) for a in activations if a.mode in CALCULATING_MODES]
        effective = [s for s in states if s["effective"]]
        problems = {s["activation_id"]: self.governed_backing_problem(by_id[s["activation_id"]]) for s in effective}
        backed = [i for i, p in problems.items() if p is None]
        unmet = []
        if not activations:
            unmet.append("no approved tax activation for this entity")
        elif not effective:
            unmet.append("no approved activation in a calculating mode is in effect")
            unmet += [f"activation {s['activation_id']}: {r}" for s in states for r in s["reasons"]]
        elif not backed:
            unmet.append("no effective activation is backed by a published rule pack, an approved tenant "
                         "configuration or a configured provider")
            unmet += [f"activation {i}: {p}" for i, p in problems.items() if p]
        if not entity.is_active:
            unmet.append("the entity is inactive")
        return {
            "entity_id": entity.id,
            "current_regime": entity.tax_regime.name,
            "evaluated_on": day,
            "would_qualify": not unmet,
            "governed_available": True,
            "unmet_conditions": unmet,
            "effective_activations": [s["activation_id"] for s in effective],
            "backing_activations": backed,
        }

    def propose_regime_change(self, organization_id: int, actor_id: int, entity_id: int, regime: EntityTaxRegime,
                              reason: Optional[str] = None):
        """A regime change in either direction is a proposal (product question
        6): a different finance approver decides it. GOVERNED is proposable
        only when the entity qualifies (T12); leaving GOVERNED never alters
        issued invoices or committed quotes."""
        from app.modules.tax.models import TaxRegimeChange

        entity = self._entity(entity_id, organization_id)
        if entity.tax_regime == regime:
            raise BadRequestException(f"The entity is already {regime.name}.")
        eligibility = self.regime_eligibility(organization_id, entity_id)
        if regime == EntityTaxRegime.GOVERNED and not eligibility["would_qualify"]:
            raise BadRequestException(GOVERNED_NOT_QUALIFIED.replace("{id}", str(entity_id))
                                      .replace("{reasons}", "; ".join(eligibility["unmet_conditions"])))
        open_change = self.db.query(TaxRegimeChange).filter(
            TaxRegimeChange.seller_entity_id == entity.id, TaxRegimeChange.status == TenantApprovalStatus.PROPOSED).first()
        if open_change is not None:
            raise BadRequestException(f"Regime change {open_change.id} is already awaiting a decision.")
        row = TaxRegimeChange(
            organization_id=organization_id, seller_entity_id=entity.id, from_regime=entity.tax_regime.name,
            to_regime=regime.name, reason=reason, eligibility=_jsonable(eligibility),
            status=TenantApprovalStatus.PROPOSED, proposed_by=actor_id, created_at=_now())
        self.db.add(row)
        self.db.flush()
        self._log(organization_id, actor_id, BillingAuditAction.CREATE, "TaxRegimeChange", row.id,
                  new_values={"from": row.from_regime, "to": row.to_regime})
        self.db.commit()
        return row

    def request_regime(self, organization_id: int, actor_id: int, entity_id: int, regime: EntityTaxRegime,
                       reason: Optional[str] = None):
        """POST /regime: records a proposal (see propose_regime_change)."""
        return self.propose_regime_change(organization_id, actor_id, entity_id, regime, reason)

    def decide_regime_change(self, organization_id: int, actor_id: int, change_id: int, *, approve: bool,
                             reason: Optional[str] = None):
        from app.modules.tax.models import TaxRegimeChange

        row = self._get(TaxRegimeChange, change_id, organization_id, "Regime change")
        if row.status != TenantApprovalStatus.PROPOSED:
            raise BadRequestException(f"Regime change {row.id} is {row.status.name}, not PROPOSED.")
        self._assert_checker(row.proposed_by, actor_id)
        entity = self._entity(row.seller_entity_id, organization_id)
        target = EntityTaxRegime[row.to_regime]
        if approve:
            if entity.tax_regime.name != row.from_regime:
                raise BadRequestException("The entity's regime changed since this proposal; propose again.")
            if target == EntityTaxRegime.GOVERNED:
                eligibility = self.regime_eligibility(organization_id, entity.id)
                if not eligibility["would_qualify"]:
                    raise BadRequestException(GOVERNED_NOT_QUALIFIED.replace("{id}", str(entity.id))
                                              .replace("{reasons}", "; ".join(eligibility["unmet_conditions"])))
            old = entity.tax_regime
            entity.tax_regime = target
            entity.version = (entity.version or 1) + 1          # open quotes go stale; issued records untouched
            entity.updated_by = actor_id
            self._log(organization_id, actor_id, BillingAuditAction.UPDATE, "SellerLegalEntity", entity.id,
                      old_values={"tax_regime": old.name},
                      new_values={"tax_regime": target.name, "regime_change_id": row.id})
        row.status = TenantApprovalStatus.APPROVED if approve else TenantApprovalStatus.REJECTED
        row.approved_by, row.approved_at, row.decision_reason = actor_id, _now(), reason
        self.db.flush()
        self._log(organization_id, actor_id, BillingAuditAction.APPROVE if approve else BillingAuditAction.REJECT,
                  "TaxRegimeChange", row.id, new_values={"status": row.status.name})
        self.db.commit()
        return row

    def list_regime_changes(self, organization_id: int, entity_id: Optional[int] = None) -> list:
        from app.modules.tax.models import TaxRegimeChange

        q = self.db.query(TaxRegimeChange).filter(TaxRegimeChange.organization_id == organization_id)
        if entity_id is not None:
            q = q.filter(TaxRegimeChange.seller_entity_id == entity_id)
        return q.order_by(TaxRegimeChange.id).all()


def _jsonable(value):
    import json

    return json.loads(json.dumps(value, default=str))


def view_regime_change(row) -> dict:
    return {
        "id": row.id, "seller_entity_id": row.seller_entity_id, "from_regime": row.from_regime,
        "to_regime": row.to_regime, "reason": row.reason, "status": row.status.name,
        "proposed_by": row.proposed_by, "approved_by": row.approved_by, "approved_at": row.approved_at,
        "decision_reason": row.decision_reason, "created_at": row.created_at,
        "eligibility_at_proposal": row.eligibility,
    }


def view_registration(row: EntityTaxRegistration) -> dict:
    return {
        "id": row.id, "seller_entity_id": row.seller_entity_id, "jurisdiction_id": row.jurisdiction_id,
        "jurisdiction_code": row.jurisdiction.code if row.jurisdiction else None,
        "tax_type": row.tax_type.code if row.tax_type else None, "tax_type_id": row.tax_type_id,
        "registration_number": row.registration_number, "valid_from": row.valid_from, "valid_to": row.valid_to,
        "status": row.status.name, "verification_status": row.verification_status.name,
        "verification_method": row.verification_method, "verified_at": row.verified_at,
        "verification_expires_at": row.verification_expires_at, "evidence_ref": row.evidence_ref,
        "notes": row.notes, "created_by": row.created_by, "created_at": row.created_at,
    }


def view_legal_basis(row: EntityTaxLegalBasis) -> dict:
    return {
        "id": row.id, "seller_entity_id": row.seller_entity_id, "jurisdiction_id": row.jurisdiction_id,
        "tax_type_id": row.tax_type_id, "legal_basis": row.legal_basis, "evidence_ref": row.evidence_ref,
        "valid_from": row.valid_from, "valid_to": row.valid_to, "status": row.status.name,
        "recorded_by": row.recorded_by, "approved_by": row.approved_by, "approved_at": row.approved_at,
        "decision_reason": row.decision_reason, "predecessor_id": row.predecessor_id,
    }


def view_activation(row: EntityTaxActivation) -> dict:
    tenant_config = row.mode == TaxOperatingMode.TENANT_CONFIG_APPROVED
    return {
        "id": row.id, "seller_entity_id": row.seller_entity_id, "jurisdiction_id": row.jurisdiction_id,
        "jurisdiction_code": row.jurisdiction.code if row.jurisdiction else None,
        "tax_type_id": row.tax_type_id, "tax_type": row.tax_type.code if row.tax_type else None,
        "transaction_class": row.transaction_class.name, "mode": row.mode.name,
        "effective_from": row.effective_from, "effective_to": row.effective_to,
        "registration_id": row.registration_id, "legal_basis_id": row.legal_basis_id,
        "availability_version_id": row.availability_version_id,
        "tenant_rate_percent": row.tenant_rate_percent, "tenant_source_citation": row.tenant_source_citation,
        "tenant_source_url": row.tenant_source_url,
        "provider_connection_id": row.provider_connection_id,
        # Every response for a tenant-configured activation carries the label.
        "verification_label": TENANT_CONFIG_LABEL if tenant_config else None,
        "status": row.status.name, "proposed_by": row.proposed_by, "approved_by": row.approved_by,
        "approved_at": row.approved_at, "decision_reason": row.decision_reason, "predecessor_id": row.predecessor_id,
        "created_at": row.created_at, "superseded_at": row.superseded_at,
    }
