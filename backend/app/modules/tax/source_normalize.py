"""
app/modules/tax/source_normalize.py
-----------------------------------
Normalization of fetched official-source content for change detection
(ZB-TAX-ARCH-001 Phase 8 PR 5, fix F). A change is a change in the
normalized hash, so page chrome and markup churn don't open reviews.

  text/html, application/xhtml+xml
      "html-text-v1": visible text only (script, style, noscript, template,
      head dropped; HTML parsed with the standard library), whitespace
      collapsed per line, blank lines removed.
  application/pdf
      "pdf-text-v1 (pypdf 5.1.0)": the text of every page via pypdf (pinned in
      requirements.txt: a new version could change the extracted text),
      whitespace collapsed per line.
  anything else (and PDFs pypdf can't read)
      "raw-bytes": no text, the raw SHA-256 is the change signal. A raw-hash
      change still opens a change review, labelled as raw.

The output is untrusted text: it is stored and diffed, rendered escaped as
plain text in the console, and never sent to any AI model.
"""
import hashlib
import io
import re
from html.parser import HTMLParser
from typing import Optional

PDF_LABEL = "pdf-text-v1 (pypdf 5.1.0)"
HTML_LABEL = "html-text-v1"
RAW_LABEL = "raw-bytes"
_SKIP = {"script", "style", "noscript", "template", "head"}
_BLOCK = {"p", "div", "br", "li", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article",
          "table", "ul", "ol", "dt", "dd", "pre", "blockquote"}


class _Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP:
            self.skip += 1
        elif tag in _BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in _SKIP and self.skip:
            self.skip -= 1
        elif tag in _BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def _tidy(text: str) -> str:
    lines = (re.sub(r"\s+", " ", line).strip() for line in text.splitlines())
    return "\n".join(line for line in lines if line)


def _charset(content_type: str) -> str:
    match = re.search(r"charset=([\w-]+)", content_type or "", re.I)
    return match.group(1) if match else "utf-8"


def normalize(body: bytes, content_type: Optional[str]) -> tuple:
    """(label, text or None, normalized sha256 or None)."""
    kind = (content_type or "").split(";")[0].strip().lower()
    text = None
    label = RAW_LABEL
    if kind in ("text/html", "application/xhtml+xml"):
        parser = _Text()
        parser.feed(body.decode(_charset(content_type), errors="replace"))
        text, label = _tidy("".join(parser.parts)), HTML_LABEL
    elif kind == "application/pdf":
        try:
            from pypdf import PdfReader

            reader = PdfReader(io.BytesIO(body))
            text, label = _tidy("\n".join((page.extract_text() or "") for page in reader.pages)), PDF_LABEL
        except Exception:                                   # noqa: BLE001 - unreadable PDF: raw hash only
            text, label = None, RAW_LABEL
    elif kind.startswith("text/"):
        text, label = _tidy(body.decode(_charset(content_type), errors="replace")), "plain-text-v1"
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest() if text is not None else None
    return label, text, digest
