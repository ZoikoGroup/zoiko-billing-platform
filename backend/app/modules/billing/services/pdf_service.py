"""
PDF generation for invoices and quotations, attached to outgoing billing emails.
Uses reportlab (already a project dependency — see payroll/service.py for the
payslip-generation precedent).
"""

from io import BytesIO
from typing import Any, List, Optional

from app.modules.billing.utils.currency_utils import get_currency_decimal_digits, round_money


def _fmt_money(value: Any, currency: str = "") -> str:
    try:
        digits = get_currency_decimal_digits(currency) if currency else 2
        amount = f"{round_money(value or 0, currency):,.{digits}f}"
    except (TypeError, ValueError, ArithmeticError):
        amount = "0.00"
    return f"{currency} {amount}".strip()


def _fmt_date(value: Any) -> str:
    if not value:
        return ""
    if hasattr(value, "strftime"):
        return value.strftime("%B %d, %Y")
    return str(value)


def _fmt_inr_grouped(value: Any) -> str:
    """Format a number with Indian digit grouping (e.g. 48,500.00 → 48,500.00;
    1,00,000 → 1,00,000)."""
    try:
        val = f"{float(value or 0):.2f}"
    except (TypeError, ValueError, ArithmeticError):
        return "0.00"
    neg = ""
    if val.startswith("-"):
        neg, val = "-", val[1:]
    int_part, _, frac = val.partition(".")
    if len(int_part) <= 3:
        return f"{neg}{int_part}.{frac}"
    head, tail = int_part[:-3], int_part[-3:]
    groups = []
    while head:
        groups.insert(0, head[-2:])
        head = head[:-2]
    return f"{neg}{','.join(groups)},{tail}.{frac}"


def _fmt_inr(value: Any, currency: str = "") -> str:
    if (currency or "").upper() == "INR":
        return f"INR {_fmt_inr_grouped(value)}"
    return _fmt_money(value, currency)


def _number_to_words_in(num: Any) -> str:
    """Convert a rupee amount to words using the Indian numbering system
    (lakh/crore). Mirrors the on-screen invoice preview."""
    ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
            "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"]
    tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]

    def two_digits(n):
        if n < 20:
            return ones[n]
        return tens[n // 10] + (" " + ones[n % 10] if n % 10 else "")

    def three_digits(n):
        if n < 100:
            return two_digits(n)
        return ones[n // 100] + " Hundred" + (" " + two_digits(n % 100) if n % 100 else "")

    try:
        num = float(num or 0)
    except (TypeError, ValueError, ArithmeticError):
        num = 0.0
    rupees = int(num)
    paise = round((num - rupees) * 100)

    if rupees == 0:
        return "Zero Rupees Only"

    n = rupees
    crore = n // 10000000
    n %= 10000000
    lakh = n // 100000
    n %= 100000
    thousand = n // 1000
    n %= 1000
    hundred = n

    words = ""
    if crore:
        words += three_digits(crore) + " Crore "
    if lakh:
        words += three_digits(lakh) + " Lakh "
    if thousand:
        words += three_digits(thousand) + " Thousand "
    if hundred:
        words += three_digits(hundred)

    words = words.strip() + " Rupees"
    if paise:
        words += " and " + two_digits(paise) + " Paise"
    return words + " Only"


def _fetch_logo_flowable(logo_url: Optional[str], max_width_mm: float = 35, max_height_mm: float = 18):
    """
    Best-effort fetch of the organization's logo (a plain external URL configured
    in Billing Settings) for the PDF header, scaled to fit within max_width/
    max_height while preserving aspect ratio. Returns a reportlab Image flowable,
    or None if there's no URL configured, the URL is unreachable, or the content
    isn't a valid image — PDF generation must never fail because of a broken
    logo URL (same fail-open policy already used for the rest of this module).
    """
    if not logo_url:
        return None
    try:
        import httpx
        from reportlab.lib.units import mm
        from reportlab.platypus import Image
        from PIL import Image as PILImage

        resp = httpx.get(logo_url, timeout=5.0, follow_redirects=True)
        resp.raise_for_status()
        raw = BytesIO(resp.content)
        pil_img = PILImage.open(raw)
        pil_img.load()
        width_px, height_px = pil_img.size
        if width_px <= 0 or height_px <= 0:
            return None

        max_w, max_h = max_width_mm * mm, max_height_mm * mm
        aspect = width_px / height_px
        draw_w, draw_h = max_w, max_w / aspect
        if draw_h > max_h:
            draw_h = max_h
            draw_w = max_h * aspect

        raw.seek(0)
        return Image(raw, width=draw_w, height=draw_h)
    except Exception:
        return None


def _build_document(
    title: str,
    document_number: str,
    accent_color: str,
    org_name: str,
    org_address_lines: List[str],
    customer_name: str,
    customer_address_lines: List[str],
    detail_rows: List[tuple],
    item_rows: List[tuple],
    currency: str,
    subtotal: Any,
    discount_amount: Any,
    tax_amount: Any,
    total_amount: Any,
    org_logo_url: Optional[str] = None,
    shipping_amount: Any = None,
    round_off: Any = None,
    notes: Optional[str] = None,
    footer_text: Optional[str] = None,
    item_headers: Optional[List[str]] = None,
    item_widths: Optional[List[float]] = None,
    footer_lines: Optional[List[str]] = None,
) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.platypus import (
        SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer,
    )

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        topMargin=20 * mm, bottomMargin=20 * mm, leftMargin=18 * mm, rightMargin=18 * mm,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("DocTitle", parent=styles["Title"], textColor=colors.HexColor(accent_color), fontSize=20)
    normal = styles["Normal"]
    small = ParagraphStyle("Small", parent=styles["Normal"], fontSize=9, textColor=colors.HexColor("#6b7280"))
    bold = ParagraphStyle("Bold", parent=styles["Normal"], fontSize=11, fontName="Helvetica-Bold")

    elements = []
    org_name_style = ParagraphStyle("OrgName", parent=bold, fontSize=14)
    org_text_block = [Paragraph(org_name or "Zoiko Billing", org_name_style)]
    for line in org_address_lines:
        if line:
            org_text_block.append(Paragraph(line, small))

    logo_flowable = _fetch_logo_flowable(org_logo_url)
    if logo_flowable is not None:
        # Logo on the right, org name/address text on the left — mirrors the
        # on-screen invoice preview's layout so the printed document isn't a
        # surprise. Text is always kept (not replaced by the logo) so the PDF
        # still identifies the org even if the logo fails to render for the
        # recipient's PDF viewer.
        logo_header = Table(
            [[org_text_block, logo_flowable]],
            colWidths=[120 * mm, 50 * mm],
        )
        logo_header.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("ALIGN", (1, 0), (1, 0), "RIGHT"),
        ]))
        elements.append(logo_header)
    else:
        elements.extend(org_text_block)

    elements.append(Spacer(1, 10 * mm))
    elements.append(Paragraph(f"{title} {document_number}", title_style))
    elements.append(Spacer(1, 6 * mm))

    bill_to = [Paragraph("Bill To:", bold), Paragraph(customer_name or "", normal)]
    for line in customer_address_lines:
        if line:
            bill_to.append(Paragraph(line, small))

    detail_table_data = [[Paragraph(f"<b>{label}</b>", small), Paragraph(str(value), normal)] for label, value in detail_rows]
    header_table = Table(
        [[bill_to, detail_table_data]],
        colWidths=[90 * mm, 80 * mm],
    )
    header_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
    elements.append(header_table)
    elements.append(Spacer(1, 8 * mm))

    headers = item_headers or ["Description", "Qty", "Unit Price", "Tax", "Total"]
    col_widths = item_widths or [70 * mm, 20 * mm, 30 * mm, 25 * mm, 25 * mm]

    def _cell_for(header, desc, qty, unit_price, tax, total):
        cells = {
            "Description": Paragraph(str(desc), normal),
            "Item": Paragraph(str(desc), normal),
            "Qty": str(qty),
            "Unit Price": _fmt_money(unit_price),
            "Rate": _fmt_money(unit_price),
            "Tax": _fmt_money(tax),
            "Total": _fmt_money(total),
            "Amount": _fmt_money(total),
        }
        return cells[header]

    table_data = [headers] + [
        [_cell_for(h, desc, qty, unit_price, tax, total) for h in headers]
        for desc, qty, unit_price, tax, total in item_rows
    ]
    items_table = Table(table_data, colWidths=col_widths, repeatRows=1)
    items_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(accent_color)),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f9fafb")]),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    elements.append(items_table)
    elements.append(Spacer(1, 6 * mm))

    totals_data = [
        ["Subtotal", _fmt_money(subtotal, currency)],
        ["Discount", _fmt_money(discount_amount, currency)],
        ["Tax", _fmt_money(tax_amount, currency)],
    ]
    if shipping_amount:
        totals_data.append(["Shipping", _fmt_money(shipping_amount, currency)])
    if round_off:
        totals_data.append(["Round Off", _fmt_money(round_off, currency)])
    totals_data.append(["Total", _fmt_money(total_amount, currency)])
    totals_table = Table(totals_data, colWidths=[130 * mm, 40 * mm], hAlign="RIGHT")
    totals_table.setStyle(TableStyle([
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, -1), (-1, -1), 12),
        ("LINEABOVE", (0, -1), (-1, -1), 0.75, colors.HexColor(accent_color)),
        ("TOPPADDING", (0, -1), (-1, -1), 6),
    ]))
    elements.append(totals_table)

    if notes:
        elements.append(Spacer(1, 8 * mm))
        elements.append(Paragraph("<b>Notes</b>", small))
        elements.append(Paragraph(notes, normal))

    if footer_text:
        elements.append(Spacer(1, 10 * mm))
        elements.append(Paragraph(footer_text, small))

    if footer_lines:
        elements.append(Spacer(1, 10 * mm))
        for line in footer_lines:
            if line:
                elements.append(Paragraph(line, small))

    doc.build(elements)
    return buffer.getvalue()


def _org_legal_entity(org_config, company_name: str = "") -> str:
    """Build the org's legal-entity string (company name plus any registration
    numbers) mirroring the email branding block."""
    reg_parts = []
    for label, value in (
        ("business registration", getattr(org_config, "business_registration_number", None)),
        ("GST", getattr(org_config, "gst_number", None)),
        ("VAT", getattr(org_config, "vat_number", None)),
        ("PAN", getattr(org_config, "pan_number", None)),
        ("TIN", getattr(org_config, "tin_number", None)),
    ):
        if value:
            reg_parts.append(f"{label} no. {value}")
    if reg_parts:
        return f"{company_name} — {', '.join(reg_parts)}"
    return company_name


def _org_billing_address(org_config) -> str:
    if not org_config:
        return ""
    return ", ".join(filter(None, [
        getattr(org_config, "address_line1", None),
        getattr(org_config, "address_line2", None),
        getattr(org_config, "city", None),
        getattr(org_config, "state", None),
        getattr(org_config, "postal_code", None),
        getattr(org_config, "country", None),
    ]))


def _org_address_lines(org_config) -> List[str]:
    if not org_config:
        return []
    return [
        getattr(org_config, "address_line1", None),
        getattr(org_config, "address_line2", None),
        ", ".join(filter(None, [
            getattr(org_config, "city", None),
            getattr(org_config, "state", None),
            getattr(org_config, "postal_code", None),
        ])),
        getattr(org_config, "country", None),
        getattr(org_config, "website", None),
        (getattr(org_config, "gst_number", None) or getattr(org_config, "vat_number", None)
         or getattr(org_config, "business_registration_number", None)),
    ]


def _gradient_rect(canvas, x, y, width, height, color_start, color_end, steps=48):
    """Fill a rectangle with a horizontal linear gradient by drawing `steps`
    vertical slices that interpolate between color_start and color_end (both
    reportlab Color objects). reportlab has no native CSS-style gradient
    fill, so this mirrors the email header's linear-gradient(135deg, #2563EB,
    #7C3AED) banner as closely as flat PDF drawing allows."""
    slice_w = width / steps
    for i in range(steps):
        t = i / (steps - 1) if steps > 1 else 0
        r = color_start.red + (color_end.red - color_start.red) * t
        g = color_start.green + (color_end.green - color_start.green) * t
        b = color_start.blue + (color_end.blue - color_start.blue) * t
        canvas.setFillColorRGB(r, g, b)
        canvas.rect(x + i * slice_w, y, slice_w + 0.5, height, stroke=0, fill=1)


def _draw_page_background(canvas, doc, page_color="#F4F4F4", card_border="#E5E7EB", card_inset_mm=10):
    """Fills the page with a light gray background and draws the white "card"
    panel behind the content. Drawn on the canvas (not as a flowable Table
    wrapping the content) so it repeats on every page independent of how the
    content paginates — the previous approach nested every invoice flowable
    inside a single Table cell, which made ReportLab treat the whole invoice
    as one unsplittable block and raise a LayoutError as soon as an invoice
    had enough line items to overflow one page."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    inset = card_inset_mm * mm
    canvas.saveState()
    canvas.setFillColor(colors.HexColor(page_color))
    canvas.rect(0, 0, A4[0], A4[1], stroke=0, fill=1)
    canvas.setFillColor(colors.white)
    canvas.setStrokeColor(colors.HexColor(card_border))
    canvas.rect(inset, inset, A4[0] - 2 * inset, A4[1] - 2 * inset, stroke=1, fill=1)
    canvas.restoreState()


def _build_invoice_document(
    org_name: str,
    org_lines: List[str],
    customer_name: str,
    customer_lines: List[str],
    invoice_label: str,
    invoice_number: str,
    po_number: str,
    currency: str,
    issue_date: str,
    due_date: str,
    payment_terms: str,
    balance_due: Any,
    item_rows: List[dict],
    subtotal: Any,
    discount: Any,
    tax: Any,
    total: Any,
    amount_paid: Any,
    bank_rows: List[tuple],
    terms_list: List[str],
    notes: str,
    org_logo_url: Optional[str] = None,
    org_footer_lines: Optional[List[str]] = None,
) -> bytes:
    """Render an invoice PDF matching the on-screen React preview design:
    purple accent, status pill, Code/HSN item table, Indian amount-in-words,
    payment details and terms. Used only for invoices; other billing documents
    keep `_build_document`."""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, HRFlowable, Flowable,
    )

    INK = colors.HexColor("#1F2937")
    MUTED = colors.HexColor("#6B7280")
    FAINT = colors.HexColor("#9CA3AF")
    ACCENT = colors.HexColor("#2563EB")
    ACCENT_END = colors.HexColor("#7C3AED")
    HIGHLIGHT_BG = colors.HexColor("#F8FAFC")
    ORANGE = colors.HexColor("#EA580C")
    BORDER = colors.HexColor("#E5E7EB")
    ZEBRA = colors.HexColor("#FAFAFA")
    PANEL = colors.HexColor("#F9FAFB")

    class _HeaderBanner(Flowable):
        """Full-width blue-to-purple gradient banner mirroring the
        "invoice issued" email's header row: org name + "via Zoiko Billing"
        on the left."""

        def __init__(self, width, height, org_label):
            super().__init__()
            self.width = width
            self.height = height
            self.org_label = org_label

        def draw(self):
            c = self.canv
            _gradient_rect(c, 0, 0, self.width, self.height, ACCENT, ACCENT_END)

            c.setFillColor(colors.white)
            c.setFont("Helvetica-Bold", 13)
            c.drawString(6 * mm, self.height - 9 * mm, self.org_label or "Zoiko Billing")
            c.setFont("Helvetica", 8)
            c.setFillColor(colors.Color(1, 1, 1, alpha=0.8))
            c.drawString(6 * mm, self.height - 14.5 * mm, "via Zoiko Billing")

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        # 20mm = the 10mm card inset drawn by _draw_page_background plus a
        # 10mm content padding inside the card, matching the old Table's
        # LEFTPADDING/RIGHTPADDING/TOPPADDING/BOTTOMPADDING of 10mm.
        topMargin=10 * mm, bottomMargin=10 * mm, leftMargin=20 * mm, rightMargin=20 * mm,
        title=f"{invoice_label} {invoice_number}",
        author=org_name,
    )
    styles = getSampleStyleSheet()

    def p(text, style):
        return Paragraph(text or "", style)

    org_name_style = ParagraphStyle("OrgName", parent=styles["Normal"], fontSize=14, leading=17, fontName="Helvetica-Bold", textColor=INK)
    org_line_style = ParagraphStyle("OrgLine", parent=styles["Normal"], fontSize=8.5, leading=11.5, textColor=MUTED)
    invoice_label_style = ParagraphStyle("InvoiceLabel", parent=styles["Normal"], fontSize=9, leading=11, textColor=FAINT)
    invoice_number_style = ParagraphStyle("InvoiceNumber", parent=styles["Normal"], fontSize=16, leading=19, fontName="Helvetica-Bold", textColor=INK)
    pill_style = ParagraphStyle("Pill", parent=styles["Normal"], fontSize=8, leading=10, fontName="Helvetica-Bold", textColor=colors.white, backColor=ACCENT, borderPadding=4, alignment=TA_CENTER)
    meta_label_style = ParagraphStyle("MetaLabel", parent=styles["Normal"], fontSize=8, leading=10, textColor=FAINT)
    meta_value_style = ParagraphStyle("MetaValue", parent=styles["Normal"], fontSize=9, leading=11, textColor=INK)
    section_label_style = ParagraphStyle("SectionLabel", parent=styles["Normal"], fontSize=9, leading=11, textColor=FAINT)
    balance_style = ParagraphStyle("Balance", parent=styles["Normal"], fontSize=11, leading=13, fontName="Helvetica-Bold", textColor=ACCENT)
    table_header_style = ParagraphStyle("THead", parent=styles["Normal"], fontSize=9, leading=11, fontName="Helvetica-Bold", textColor=INK)
    cell_style = ParagraphStyle("Cell", parent=styles["Normal"], fontSize=9, leading=11, textColor=INK)
    cell_muted_style = ParagraphStyle("CellMuted", parent=styles["Normal"], fontSize=9, leading=11, textColor=MUTED)
    cell_faint_style = ParagraphStyle("CellFaint", parent=styles["Normal"], fontSize=9, leading=11, textColor=FAINT)
    word_style = ParagraphStyle("Word", parent=styles["Normal"], fontSize=9, leading=12, textColor=MUTED)
    total_row_style = ParagraphStyle("TotalRow", parent=styles["Normal"], fontSize=10, leading=12, textColor=INK, alignment=TA_RIGHT)
    total_bold_style = ParagraphStyle("TotalBold", parent=styles["Normal"], fontSize=10.5, leading=12.5, fontName="Helvetica-Bold", textColor=INK, alignment=TA_RIGHT)
    total_accent_style = ParagraphStyle("TotalAccent", parent=styles["Normal"], fontSize=12, leading=14, fontName="Helvetica-Bold", textColor=ACCENT, alignment=TA_RIGHT)
    panel_title_style = ParagraphStyle("PanelTitle", parent=styles["Normal"], fontSize=9.5, leading=12, fontName="Helvetica-Bold", textColor=INK)
    panel_text_style = ParagraphStyle("PanelText", parent=styles["Normal"], fontSize=8.5, leading=11.5, textColor=MUTED)
    footer_style = ParagraphStyle("Footer", parent=styles["Normal"], fontSize=8, leading=10.5, textColor=FAINT, alignment=TA_CENTER)
    sig_caption_style = ParagraphStyle("SigCaption", parent=styles["Normal"], fontSize=8.5, leading=11, textColor=MUTED, alignment=TA_CENTER)

    def meta_block(label, value):
        return [p(label, meta_label_style), p(value or "N/A", meta_value_style)]

    elements = []

    # ---- Gradient banner: mirrors the "invoice issued" email header ----
    elements.append(_HeaderBanner(doc.width, 18 * mm, org_name))
    elements.append(Spacer(1, 5 * mm))

    # ---- Amount Due highlight: mirrors the email's highlight box ----
    amount_due_block = [
        p("AMOUNT DUE", ParagraphStyle("AmountDueLabel", parent=styles["Normal"], fontSize=8, leading=10, fontName="Helvetica-Bold", textColor=MUTED)),
        Spacer(1, 1.5 * mm),
        p(_fmt_inr(balance_due, currency), ParagraphStyle("AmountDueValue", parent=styles["Normal"], fontSize=18, leading=21, fontName="Helvetica-Bold", textColor=INK)),
        Spacer(1, 1.5 * mm),
        p(f"Payment is due by {due_date}" if due_date else "Payment due on receipt", ParagraphStyle("AmountDueDue", parent=styles["Normal"], fontSize=9, leading=11, fontName="Helvetica-Bold", textColor=ORANGE)),
    ]
    amount_due_box = Table([["", amount_due_block]], colWidths=[1.5 * mm, doc.width - 1.5 * mm])
    amount_due_box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), ACCENT),
        ("BACKGROUND", (1, 0), (1, 0), HIGHLIGHT_BG),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (0, 0), 0),
        ("RIGHTPADDING", (0, 0), (0, 0), 0),
        ("LEFTPADDING", (1, 0), (1, 0), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    elements.append(amount_due_box)
    elements.append(Spacer(1, 5 * mm))

    # ---- Header: org block (left) + invoice meta (right) ----
    org_block = [p(org_name or "Zoiko Billing", org_name_style)]
    for line in org_lines:
        if line:
            org_block.append(p(line, org_line_style))
    org_cell = Table([[org_block]], colWidths=[95 * mm])
    org_cell.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))

    right_cells = []
    logo_flowable = _fetch_logo_flowable(org_logo_url, max_width_mm=30, max_height_mm=14)
    if logo_flowable is not None:
        logo_holder = Table([[logo_flowable]], colWidths=[70 * mm])
        logo_holder.setStyle(TableStyle([("ALIGN", (0, 0), (-1, -1), "RIGHT")]))
        right_cells.append(logo_holder)
    right_cells.append(p(invoice_label, invoice_label_style))
    right_cells.append(Spacer(1, 1 * mm))
    right_cells.append(p(invoice_number, invoice_number_style))
    right_cells.append(Spacer(1, 3 * mm))
    right_cells.append(Table(
        [meta_block("PO Number", po_number), meta_block("Currency", currency)],
        colWidths=[35 * mm, 35 * mm],
        hAlign="RIGHT",
    ))
    right_cells.append(Spacer(1, 1 * mm))
    right_meta = Table([[right_cells]], colWidths=[72 * mm])
    right_meta.setStyle(TableStyle([
        ("ALIGN", (0, 0), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))

    header_table = Table([[org_cell, right_meta]], colWidths=[95 * mm, 72 * mm])
    header_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    elements.append(header_table)
    elements.append(Spacer(1, 4 * mm))
    elements.append(HRFlowable(width="100%", thickness=0.75, color=BORDER))
    elements.append(Spacer(1, 4 * mm))

    # ---- Bill To (left) + meta grid (right) ----
    bill_block = [p("Bill To", section_label_style), Spacer(1, 1.5 * mm)]
    bill_block.append(p(customer_name or "", ParagraphStyle("CustName", parent=org_line_style, fontName="Helvetica-Bold", textColor=INK, fontSize=9.5, leading=12)))
    for line in customer_lines:
        if line:
            bill_block.append(p(line, org_line_style))
    bill_cell = Table([[bill_block]], colWidths=[95 * mm])
    bill_cell.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))

    meta_grid = Table([
        meta_block("Issue Date", issue_date),
        meta_block("Due Date", due_date),
        meta_block("Payment Terms", payment_terms),
        [p("Balance Due", meta_label_style), p(_fmt_inr(balance_due, currency), balance_style)],
    ], colWidths=[36 * mm, 36 * mm])
    meta_grid.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LEFTPADDING", (0, 0), (-1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("BACKGROUND", (0, 0), (-1, -1), PANEL),
    ]))
    meta_cell = Table([[meta_grid]], colWidths=[72 * mm])
    meta_cell.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))

    billto_table = Table([[bill_cell, meta_cell]], colWidths=[95 * mm, 72 * mm])
    billto_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    elements.append(billto_table)
    elements.append(Spacer(1, 5 * mm))

    # ---- Items table ----
    code_w, desc_w, hsn_w, qty_w, price_w, tax_w, total_w = 20, 44, 18, 12, 26, 20, 27
    item_col_widths = [code_w, desc_w, hsn_w, qty_w, price_w, tax_w, total_w]
    table_data = [
        [p("Code", table_header_style), p("Description", table_header_style), p("HSN/SAC", table_header_style),
         p("Qty", table_header_style), p("Unit Price", table_header_style), p("Tax", table_header_style), p("Total", table_header_style)],
    ]
    for row in item_rows:
        table_data.append([
            p(str(row.get("code") or ""), cell_faint_style),
            p(str(row.get("description") or ""), cell_style),
            p(str(row.get("hsn") or ""), cell_faint_style),
            p(str(row.get("qty") or "1"), cell_style),
            p(_fmt_inr(row.get("unit_price"), currency), cell_style),
            p(_fmt_inr(row.get("tax"), currency), cell_style),
            p(_fmt_inr(row.get("total"), currency), cell_style),
        ])
    items_table = Table(table_data, colWidths=[w * mm for w in item_col_widths], repeatRows=1, hAlign="LEFT")
    items_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), PANEL),
        ("LINEBELOW", (0, 0), (-1, 0), 0.75, BORDER),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, ZEBRA]),
        ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (3, 0), (6, -1), "RIGHT"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]))
    elements.append(items_table)
    elements.append(Spacer(1, 4 * mm))

    # ---- Amount in words (left) + totals (right) ----
    words_block = [
        p("Amount in words", section_label_style),
        Spacer(1, 2 * mm),
        p(_number_to_words_in(total), word_style),
    ]
    words_cell = Table([[words_block]], colWidths=[80 * mm])
    words_cell.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))

    totals_rows = [
        [p("Subtotal", total_row_style), p(_fmt_inr(subtotal, currency), total_row_style)],
    ]
    if discount and float(discount or 0) != 0:
        totals_rows.append([p("Discount", total_row_style), p(_fmt_inr(discount, currency), total_row_style)])
    totals_rows.append([p("Tax", total_row_style), p(_fmt_inr(tax, currency), total_row_style)])
    totals_rows.append([p("Total", total_bold_style), p(_fmt_inr(total, currency), total_bold_style)])
    if amount_paid and float(amount_paid or 0) != 0:
        totals_rows.append([p("Amount Paid", total_row_style), p(_fmt_inr(amount_paid, currency), total_row_style)])
        totals_rows.append([p("Balance Due", total_accent_style), p(_fmt_inr(balance_due, currency), total_accent_style)])
    totals_table = Table(totals_rows, colWidths=[40 * mm, 55 * mm], hAlign="RIGHT")
    totals_table.setStyle(TableStyle([
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LEFTPADDING", (0, 0), (-1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2),
    ]))
    totals_cell = Table([[totals_table]], colWidths=[87 * mm])
    totals_cell.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ALIGN", (0, 0), (-1, -1), "RIGHT"),
    ]))

    words_total = Table([[words_cell, totals_cell]], colWidths=[80 * mm, 87 * mm])
    words_total.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    elements.append(words_total)
    elements.append(Spacer(1, 4 * mm))

    # ---- Payment Details + Terms (render only when data present) ----
    if bank_rows or terms_list:
        left_children = []
        if bank_rows:
            left_children.append(p("Payment Details", panel_title_style))
            left_children.append(Spacer(1, 2 * mm))
            for label, value in bank_rows:
                if value:
                    left_children.append(p(f"<b>{label}</b>: {value}", panel_text_style))
        right_children = []
        if terms_list:
            right_children.append(p("Terms & Conditions", panel_title_style))
            right_children.append(Spacer(1, 2 * mm))
            for t in terms_list:
                right_children.append(p(f"-  {t}", panel_text_style))
        panel_cells = []
        if bank_rows:
            panel_cells.append(Table([[left_children]], colWidths=[80 * mm]))
        if terms_list:
            panel_cells.append(Table([[right_children]], colWidths=[87 * mm]))
        panel_row = [left_children if bank_rows else [], right_children if terms_list else []]
        panel = Table([panel_row], colWidths=[80 * mm, 87 * mm])
        panel.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), PANEL),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("BOX", (0, 0), (-1, -1), 0.5, BORDER),
        ]))
        elements.append(panel)
        elements.append(Spacer(1, 3 * mm))

    # ---- Signature ----
    sig = Table([[
        Spacer(1, 0),
        Table([
            [HRFlowable(width="100%", thickness=0.75, color=BORDER)],
            [p("Authorized Signatory", sig_caption_style)],
        ], colWidths=[55 * mm], hAlign="RIGHT"),
    ]], colWidths=[112 * mm, 55 * mm])
    sig.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    elements.append(sig)

    # ---- Footer ----
    if org_footer_lines:
        elements.append(Spacer(1, 8 * mm))
        elements.append(HRFlowable(width="100%", thickness=0.5, color=BORDER))
        elements.append(Spacer(1, 4 * mm))
        for line in org_footer_lines:
            if line:
                elements.append(p(line, footer_style))

    if notes:
        elements.append(Spacer(1, 4 * mm))
        elements.append(HRFlowable(width="100%", thickness=0.5, color=BORDER))
        elements.append(Spacer(1, 2.5 * mm))
        elements.append(p(notes, footer_style))

    # `elements` is built directly as the document's flowables (not nested
    # inside a wrapping Table) so ReportLab can paginate/split it normally —
    # the card's white background and border are drawn on the canvas by
    # _draw_page_background instead. onFirstPage/onLaterPages are build()
    # parameters, not SimpleDocTemplate constructor kwargs — passing them to
    # the constructor (as this previously did) is silently a no-op.
    doc.build(
        elements,
        onFirstPage=lambda c, d: _draw_page_background(c, d),
        onLaterPages=lambda c, d: _draw_page_background(c, d),
    )
    return buffer.getvalue()


def _build_quote_document(
    org_name: str,
    org_lines: List[str],
    customer_name: str,
    customer_lines: List[str],
    quote_number: str,
    reference: str,
    currency: str,
    issue_date: str,
    valid_until: str,
    status_label: str,
    item_rows: List[dict],
    subtotal: Any,
    discount: Any,
    tax: Any,
    total: Any,
    terms_list: List[str],
    notes: str,
    org_logo_url: Optional[str] = None,
    org_footer_lines: Optional[List[str]] = None,
) -> bytes:
    """Render an estimate/quote PDF using the same blue design language as
    the invoice PDF (`_build_invoice_document`): gradient banner, highlight
    box, meta grid, itemized table, totals. Quotes have no balance-due/
    amount-paid/bank-details concepts, so those sections are dropped."""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, HRFlowable, Flowable,
    )

    INK = colors.HexColor("#1F2937")
    MUTED = colors.HexColor("#6B7280")
    FAINT = colors.HexColor("#9CA3AF")
    ACCENT = colors.HexColor("#2563EB")
    ACCENT_END = colors.HexColor("#7C3AED")
    HIGHLIGHT_BG = colors.HexColor("#F8FAFC")
    ORANGE = colors.HexColor("#EA580C")
    BORDER = colors.HexColor("#E5E7EB")
    ZEBRA = colors.HexColor("#FAFAFA")
    PANEL = colors.HexColor("#F9FAFB")

    class _HeaderBanner(Flowable):
        """Full-width blue-to-purple gradient banner mirroring the
        "estimate is ready" email's header row: org name + "via Zoiko
        Billing" on the left."""

        def __init__(self, width, height, org_label):
            super().__init__()
            self.width = width
            self.height = height
            self.org_label = org_label

        def draw(self):
            c = self.canv
            _gradient_rect(c, 0, 0, self.width, self.height, ACCENT, ACCENT_END)

            c.setFillColor(colors.white)
            c.setFont("Helvetica-Bold", 13)
            c.drawString(6 * mm, self.height - 9 * mm, self.org_label or "Zoiko Billing")
            c.setFont("Helvetica", 8)
            c.setFillColor(colors.Color(1, 1, 1, alpha=0.8))
            c.drawString(6 * mm, self.height - 14.5 * mm, "via Zoiko Billing")

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        topMargin=10 * mm, bottomMargin=10 * mm, leftMargin=20 * mm, rightMargin=20 * mm,
        title=f"Estimate {quote_number}",
        author=org_name,
    )
    styles = getSampleStyleSheet()

    def p(text, style):
        return Paragraph(text or "", style)

    org_name_style = ParagraphStyle("QOrgName", parent=styles["Normal"], fontSize=14, leading=17, fontName="Helvetica-Bold", textColor=INK)
    org_line_style = ParagraphStyle("QOrgLine", parent=styles["Normal"], fontSize=8.5, leading=11.5, textColor=MUTED)
    quote_label_style = ParagraphStyle("QLabel", parent=styles["Normal"], fontSize=9, leading=11, textColor=FAINT)
    quote_number_style = ParagraphStyle("QNumber", parent=styles["Normal"], fontSize=16, leading=19, fontName="Helvetica-Bold", textColor=INK)
    meta_label_style = ParagraphStyle("QMetaLabel", parent=styles["Normal"], fontSize=8, leading=10, textColor=FAINT)
    meta_value_style = ParagraphStyle("QMetaValue", parent=styles["Normal"], fontSize=9, leading=11, textColor=INK)
    section_label_style = ParagraphStyle("QSectionLabel", parent=styles["Normal"], fontSize=9, leading=11, textColor=FAINT)
    total_style = ParagraphStyle("QTotal", parent=styles["Normal"], fontSize=11, leading=13, fontName="Helvetica-Bold", textColor=ACCENT)
    table_header_style = ParagraphStyle("QTHead", parent=styles["Normal"], fontSize=9, leading=11, fontName="Helvetica-Bold", textColor=INK)
    cell_style = ParagraphStyle("QCell", parent=styles["Normal"], fontSize=9, leading=11, textColor=INK)
    cell_faint_style = ParagraphStyle("QCellFaint", parent=styles["Normal"], fontSize=9, leading=11, textColor=FAINT)
    word_style = ParagraphStyle("QWord", parent=styles["Normal"], fontSize=9, leading=12, textColor=MUTED)
    total_row_style = ParagraphStyle("QTotalRow", parent=styles["Normal"], fontSize=10, leading=12, textColor=INK, alignment=TA_RIGHT)
    total_bold_style = ParagraphStyle("QTotalBold", parent=styles["Normal"], fontSize=12, leading=14, fontName="Helvetica-Bold", textColor=ACCENT, alignment=TA_RIGHT)
    panel_title_style = ParagraphStyle("QPanelTitle", parent=styles["Normal"], fontSize=9.5, leading=12, fontName="Helvetica-Bold", textColor=INK)
    panel_text_style = ParagraphStyle("QPanelText", parent=styles["Normal"], fontSize=8.5, leading=11.5, textColor=MUTED)
    footer_style = ParagraphStyle("QFooter", parent=styles["Normal"], fontSize=8, leading=10.5, textColor=FAINT, alignment=TA_CENTER)
    sig_caption_style = ParagraphStyle("QSigCaption", parent=styles["Normal"], fontSize=8.5, leading=11, textColor=MUTED, alignment=TA_CENTER)

    def meta_block(label, value):
        return [p(label, meta_label_style), p(value or "N/A", meta_value_style)]

    elements = []

    # ---- Gradient banner: mirrors the "estimate is ready" email header ----
    elements.append(_HeaderBanner(doc.width, 18 * mm, org_name))
    elements.append(Spacer(1, 5 * mm))

    # ---- Highlight: mirrors the email's "Estimate Total" highlight box ----
    total_block = [
        p("ESTIMATE TOTAL", ParagraphStyle("QTotalLabel", parent=styles["Normal"], fontSize=8, leading=10, fontName="Helvetica-Bold", textColor=MUTED)),
        Spacer(1, 1.5 * mm),
        p(_fmt_inr(total, currency), ParagraphStyle("QTotalValue", parent=styles["Normal"], fontSize=18, leading=21, fontName="Helvetica-Bold", textColor=INK)),
        Spacer(1, 1.5 * mm),
        p(f"Pricing valid until {valid_until}" if valid_until else "Pricing valid on receipt", ParagraphStyle("QTotalDue", parent=styles["Normal"], fontSize=9, leading=11, fontName="Helvetica-Bold", textColor=ORANGE)),
    ]
    total_box = Table([["", total_block]], colWidths=[1.5 * mm, doc.width - 1.5 * mm])
    total_box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), ACCENT),
        ("BACKGROUND", (1, 0), (1, 0), HIGHLIGHT_BG),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (0, 0), 0),
        ("RIGHTPADDING", (0, 0), (0, 0), 0),
        ("LEFTPADDING", (1, 0), (1, 0), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    elements.append(total_box)
    elements.append(Spacer(1, 5 * mm))

    # ---- Header: org block (left) + estimate meta (right) ----
    org_block = [p(org_name or "Zoiko Billing", org_name_style)]
    for line in org_lines:
        if line:
            org_block.append(p(line, org_line_style))
    org_cell = Table([[org_block]], colWidths=[95 * mm])
    org_cell.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))

    right_cells = []
    logo_flowable = _fetch_logo_flowable(org_logo_url, max_width_mm=30, max_height_mm=14)
    if logo_flowable is not None:
        logo_holder = Table([[logo_flowable]], colWidths=[70 * mm])
        logo_holder.setStyle(TableStyle([("ALIGN", (0, 0), (-1, -1), "RIGHT")]))
        right_cells.append(logo_holder)
    right_cells.append(p("Estimate", quote_label_style))
    right_cells.append(Spacer(1, 1 * mm))
    right_cells.append(p(quote_number, quote_number_style))
    right_cells.append(Spacer(1, 3 * mm))
    right_cells.append(Table(
        [meta_block("Reference", reference), meta_block("Currency", currency)],
        colWidths=[35 * mm, 35 * mm],
        hAlign="RIGHT",
    ))
    right_cells.append(Spacer(1, 1 * mm))
    right_meta = Table([[right_cells]], colWidths=[72 * mm])
    right_meta.setStyle(TableStyle([
        ("ALIGN", (0, 0), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))

    header_table = Table([[org_cell, right_meta]], colWidths=[95 * mm, 72 * mm])
    header_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    elements.append(header_table)
    elements.append(Spacer(1, 4 * mm))
    elements.append(HRFlowable(width="100%", thickness=0.75, color=BORDER))
    elements.append(Spacer(1, 4 * mm))

    # ---- Bill To (left) + meta grid (right) ----
    bill_block = [p("Bill To", section_label_style), Spacer(1, 1.5 * mm)]
    bill_block.append(p(customer_name or "", ParagraphStyle("QCustName", parent=org_line_style, fontName="Helvetica-Bold", textColor=INK, fontSize=9.5, leading=12)))
    for line in customer_lines:
        if line:
            bill_block.append(p(line, org_line_style))
    bill_cell = Table([[bill_block]], colWidths=[95 * mm])
    bill_cell.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))

    meta_grid = Table([
        meta_block("Issue Date", issue_date),
        meta_block("Valid Until", valid_until),
        meta_block("Status", status_label),
        [p("Total", meta_label_style), p(_fmt_inr(total, currency), total_style)],
    ], colWidths=[36 * mm, 36 * mm])
    meta_grid.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LEFTPADDING", (0, 0), (-1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("BACKGROUND", (0, 0), (-1, -1), PANEL),
    ]))
    meta_cell = Table([[meta_grid]], colWidths=[72 * mm])
    meta_cell.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))

    billto_table = Table([[bill_cell, meta_cell]], colWidths=[95 * mm, 72 * mm])
    billto_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    elements.append(billto_table)
    elements.append(Spacer(1, 5 * mm))

    # ---- Items table ----
    code_w, desc_w, hsn_w, qty_w, price_w, tax_w, total_w = 20, 44, 18, 12, 26, 20, 27
    item_col_widths = [code_w, desc_w, hsn_w, qty_w, price_w, tax_w, total_w]
    table_data = [
        [p("Code", table_header_style), p("Description", table_header_style), p("HSN/SAC", table_header_style),
         p("Qty", table_header_style), p("Unit Price", table_header_style), p("Tax", table_header_style), p("Total", table_header_style)],
    ]
    for row in item_rows:
        table_data.append([
            p(str(row.get("code") or ""), cell_faint_style),
            p(str(row.get("description") or ""), cell_style),
            p(str(row.get("hsn") or ""), cell_faint_style),
            p(str(row.get("qty") or "1"), cell_style),
            p(_fmt_inr(row.get("unit_price"), currency), cell_style),
            p(_fmt_inr(row.get("tax"), currency), cell_style),
            p(_fmt_inr(row.get("total"), currency), cell_style),
        ])
    items_table = Table(table_data, colWidths=[w * mm for w in item_col_widths], repeatRows=1, hAlign="LEFT")
    items_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), PANEL),
        ("LINEBELOW", (0, 0), (-1, 0), 0.75, BORDER),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, ZEBRA]),
        ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (3, 0), (6, -1), "RIGHT"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]))
    elements.append(items_table)
    elements.append(Spacer(1, 4 * mm))

    # ---- Amount in words (left) + totals (right) ----
    words_block = [
        p("Amount in words", section_label_style),
        Spacer(1, 2 * mm),
        p(_number_to_words_in(total), word_style),
    ]
    words_cell = Table([[words_block]], colWidths=[80 * mm])
    words_cell.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))

    totals_rows = [
        [p("Subtotal", total_row_style), p(_fmt_inr(subtotal, currency), total_row_style)],
    ]
    if discount and float(discount or 0) != 0:
        totals_rows.append([p("Discount", total_row_style), p(_fmt_inr(discount, currency), total_row_style)])
    totals_rows.append([p("Tax", total_row_style), p(_fmt_inr(tax, currency), total_row_style)])
    totals_rows.append([p("Total", total_bold_style), p(_fmt_inr(total, currency), total_bold_style)])
    totals_table = Table(totals_rows, colWidths=[40 * mm, 55 * mm], hAlign="RIGHT")
    totals_table.setStyle(TableStyle([
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LEFTPADDING", (0, 0), (-1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2),
    ]))
    totals_cell = Table([[totals_table]], colWidths=[87 * mm])
    totals_cell.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ALIGN", (0, 0), (-1, -1), "RIGHT"),
    ]))

    words_total = Table([[words_cell, totals_cell]], colWidths=[80 * mm, 87 * mm])
    words_total.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    elements.append(words_total)
    elements.append(Spacer(1, 4 * mm))

    # ---- Terms & Conditions (render only when present) ----
    if terms_list:
        terms_children = [p("Terms & Conditions", panel_title_style), Spacer(1, 2 * mm)]
        for t in terms_list:
            terms_children.append(p(f"-  {t}", panel_text_style))
        panel = Table([[terms_children]], colWidths=[167 * mm])
        panel.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), PANEL),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("BOX", (0, 0), (-1, -1), 0.5, BORDER),
        ]))
        elements.append(panel)
        elements.append(Spacer(1, 3 * mm))

    # ---- Signature ----
    sig = Table([[
        Spacer(1, 0),
        Table([
            [HRFlowable(width="100%", thickness=0.75, color=BORDER)],
            [p("Authorized Signatory", sig_caption_style)],
        ], colWidths=[55 * mm], hAlign="RIGHT"),
    ]], colWidths=[112 * mm, 55 * mm])
    sig.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    elements.append(sig)

    # ---- Footer ----
    if org_footer_lines:
        elements.append(Spacer(1, 8 * mm))
        elements.append(HRFlowable(width="100%", thickness=0.5, color=BORDER))
        elements.append(Spacer(1, 4 * mm))
        for line in org_footer_lines:
            if line:
                elements.append(p(line, footer_style))

    if notes:
        elements.append(Spacer(1, 4 * mm))
        elements.append(HRFlowable(width="100%", thickness=0.5, color=BORDER))
        elements.append(Spacer(1, 2.5 * mm))
        elements.append(p(notes, footer_style))

    doc.build(
        elements,
        onFirstPage=lambda c, d: _draw_page_background(c, d),
        onLaterPages=lambda c, d: _draw_page_background(c, d),
    )
    return buffer.getvalue()


def generate_invoice_pdf(invoice, customer, items, org_config=None, db=None) -> bytes:
    """Render an invoice PDF matching the on-screen React preview design.
    `items` is a list of InvoiceItem rows; `db` is optional and only used to
    look up product codes / HSN for the items table."""
    org_name = getattr(org_config, "company_name", None) or ""
    if not org_name and db is not None:
        from app.modules.organizations.models import Organization
        org_id = getattr(org_config, "organization_id", None)
        if org_id:
            # Query only columns that exist in the live schema — the model also
            # maps a legacy `name` column that was never created in the DB.
            row = db.query(Organization.organization_name, Organization.display_name).filter(
                Organization.id == org_id
            ).first()
            if row:
                org_name = row.organization_name or row.display_name or ""
    org_name = org_name or "Zoiko Billing"
    org_logo_url = getattr(org_config, "invoice_logo_url", None) or getattr(org_config, "logo_url", None)

    org_gstin = (getattr(org_config, "gst_number", None) or getattr(org_config, "vat_number", None)
                 or getattr(org_config, "business_registration_number", None))
    org_phone = getattr(org_config, "billing_phone", None) or getattr(org_config, "phone", None)
    org_email = getattr(org_config, "billing_email", None) or getattr(org_config, "email", None)
    org_website = getattr(org_config, "website", None)
    # Address lines only here (unlike _org_address_lines, used by the other
    # document types) — website/GSTIN are appended below with their own
    # labeling/combining, so pulling them from _org_address_lines too would
    # print each one twice.
    org_lines = [
        getattr(org_config, "address_line1", None),
        getattr(org_config, "address_line2", None),
        ", ".join(filter(None, [
            getattr(org_config, "city", None),
            getattr(org_config, "state", None),
            getattr(org_config, "postal_code", None),
        ])),
        getattr(org_config, "country", None),
    ]
    org_lines = [l for l in org_lines if l]
    if org_email and org_phone:
        org_lines.append(f"{org_email}, {org_phone}")
    elif org_email or org_phone:
        org_lines.append(org_email or org_phone)
    if org_website:
        org_lines.append(org_website)
    if org_gstin:
        org_lines.append(f"GSTIN: {org_gstin}")

    customer_name = getattr(customer, "display_name", None) or getattr(customer, "company_name", "")
    customer_gstin = getattr(customer, "gst_number", None) or getattr(customer, "vat_number", None)
    customer_phone = getattr(customer, "phone", None) or getattr(customer, "mobile", None)
    customer_email = getattr(customer, "email", None)
    customer_lines = [
        getattr(customer, "billing_address", None),
        getattr(customer, "billing_country", None),
    ]
    customer_lines = [l for l in customer_lines if l]
    if customer_email and customer_phone:
        customer_lines.append(f"{customer_email}, {customer_phone}")
    elif customer_email or customer_phone:
        customer_lines.append(customer_email or customer_phone)
    if customer_gstin:
        customer_lines.append(f"GSTIN: {customer_gstin}")

    currency = invoice.currency or "USD"
    invoice_label = "Invoice"
    payment_terms = ""
    if getattr(invoice, "payment_terms", None):
        payment_terms = invoice.payment_terms.replace("_", " ").title()

    # Product codes / HSN lookup (optional, requires db).
    product_lookup = {}
    if db is not None:
        try:
            from app.modules.billing.models import Product
            product_ids = {getattr(i, "product_id", None) for i in items}
            product_ids.discard(None)
            if product_ids:
                for prod in db.query(Product).filter(Product.id.in_(product_ids)).all():
                    product_lookup[prod.id] = {
                        "code": getattr(prod, "code", None),
                        "hsn": getattr(prod, "gst_vat_group", None) or getattr(prod, "hsn_code", None),
                    }
        except Exception:
            product_lookup = {}

    item_rows = []
    for item in items:
        prod = product_lookup.get(getattr(item, "product_id", None), {})
        item_rows.append({
            "code": prod.get("code"),
            "description": item.description,
            "hsn": prod.get("hsn"),
            "qty": str(item.quantity),
            "unit_price": item.unit_price,
            "tax": item.tax_amount,
            "total": item.total,
        })

    # Bank details are not scored in BillingConfiguration yet, so the section
    # is only rendered if a future caller supplies them via getattr.
    bank_rows = []
    for label, key in [
        ("Account Name", "bank_account_name"),
        ("Bank Name", "bank_name"),
        ("Account Number", "bank_account_number"),
        ("IFSC Code", "bank_ifsc"),
        ("UPI ID", "bank_upi_id"),
    ]:
        value = getattr(org_config, key, None)
        if value:
            bank_rows.append((label, value))

    terms_source = (getattr(org_config, "invoice_terms_and_conditions", None)
                    or getattr(org_config, "invoice_terms", None)
                    or getattr(invoice, "terms", None))
    terms_list = []
    if terms_source:
        terms_list = [t.strip() for t in str(terms_source).splitlines() if t.strip()]
    if not terms_list:
        terms_list = [
            "Payment is due within the terms stated on this invoice.",
            "Please include the invoice number with all payments.",
            "Queries about this invoice should be directed to the sender's billing contact.",
        ]

    notes = getattr(invoice, "notes", None)
    if not notes:
        notes = f"Thank you for your business. This is an automatically generated {invoice_label.lower()} from {org_name}."

    org_footer_lines = [
        f"{org_name} via Zoiko Billing",
        _org_legal_entity(org_config, org_name),
        _org_billing_address(org_config),
        getattr(org_config, "billing_phone", None) or getattr(org_config, "phone", None),
    ]

    return _build_invoice_document(
        org_name=org_name,
        org_lines=org_lines,
        customer_name=customer_name,
        customer_lines=customer_lines,
        invoice_label=invoice_label,
        invoice_number=invoice.invoice_number or f"#{invoice.id}",
        po_number=getattr(invoice, "po_number", None),
        currency=currency,
        issue_date=_fmt_date(invoice.issue_date),
        due_date=_fmt_date(invoice.due_date),
        payment_terms=payment_terms,
        balance_due=invoice.balance_due if hasattr(invoice, "balance_due") else None,
        item_rows=item_rows,
        subtotal=invoice.subtotal,
        discount=invoice.discount_amount,
        tax=invoice.tax_amount,
        total=invoice.total_amount,
        amount_paid=invoice.paid_amount if hasattr(invoice, "paid_amount") else None,
        bank_rows=bank_rows,
        terms_list=terms_list,
        notes=notes,
        org_logo_url=org_logo_url,
        org_footer_lines=org_footer_lines,
    )


def generate_credit_note_pdf(credit_note, customer, org_config=None) -> bytes:
    """Render a simple, clean credit note PDF. Credit notes have no line
    items (a single lump-sum amount, unlike invoices/quotes) so the "items"
    table gets one synthetic row summarizing the credit."""
    org_name = getattr(org_config, "company_name", None) or "Zoiko Billing"
    org_address_lines = _org_address_lines(org_config)
    org_logo_url = getattr(org_config, "invoice_logo_url", None) or getattr(org_config, "logo_url", None)

    customer_address_lines = [
        getattr(customer, "billing_address", None),
        getattr(customer, "billing_country", None),
        getattr(customer, "email", None),
    ]

    currency = credit_note.currency or "USD"
    credit_note_type = credit_note.credit_note_type
    type_label = (credit_note_type.value if hasattr(credit_note_type, "value") else str(credit_note_type)).replace("_", " ").title()
    status = credit_note.status
    status_label = (status.value if hasattr(status, "value") else str(status)).replace("_", " ").title()

    detail_rows = [
        ("Issue Date", _fmt_date(credit_note.issue_date)),
        ("Type", type_label),
        ("Status", status_label),
    ]
    if getattr(credit_note, "invoice_id", None):
        detail_rows.append(("Against Invoice", f"#{credit_note.invoice_id}"))

    item_rows = [
        (credit_note.reason or "Credit note", "1", credit_note.subtotal, credit_note.tax_amount, credit_note.subtotal + (credit_note.tax_amount or 0) - (credit_note.discount_amount or 0)),
    ]

    return _build_document(
        title="Credit Note",
        document_number=credit_note.credit_note_number or f"#{credit_note.id}",
        accent_color="#DC2626",
        org_name=org_name,
        org_address_lines=org_address_lines,
        org_logo_url=org_logo_url,
        customer_name=getattr(customer, "display_name", None) or getattr(customer, "company_name", ""),
        customer_address_lines=customer_address_lines,
        detail_rows=detail_rows,
        item_rows=item_rows,
        currency=currency,
        subtotal=credit_note.subtotal,
        discount_amount=getattr(credit_note, "discount_amount", None),
        tax_amount=credit_note.tax_amount,
        total_amount=credit_note.total_amount,
        notes=getattr(credit_note, "reason", None),
        footer_text=getattr(org_config, "invoice_footer", None),
    )


def generate_refund_pdf(refund, customer, org_config=None) -> bytes:
    """Render a simple, clean refund receipt PDF. Refunds have no line items
    (a single lump-sum amount, like credit notes) so the "items" table gets
    one synthetic row summarizing the refund."""
    org_name = getattr(org_config, "company_name", None) or "Zoiko Billing"
    org_address_lines = _org_address_lines(org_config)
    org_logo_url = getattr(org_config, "invoice_logo_url", None) or getattr(org_config, "logo_url", None)

    customer_address_lines = [
        getattr(customer, "billing_address", None),
        getattr(customer, "billing_country", None),
        getattr(customer, "email", None),
    ]

    currency = refund.currency or "USD"
    refund_type = refund.refund_type
    type_label = (refund_type.value if hasattr(refund_type, "value") else str(refund_type)).replace("_", " ").title()
    refund_status = refund.status
    status_label = (refund_status.value if hasattr(refund_status, "value") else str(refund_status)).replace("_", " ").title()
    refund_method = getattr(refund, "refund_method", None)
    method_label = (refund_method.value if hasattr(refund_method, "value") else str(refund_method)).replace("_", " ").title() if refund_method else None

    detail_rows = [
        ("Refund Date", _fmt_date(refund.completed_at) or _fmt_date(refund.created_at)),
        ("Type", type_label),
        ("Status", status_label),
    ]
    if method_label:
        detail_rows.append(("Method", method_label))
    if getattr(refund, "payment_id", None):
        detail_rows.append(("Against Payment", f"#{refund.payment_id}"))
    if getattr(refund, "invoice_id", None):
        detail_rows.append(("Against Invoice", f"#{refund.invoice_id}"))
    if getattr(refund, "credit_note_id", None):
        detail_rows.append(("Against Credit Note", f"#{refund.credit_note_id}"))
    if getattr(refund, "reference_number", None):
        detail_rows.append(("Reference #", refund.reference_number))

    item_rows = [
        (refund.reason or "Refund", "1", refund.amount, 0, refund.amount),
    ]

    return _build_document(
        title="Refund Receipt",
        document_number=refund.refund_number or f"#{refund.id}",
        accent_color="#0EA5E9",
        org_name=org_name,
        org_address_lines=org_address_lines,
        org_logo_url=org_logo_url,
        customer_name=getattr(customer, "display_name", None) or getattr(customer, "company_name", ""),
        customer_address_lines=customer_address_lines,
        detail_rows=detail_rows,
        item_rows=item_rows,
        currency=currency,
        subtotal=refund.amount,
        discount_amount=0,
        tax_amount=0,
        total_amount=refund.amount,
        notes=getattr(refund, "reason", None),
        footer_text=getattr(org_config, "invoice_footer", None),
    )


def generate_write_off_pdf(write_off, customer, org_config=None) -> bytes:
    """Render a simple, clean write-off notice PDF. Write-offs have no line
    items (a single lump-sum amount, like credit notes/refunds) so the
    "items" table gets one synthetic row summarizing the write-off."""
    org_name = getattr(org_config, "company_name", None) or "Zoiko Billing"
    org_address_lines = _org_address_lines(org_config)
    org_logo_url = getattr(org_config, "invoice_logo_url", None) or getattr(org_config, "logo_url", None)

    customer_address_lines = [
        getattr(customer, "billing_address", None),
        getattr(customer, "billing_country", None),
        getattr(customer, "email", None),
    ]

    currency = write_off.currency or "USD"
    write_off_type = write_off.write_off_type
    type_label = (write_off_type.value if hasattr(write_off_type, "value") else str(write_off_type)).replace("_", " ").title()
    wo_status = write_off.status
    status_label = (wo_status.value if hasattr(wo_status, "value") else str(wo_status)).replace("_", " ").title()
    adjustment_type = getattr(write_off, "adjustment_type", None)
    adjustment_label = (adjustment_type.value if hasattr(adjustment_type, "value") else str(adjustment_type)).replace("_", " ").title() if adjustment_type else None

    detail_rows = [
        ("Write-off Date", _fmt_date(write_off.executed_at) or _fmt_date(write_off.created_at)),
        ("Type", type_label),
        ("Status", status_label),
    ]
    if adjustment_label:
        detail_rows.append(("Adjustment Type", adjustment_label))
    if getattr(write_off, "invoice_id", None):
        detail_rows.append(("Against Invoice", f"#{write_off.invoice_id}"))

    item_rows = [
        (write_off.reason or "Write-off", "1", write_off.amount, 0, write_off.amount),
    ]

    return _build_document(
        title="Write-off Notice",
        document_number=write_off.write_off_number or f"#{write_off.id}",
        accent_color="#B45309",
        org_name=org_name,
        org_address_lines=org_address_lines,
        org_logo_url=org_logo_url,
        customer_name=getattr(customer, "display_name", None) or getattr(customer, "company_name", ""),
        customer_address_lines=customer_address_lines,
        detail_rows=detail_rows,
        item_rows=item_rows,
        currency=currency,
        subtotal=write_off.amount,
        discount_amount=0,
        tax_amount=0,
        total_amount=write_off.amount,
        notes=getattr(write_off, "notes", None) or getattr(write_off, "reason", None),
        footer_text=getattr(org_config, "invoice_footer", None),
    )


def generate_quote_pdf(quote, customer, items, org_config=None, db=None) -> bytes:
    """Render an estimate/quote PDF matching the on-screen invoice preview's
    design language (`_build_quote_document`). `items` is a list of
    QuotationItem rows; `db` is optional and only used to look up product
    codes / HSN for the items table and the org name when unset."""
    org_name = getattr(org_config, "company_name", None) or ""
    if not org_name and db is not None:
        from app.modules.organizations.models import Organization
        org_id = getattr(org_config, "organization_id", None)
        if org_id:
            row = db.query(Organization.organization_name, Organization.display_name).filter(
                Organization.id == org_id
            ).first()
            if row:
                org_name = row.organization_name or row.display_name or ""
    org_name = org_name or "Zoiko Billing"
    org_logo_url = getattr(org_config, "invoice_logo_url", None) or getattr(org_config, "logo_url", None)

    org_gstin = (getattr(org_config, "gst_number", None) or getattr(org_config, "vat_number", None)
                 or getattr(org_config, "business_registration_number", None))
    org_phone = getattr(org_config, "billing_phone", None) or getattr(org_config, "phone", None)
    org_email = getattr(org_config, "billing_email", None) or getattr(org_config, "email", None)
    org_website = getattr(org_config, "website", None)
    org_lines = [
        getattr(org_config, "address_line1", None),
        getattr(org_config, "address_line2", None),
        ", ".join(filter(None, [
            getattr(org_config, "city", None),
            getattr(org_config, "state", None),
            getattr(org_config, "postal_code", None),
        ])),
        getattr(org_config, "country", None),
    ]
    org_lines = [l for l in org_lines if l]
    if org_email and org_phone:
        org_lines.append(f"{org_email}, {org_phone}")
    elif org_email or org_phone:
        org_lines.append(org_email or org_phone)
    if org_website:
        org_lines.append(org_website)
    if org_gstin:
        org_lines.append(f"GSTIN: {org_gstin}")

    customer_name = getattr(customer, "display_name", None) or getattr(customer, "company_name", "")
    customer_gstin = getattr(customer, "gst_number", None) or getattr(customer, "vat_number", None)
    customer_phone = getattr(customer, "phone", None) or getattr(customer, "mobile", None)
    customer_email = getattr(customer, "email", None)
    customer_lines = [
        getattr(customer, "billing_address", None),
        getattr(customer, "billing_country", None),
    ]
    customer_lines = [l for l in customer_lines if l]
    if customer_email and customer_phone:
        customer_lines.append(f"{customer_email}, {customer_phone}")
    elif customer_email or customer_phone:
        customer_lines.append(customer_email or customer_phone)
    if customer_gstin:
        customer_lines.append(f"GSTIN: {customer_gstin}")

    currency = quote.currency or "USD"
    status = quote.status
    status_label = (status.value if hasattr(status, "value") else str(status)).replace("_", " ").title()

    # Product codes / HSN lookup (optional, requires db) — mirrors the invoice PDF.
    product_lookup = {}
    if db is not None:
        try:
            from app.modules.billing.models import Product
            product_ids = {getattr(i, "product_id", None) for i in items}
            product_ids.discard(None)
            if product_ids:
                for prod in db.query(Product).filter(Product.id.in_(product_ids)).all():
                    product_lookup[prod.id] = {
                        "code": getattr(prod, "code", None),
                        "hsn": getattr(prod, "gst_vat_group", None) or getattr(prod, "hsn_code", None),
                    }
        except Exception:
            product_lookup = {}

    item_rows = []
    for item in items:
        prod = product_lookup.get(getattr(item, "product_id", None), {})
        item_rows.append({
            "code": prod.get("code"),
            "description": item.description,
            "hsn": prod.get("hsn"),
            "qty": str(item.quantity),
            "unit_price": item.unit_price,
            "tax": item.tax_amount,
            "total": item.total_amount,
        })

    terms_source = (getattr(org_config, "invoice_terms_and_conditions", None)
                    or getattr(org_config, "invoice_terms", None)
                    or getattr(quote, "terms", None))
    terms_list = []
    if terms_source:
        terms_list = [t.strip() for t in str(terms_source).splitlines() if t.strip()]

    notes = getattr(quote, "notes", None)
    if not notes:
        notes = f"Thank you for your interest. This is an automatically generated estimate from {org_name}."

    org_footer_lines = [
        f"{org_name} via Zoiko Billing",
        _org_legal_entity(org_config, org_name),
        _org_billing_address(org_config),
        getattr(org_config, "billing_phone", None) or getattr(org_config, "phone", None),
    ]

    return _build_quote_document(
        org_name=org_name,
        org_lines=org_lines,
        customer_name=customer_name,
        customer_lines=customer_lines,
        quote_number=quote.quote_number or f"#{quote.id}",
        reference=getattr(quote, "subject", None),
        currency=currency,
        issue_date=_fmt_date(quote.created_at),
        valid_until=_fmt_date(quote.valid_until) or "N/A",
        status_label=status_label,
        item_rows=item_rows,
        subtotal=quote.subtotal,
        discount=quote.discount_amount,
        tax=quote.tax_amount,
        total=quote.total_amount,
        terms_list=terms_list,
        notes=notes,
        org_logo_url=org_logo_url,
        org_footer_lines=org_footer_lines,
    )
