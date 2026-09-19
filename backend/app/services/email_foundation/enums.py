"""
email_foundation/enums.py
-------------------------
Enums for the Zoiko Billing Email System foundation infrastructure.
"""

from enum import Enum


class TemplateTier(str, Enum):
    T0 = "T0"  # Critical System / Security / Legal / Transactional (Mandatory)
    T1 = "T1"  # Transactional Billing & Core Notifications (Mandatory)
    T2 = "T2"  # Collection, Account Lifecycle & Dunning
    T3 = "T3"  # Product Updates, Informational & Value Add
    T4 = "T4"  # Marketing & Promotional


class ActivationState(str, Enum):
    DRAFT = "draft"
    ACTIVE = "active"
    RETIRED = "retired"
    STUB = "stub"  # registered for catalog completeness; trigger event not yet in codebase


class SendStatus(str, Enum):
    QUEUED = "QUEUED"
    SENT = "SENT"
    SUPPRESSED = "SUPPRESSED"
    FAILED = "FAILED"
    DUPLICATE = "DUPLICATE"
    SUPERSEDED = "SUPERSEDED"


class SuppressionReason(str, Enum):
    BOUNCE = "BOUNCE"
    COMPLAINT = "COMPLAINT"
    LEGAL_HOLD = "LEGAL_HOLD"
    ORG_PREFERENCE = "ORG_PREFERENCE"
    NO_MARKETING_CONSENT = "NO_MARKETING_CONSENT"
    OPT_OUT = "OPT_OUT"
