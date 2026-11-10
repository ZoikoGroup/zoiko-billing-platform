"""
app/modules/tax/rule_pack_integrity.py
--------------------------------------
Rule-pack integrity (ZB-TAX-ARCH-001 Phase 8 PR 1, handoff §10.1 step 07).

A native pack's *code hash* is a SHA-256 over:

  * the source of every module in the ``app.modules.tax.rule_packs`` package
    that defines a class in the pack's class hierarchy (the pack's own
    module and the shared logic it builds on), line endings normalised to LF
    so a Windows checkout hashes the same as Linux; and
  * the pack's declarations: markets, coverage, required facts, rounding
    rule and mode, and the declared source refs. The approval state of those
    sources is deliberately left out: it changes over time and is checked
    separately at use time (T16).

The hash is recorded on the tax_rule_pack_versions row at registration and
frozen with the other content columns. The engine refuses to calculate with
a pack whose running code no longer matches its ACTIVE version's approved
hash (NOT_DETERMINED / RULE_PACK_INTEGRITY_FAILED) and a P1 platform alert
fires. A deploy that changes pack code without a new approved version
therefore fails closed for that pack; other markets and legacy invoicing
keep working.

Shared engine code (the money path in determination_service, engines.py) is
outside the hash; it is covered by code review and the Phase 7 regression
gate (decision recorded in TAX_PHASE8.md).
"""
import hashlib
import inspect
import json
import logging
import sys
from typing import Optional

logger = logging.getLogger("zoiko_billing.tax.rule_pack_integrity")

PACKAGE = "app.modules.tax.rule_packs"
HASH_SCHEME = 1
INTEGRITY_FAILED = "RULE_PACK_INTEGRITY_FAILED"
ALERT_KEY = "tax.rule_pack_integrity"

MATCH, MISMATCH, CODE_MISSING = "MATCH", "MISMATCH", "CODE_MISSING"

_cache: dict = {}


class RulePackIntegrityError(Exception):
    """An ACTIVE rule-pack version covers the market, but the running code is
    not the code that was approved. Never a fallback."""

    def __init__(self, code: str, version: str, integrity: str):
        super().__init__(f"{code} v{version}: {integrity}")
        self.code, self.version, self.integrity = code, version, integrity


def clear_cache() -> None:
    _cache.clear()


def _read_module(module_name: str) -> str:
    module = sys.modules.get(module_name)
    if module is None:
        raise OSError(f"module {module_name} is not loaded")
    return inspect.getsource(module)


def pack_sources(pack_cls) -> dict:
    """{module name: source text (LF)} for the pack's modules in the package."""
    modules = sorted({k.__module__ for k in inspect.getmro(pack_cls)
                      if k.__module__ == PACKAGE or k.__module__.startswith(PACKAGE + ".")})
    return {name: _read_module(name).replace("\r\n", "\n").replace("\r", "\n") for name in modules}


def _declarations(pack_cls) -> dict:
    declared = pack_cls.declaration() if hasattr(pack_cls, "declaration") else {}
    return {key: declared.get(key) for key in ("code", "version", "markets", "coverage", "required_facts",
                                               "rounding_rule", "rounding_mode", "source_refs")}


def compute_hash(pack_cls) -> Optional[str]:
    """The pack's code hash, or None when its source cannot be read."""
    try:
        sources = pack_sources(pack_cls)
    except (OSError, TypeError) as exc:
        logger.error("Rule pack %s: source unreadable (%s)", getattr(pack_cls, "code", pack_cls), exc)
        return None
    blob = json.dumps({"hash_scheme": HASH_SCHEME, "sources": sources, "declarations": _declarations(pack_cls)},
                      sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def code_hash(pack_cls) -> Optional[str]:
    """Cached per process (a deploy restarts the process)."""
    key = (getattr(pack_cls, "code", None), getattr(pack_cls, "version", None), id(pack_cls))
    if key not in _cache:
        _cache[key] = compute_hash(pack_cls)
    return _cache[key]


def running_hash(code: str, version: str) -> Optional[str]:
    """The hash of the code running for (code, version), or None when that
    version of the pack is not in the running code."""
    from app.modules.tax.policy_service import RulePackService

    pack = RulePackService.catalogue().get(code)
    if pack is None or getattr(pack, "version", None) != version:
        return None
    return code_hash(pack)


def integrity_of(row) -> dict:
    """{code_hash, running_code_hash, integrity} for a rule-pack version row."""
    running = running_hash(row.code, row.version)
    if running is None:
        state = CODE_MISSING
    elif row.code_hash and row.code_hash == running:
        state = MATCH
    else:
        state = MISMATCH
    return {"code_hash": row.code_hash, "running_code_hash": running, "integrity": state}


def check_active(db) -> list:
    """ACTIVE versions whose running code is not the approved code."""
    from app.modules.tax.enums import PlatformVersionStatus
    from app.modules.tax.policy_models import TaxRulePackVersion

    out = []
    rows = db.query(TaxRulePackVersion).filter(TaxRulePackVersion.status == PlatformVersionStatus.ACTIVE)
    for row in rows.order_by(TaxRulePackVersion.code):
        state = integrity_of(row)
        if state["integrity"] != MATCH:
            out.append({"code": row.code, "version": row.version, "integrity": state["integrity"]})
    return out


def alert_for(failures: list) -> dict:
    """The P1 Attention alert (aggregate: pack codes only, no tenant data)."""
    from app.modules.super_admin.models import AttentionSeverity

    listed = "; ".join(f"{f['code']} v{f['version']} ({f['integrity']})" for f in failures)
    return {"key": ALERT_KEY, "firing": bool(failures), "severity": AttentionSeverity.P1,
            "title": "Tax: rule pack code differs from the approved version",
            "description": (f"Running rule-pack code is not the approved code: {listed}. Quotes for these markets "
                            "are refused (RULE_PACK_INTEGRITY_FAILED). Roll back the deploy, or register, review "
                            "and publish a new pack version. See TAX_MONITORING_RUNBOOK.md." if failures else
                            "Every ACTIVE rule pack matches its approved code hash.")}


def raise_alert(db, failures: list) -> None:
    """Open or update the P1 item in the caller's session (no commit)."""
    from app.modules.super_admin.attention_service import AttentionService
    from app.modules.tax.monitoring import SOURCE

    a = alert_for(failures)
    AttentionService(db).report_or_update(source=SOURCE, source_key=f"tax:{a['key']}", title=a["title"],
                                          description=a["description"], base_severity=a["severity"])


def verify_rule_packs_at_startup() -> list:
    """Lifespan check: log and alert on drift. Never stops the app; the
    engine fails closed for the affected packs."""
    from app.database import SessionLocal
    from app.modules.tax.monitoring import publish

    db = SessionLocal()
    try:
        failures = check_active(db)
        publish(db, [alert_for(failures)])
        if failures:
            logger.critical("Rule-pack integrity failed at startup: %s", failures)
        return failures
    except Exception as exc:                                   # never block startup on the check itself
        logger.warning("Rule-pack integrity check skipped at startup: %s", exc)
        return []
    finally:
        db.close()
