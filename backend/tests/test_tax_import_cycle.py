"""tests/test_tax_import_cycle.py
-------------------------------
Regression guard for the Phase 0 import cycle (fixed in ZB-TAX-ARCH-001
Phase 2): legal_entity_service -> billing.services (package __init__) ->
invoice_service -> legal_entity_service.

Import order inside one pytest process is fixed by whatever ran first, so
each check runs in a FRESH interpreter where the named module is imported
before anything else.
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent

FIRST_IMPORTS = [
    "app.modules.tax.legal_entity_service",
    "app.modules.tax.router",
    "app.modules.tax.registry_service",
    "app.modules.billing.services.invoice_service",
]


@pytest.mark.parametrize("module", FIRST_IMPORTS)
def test_module_imports_first_in_a_fresh_interpreter(module):
    result = subprocess.run(
        [sys.executable, "-c", f"import {module}"],
        cwd=BACKEND, env=dict(os.environ), capture_output=True, text=True, timeout=180,
    )
    assert result.returncode == 0, f"import {module} failed:\n{result.stderr[-3000:]}"
