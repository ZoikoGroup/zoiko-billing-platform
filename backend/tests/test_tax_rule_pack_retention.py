"""tests/test_tax_rule_pack_retention.py
-------------------------------------
ZB-TAX-ARCH-001 Phase 8 PR 3: rule-pack code retention (the CI check).

Every version listed in app/modules/tax/rule_packs/retention.json (and not
marked retired) must still ship, with the code hash recorded there; and no
entry on origin/main may be removed. Removing an old pack module therefore
fails CI. The CI step sets TAX_RETENTION_BASE_REQUIRED=1 after fetching
origin/main, so the comparison can't be skipped there; locally it is skipped
when origin/main isn't available.
"""
import os
import pathlib
import subprocess

import pytest

from app.modules.tax import rule_pack_retention as retention

REPO = pathlib.Path(__file__).resolve().parents[2]
MANIFEST_IN_REPO = "backend/app/modules/tax/rule_packs/retention.json"


def _git(*args) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True)


def test_every_listed_version_still_ships_with_its_hash():
    assert retention.code_problems() == []


def test_every_entry_names_code_version_and_hash():
    for (code, version), item in retention.load_manifest().items():
        assert code and version and len(item.get("code_hash") or "") == 64, (code, version)


def test_no_entry_on_main_was_removed():
    required = os.environ.get("TAX_RETENTION_BASE_REQUIRED") == "1"
    if _git("rev-parse", "--verify", "--quiet", "origin/main").returncode != 0:
        if required:
            pytest.fail("origin/main is not available; fetch it before this check (see .github/workflows/ci.yml).")
        pytest.skip("origin/main is not available locally")
    shown = _git("show", f"origin/main:{MANIFEST_IN_REPO}")
    if shown.returncode != 0:
        return                                            # main has no manifest yet: nothing can have been removed
    removed = retention.removed_entries(retention.load_manifest(shown.stdout), retention.load_manifest())
    assert removed == [], ("Entries removed from rule_packs/retention.json: " + ", ".join(removed)
                           + ". Mark a version retired instead of deleting it.")
