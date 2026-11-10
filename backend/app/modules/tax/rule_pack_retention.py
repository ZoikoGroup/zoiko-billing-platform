"""
app/modules/tax/rule_pack_retention.py
--------------------------------------
Rule-pack code retention (ZB-TAX-ARCH-001 Phase 8 PR 3).

Packs are effective-dated and can be rolled back, so the code of every
version that may still decide a tax date, or be restored, must keep shipping.
CI can't see production, so a committed manifest
(``rule_packs/retention.json``) lists every published version with its code
hash:

  * CI (tests/test_tax_rule_pack_retention.py) fails if a listed, non-retired
    version's module is missing or its hash differs, and, with
    TAX_RETENTION_BASE_REQUIRED=1, if an entry on origin/main was removed;
  * publishing (and approving a rollback) refuses a version that is not in
    the manifest with a matching hash (TAX_RULE_PACK_RETENTION_REQUIRED);
  * at runtime, the startup and monitoring check (P1 tax.rule_pack_integrity)
    fails for any version that must ship but is missing or marked retired:
    every ACTIVE and ROLLED_BACK version, the most recent SUPERSEDED version
    of each pack, and the version whose code an ACTIVE or most-recent
    SUPERSEDED rollback version runs (code_version).

Entries are never deleted; a version that may stop shipping is marked
``"retired": "<reason, date>"``, which is only allowed once it is SUPERSEDED
and not the most recent of its pack (enforced by the runtime check).
"""
import json
import pathlib
from typing import Optional

from app.config import settings

MANIFEST_PATH = pathlib.Path(__file__).resolve().parent / "rule_packs" / "retention.json"


def load_manifest(text: Optional[str] = None) -> dict:
    data = json.loads(text) if text is not None else json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    versions = data.get("versions") or []
    return {(v["code"], str(v["version"])): v for v in versions}


def entry(code: str, version: str, manifest: Optional[dict] = None) -> Optional[dict]:
    return (manifest if manifest is not None else load_manifest()).get((code, str(version)))


def code_problems(manifest: Optional[dict] = None) -> list:
    """Listed, non-retired versions whose module is missing or whose hash differs."""
    from app.modules.tax.engines import rule_pack_class
    from app.modules.tax.rule_pack_integrity import compute_hash

    problems = []
    for (code, version), item in sorted((manifest if manifest is not None else load_manifest()).items()):
        if item.get("retired"):
            continue
        cls = rule_pack_class(code, version)
        if cls is None:
            problems.append(f"{code} v{version}: listed in retention.json but its module no longer ships")
        elif compute_hash(cls) != item.get("code_hash"):
            problems.append(f"{code} v{version}: the running code's hash differs from retention.json")
    return problems


def removed_entries(base: dict, current: dict) -> list:
    """Entries on the base branch that the current manifest dropped."""
    return [f"{code} v{version}" for (code, version) in sorted(set(base) - set(current))]


def publish_problem(code: str, version: str, code_hash: Optional[str]) -> Optional[str]:
    """Publish gate: the version must be listed, not retired, with its hash."""
    if not getattr(settings, "TAX_RULE_PACK_RETENTION_REQUIRED", True):
        return None
    item = entry(code, version)
    if item is None:
        return (f"{code} v{version} is not in rule_packs/retention.json; add it (with its code hash) in a reviewed "
                "change before publishing, so its code keeps shipping.")
    if item.get("retired"):
        return f"{code} v{version} is marked retired in rule_packs/retention.json."
    if item.get("code_hash") != code_hash:
        return f"{code} v{version}: the code hash in rule_packs/retention.json differs from the approved hash."
    return None


def must_ship(db) -> list:
    """(row, code_version) for every registry version whose code must ship."""
    from app.modules.tax.enums import PlatformVersionStatus as S
    from app.modules.tax.policy_models import TaxRulePackVersion, code_version_of

    rows = db.query(TaxRulePackVersion).filter(
        TaxRulePackVersion.status.in_([S.ACTIVE, S.ROLLED_BACK, S.SUPERSEDED])).order_by(TaxRulePackVersion.id).all()
    latest_superseded = {}
    for r in rows:
        if r.status == S.SUPERSEDED:
            latest_superseded[r.code] = r                    # ordered by id: the last one wins
    needed = [r for r in rows if r.status in (S.ACTIVE, S.ROLLED_BACK)] + list(latest_superseded.values())
    # Every row is reported on its own: an ACTIVE rollback version R and the
    # version P whose code it runs both need P's module.
    return [(r, code_version_of(r)) for r in needed]
