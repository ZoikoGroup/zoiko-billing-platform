"""Run the provider conformance suite from the command line (Phase 4d).

    TAX_CONFORMANCE_SECRET=<sandbox credential> \
        python -m tests.tax_provider_conformance pkg.module:make_adapter

`make_adapter(**faults)` builds a fresh sandbox adapter. Prints the JSON
report (no credential in it) and exits 0 only when it passed.
"""
import importlib
import json
import os
import sys

from tests.tax_provider_conformance import run_all


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1 or ":" not in argv[0]:
        print("usage: python -m tests.tax_provider_conformance pkg.module:make_adapter", file=sys.stderr)
        return 2
    module_name, attr = argv[0].split(":", 1)
    make_adapter = getattr(importlib.import_module(module_name), attr)
    report = run_all(make_adapter, secret=os.environ.get("TAX_CONFORMANCE_SECRET") or None)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
