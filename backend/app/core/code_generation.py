"""
core/code_generation.py
-----------------------
Organization code generation for the standalone billing platform.

References the platform's OWN Organization model (modules/organizations),
never app.modules.hr.models.
"""

import re

from sqlalchemy.orm import Session


def derive_organization_code(name: str) -> str:
    """Derive 2-letter org code from org name (same rules as main platform)."""
    alpha_only = re.sub(r"[^A-Za-z]", "", name or "")
    if len(alpha_only) >= 2:
        return alpha_only[:2].upper()
    if len(alpha_only) == 1:
        return (alpha_only + "X").upper()
    return "OR"


def generate_organization_code(name: str, db: Session) -> str:
    """Generate a 2-letter organization code from name, deduplicated."""
    from app.modules.organizations.models import Organization

    base_code = derive_organization_code(name)
    code = base_code
    suffix = 1
    while db.query(Organization).filter(Organization.organization_code == code).first():
        code = f"{base_code}{suffix}"
        suffix += 1
    return code
