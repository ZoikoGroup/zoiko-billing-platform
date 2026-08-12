from decimal import Decimal
from typing import Optional, Tuple, Dict, Any, List
from app.modules.billing.models import TaxRate
from app.modules.billing.utils.currency_utils import round_money, percentage_of

class CalculationService:
    @staticmethod
    def calculate_line_item(
        quantity: Decimal,
        unit_price: Decimal,
        discount_percentage: Decimal = Decimal('0'),
        discount_amount_fixed: Decimal = Decimal('0'),
        tax_percentage: Decimal = Decimal('0'),
        exchange_rate: Decimal = Decimal('1.0'),
        is_tax_inclusive: bool = False,
        price_semantics: str = 'unit'
    ) -> Dict[str, Decimal]:
        """
        Calculates a line item's totals exactly like a production ERP.
        Order of operations:
        1. Subtotal = Quantity * Unit Price
        2. Discount = (Subtotal * discount_percentage / 100) + discount_amount_fixed
        3. Taxable Amount = Subtotal - Discount
        4. Tax Amount = Taxable Amount * (tax_percentage / 100)
        5. Total = Taxable Amount + Tax Amount

        price_semantics:
          - 'unit'           (default): unit_price is per-unit, subtotal = qty * price
          - 'lump_sum'       : unit_price is the full line price regardless of qty
          - 'graduated_total': unit_price is the already-computed graduated total
                               for the line's quantity (never multiplied again)

        All calculations are done in the original currency, then converted if needed.
        """
        quantity = Decimal(str(quantity))
        unit_price = Decimal(str(unit_price))
        discount_percentage = Decimal(str(discount_percentage))
        discount_amount_fixed = Decimal(str(discount_amount_fixed))
        tax_percentage = Decimal(str(tax_percentage))
        exchange_rate = Decimal(str(exchange_rate))

        # 1. Base Subtotal
        if price_semantics in ('lump_sum', 'graduated_total'):
            original_subtotal = unit_price
        else:
            original_subtotal = quantity * unit_price
        
        # 2. Discount
        # Cap the discount so it can never flip the line's sign — the cap must
        # itself be sign-aware, since ">" alone only caps correctly when
        # original_subtotal is >= 0. For a negative subtotal (a credit/adjustment
        # line), "0 > original_subtotal" is trivially true, so an uncapped ">"
        # check would wrongly treat a *zero* discount as exceeding the subtotal
        # and zero out the entire line.
        pct_discount_amt = percentage_of(original_subtotal, discount_percentage)
        total_discount_original = pct_discount_amt + discount_amount_fixed
        if original_subtotal >= 0:
            if total_discount_original > original_subtotal:
                total_discount_original = original_subtotal
        else:
            if total_discount_original < original_subtotal:
                total_discount_original = original_subtotal
            
        # 3. Taxable Base
        taxable_amount_original = original_subtotal - total_discount_original
        
        # 4. Tax (exclusive vs inclusive)
        if is_tax_inclusive and tax_percentage > 0:
            # Tax-inclusive: price already includes tax, extract the base
            # base = inclusive_amount / (1 + rate/100)
            # tax = inclusive_amount - base
            divisor = Decimal('1') + tax_percentage / Decimal('100')
            taxable_amount_original = taxable_amount_original / divisor
            tax_amount_original = percentage_of(taxable_amount_original, tax_percentage)
        else:
            # Tax-exclusive: tax is added on top
            tax_amount_original = percentage_of(taxable_amount_original, tax_percentage)

        # 5. Line Total
        line_total_original = taxable_amount_original + tax_amount_original
        
        # Convert to target currency
        return {
            "original_quantity": quantity,
            "original_unit_price": unit_price,
            "original_subtotal": original_subtotal,
            "original_discount": total_discount_original,
            "original_taxable_amount": taxable_amount_original,
            "original_tax_amount": tax_amount_original,
            "original_line_total": line_total_original,
            "converted_unit_price": unit_price * exchange_rate,
            "converted_subtotal": original_subtotal * exchange_rate,
            "converted_discount": total_discount_original * exchange_rate,
            "converted_taxable_amount": taxable_amount_original * exchange_rate,
            "converted_tax_amount": tax_amount_original * exchange_rate,
            "converted_line_total": line_total_original * exchange_rate,
            "exchange_rate_used": exchange_rate,
            "is_tax_inclusive": is_tax_inclusive
        }

    @staticmethod
    def summarize_invoice(line_items_data: list) -> Dict[str, Decimal]:
        """
        Takes a list of line item calculation dictionaries and sums them up.
        """
        summary = {
            "total_original_subtotal": Decimal('0'),
            "total_original_discount": Decimal('0'),
            "total_original_tax": Decimal('0'),
            "total_original_grand": Decimal('0'),
            "total_converted_subtotal": Decimal('0'),
            "total_converted_discount": Decimal('0'),
            "total_converted_tax": Decimal('0'),
            "total_converted_grand": Decimal('0')
        }
        for item in line_items_data:
            summary["total_original_subtotal"] += item.get("original_subtotal", Decimal('0'))
            summary["total_original_discount"] += item.get("original_discount", Decimal('0'))
            summary["total_original_tax"] += item.get("original_tax_amount", Decimal('0'))
            summary["total_original_grand"] += item.get("original_line_total", Decimal('0'))
            
            summary["total_converted_subtotal"] += item.get("converted_subtotal", Decimal('0'))
            summary["total_converted_discount"] += item.get("converted_discount", Decimal('0'))
            summary["total_converted_tax"] += item.get("converted_tax_amount", Decimal('0'))
            summary["total_converted_grand"] += item.get("converted_line_total", Decimal('0'))

        return summary

    @staticmethod
    def summarize_document_totals(
        items: List[Dict[str, Any]],
        discount_percentage: Decimal = Decimal("0"),
        currency: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Single source of truth for "line items -> document totals" used by both
        invoices and quotations (contracts/subscriptions feed invoices through the
        same path). Order of operations: line items (subtotal/discount/tax per
        CalculationService.calculate_line_item) -> sum -> subtotal after line
        discounts -> document-level discount on top -> grand total.

        Returns rounded (round_money) subtotal/discount_amount/tax_amount/total_amount
        plus a per-item breakdown ("items", each with the item's original list index
        and its rounded total/discount/tax) so a caller can persist both the document
        header and its line items from one calculation.
        """
        line_items_data = []
        computed_items = []
        for i, item in enumerate(items):
            qty = Decimal(str(item.get("quantity", 1)))
            price = Decimal(str(item.get("unit_price", 0)))
            disc_pct = Decimal(str(item.get("discount_percentage", 0)))
            tax_pct = Decimal(str(item.get("tax_percentage", 0)))
            is_tax_inclusive = bool(item.get("is_tax_inclusive", False))
            rate = Decimal(str(item.get("exchange_rate", 1)))
            semantics = item.get("price_semantics", "unit")
            res = CalculationService.calculate_line_item(
                qty, price, disc_pct, tax_percentage=tax_pct, exchange_rate=rate,
                is_tax_inclusive=is_tax_inclusive, price_semantics=semantics,
            )
            line_items_data.append(res)
            computed_items.append({
                "index": i,
                "total_amount": round_money(res["converted_line_total"], currency),
                "discount_amount": round_money(res["converted_discount"], currency),
                "tax_amount": round_money(res["converted_tax_amount"], currency),
            })

        summary = CalculationService.summarize_invoice(line_items_data)
        subtotal_before_discount = summary["total_converted_subtotal"]
        line_discount_total = summary["total_converted_discount"]
        tax_amount = summary["total_converted_tax"]
        grand_total = summary["total_converted_grand"]

        # Subtotal after line discounts, then apply the document-level discount on top.
        subtotal = subtotal_before_discount - line_discount_total
        doc_discount = percentage_of(subtotal, discount_percentage)
        total_amount = grand_total - doc_discount
        discount_amount = line_discount_total + doc_discount

        return {
            "subtotal": round_money(subtotal, currency),
            "discount_amount": round_money(discount_amount, currency),
            "tax_amount": round_money(tax_amount, currency),
            "total_amount": round_money(total_amount, currency),
            "items": computed_items,
        }
