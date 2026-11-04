"""
scripts/ci_annotate_failures.py
-------------------------------
Turns CI failures into GitHub Actions annotations, which are visible on the PR
and the public checks API without opening (auth-only) job logs.

Usage:
    python scripts/ci_annotate_failures.py junit <results.xml>   # one annotation per failed/errored test
    python scripts/ci_annotate_failures.py log <file> <title>    # one annotation with the log's tail

Always exits 0; the calling step keeps its own exit status.
"""
import sys
import xml.etree.ElementTree as ET

MAX_ANNOTATIONS = 10   # GitHub shows at most 10 error annotations per step
MAX_CHARS = 3000


def _escape(text: str) -> str:
    # Workflow-command escaping for the message part.
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _emit(title: str, message: str) -> None:
    print(f"::error title={_escape(title)[:200]}::{_escape(message[-MAX_CHARS:])}")


def junit(path: str) -> None:
    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError) as exc:
        _emit("pytest results unavailable", f"{path}: {exc}")
        return
    emitted = 0
    for case in root.iter("testcase"):
        for kind in ("failure", "error"):
            node = case.find(kind)
            if node is None:
                continue
            if emitted >= MAX_ANNOTATIONS:
                return
            name = f"{case.get('classname', '')}::{case.get('name', '')}"
            _emit(f"{kind}: {name}", (node.get("message") or "") + "\n" + (node.text or ""))
            emitted += 1


def log(path: str, title: str) -> None:
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            _emit(title, fh.read())
    except OSError as exc:
        _emit(title, f"log unavailable: {exc}")


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "junit":
        junit(sys.argv[2])
    elif len(sys.argv) >= 4 and sys.argv[1] == "log":
        log(sys.argv[2], sys.argv[3])
    else:
        print(__doc__)
