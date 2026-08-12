/**
 * Calculation Engine for Billing Module
 * 
 * This utility mirrors the backend `CalculationService` to ensure
 * the frontend exactly matches the backend math logic for Subtotal,
 * Discount, Taxable Amount, Tax Amount, and Grand Total.
 * 
 * Rule of Thumb:
 * 1. Math is always done in the original currency first.
 * 2. Discounts subtract from the subtotal BEFORE taxes are calculated.
 * 3. Conversions happen strictly as a final multiplication step.
 */

export const CalculationEngine = {
  calculateLineItem: (
    quantity,
    unitPrice,
    discountPercentage = 0,
    discountAmountFixed = 0,
    taxPercentage = 0,
    exchangeRate = 1.0,
    isTaxInclusive = false
  ) => {
    const qty = parseFloat(quantity) || 0;
    const price = parseFloat(unitPrice) || 0;
    const discPct = parseFloat(discountPercentage) || 0;
    const discFixed = parseFloat(discountAmountFixed) || 0;
    const taxPct = parseFloat(taxPercentage) || 0;
    const rate = parseFloat(exchangeRate) || 1.0;

    // 1. Base Subtotal
    const originalSubtotal = qty * price;

    // 2. Discount
    const pctDiscountAmt = (originalSubtotal * discPct) / 100;
    let totalDiscountOriginal = pctDiscountAmt + discFixed;
    if (totalDiscountOriginal > originalSubtotal) {
      totalDiscountOriginal = originalSubtotal;
    }

    // 3. Taxable Base
    let taxableAmountOriginal = originalSubtotal - totalDiscountOriginal;

    // 4. Tax (exclusive vs inclusive)
    let taxAmountOriginal;
    let taxableAmountForTax = taxableAmountOriginal;
    if (isTaxInclusive && taxPct > 0) {
      // Tax-inclusive: price already includes tax, extract the base
      const divisor = 1 + taxPct / 100;
      taxableAmountForTax = taxableAmountOriginal / divisor;
      taxAmountOriginal = taxableAmountForTax * taxPct / 100;
      taxableAmountOriginal = taxableAmountForTax;
    } else {
      // Tax-exclusive: tax is added on top
      taxAmountOriginal = (taxableAmountOriginal * taxPct) / 100;
    }

    // 5. Line Total
    const lineTotalOriginal = taxableAmountOriginal + taxAmountOriginal;

    // Convert to target currency
    return {
      originalQuantity: qty,
      originalUnitPrice: price,
      originalSubtotal: originalSubtotal,
      originalDiscount: totalDiscountOriginal,
      originalTaxableAmount: taxableAmountOriginal,
      originalTaxAmount: taxAmountOriginal,
      originalLineTotal: lineTotalOriginal,
      
      convertedUnitPrice: price * rate,
      convertedSubtotal: originalSubtotal * rate,
      convertedDiscount: totalDiscountOriginal * rate,
      convertedTaxableAmount: taxableAmountOriginal * rate,
      convertedTaxAmount: taxAmountOriginal * rate,
      convertedLineTotal: lineTotalOriginal * rate,
      
      exchangeRateUsed: rate
    };
  },

  summarizeInvoice: (lineItemsData, invoiceDiscountPercentage = 0) => {
    let summary = {
      totalOriginalSubtotal: 0,
      totalOriginalDiscount: 0,
      totalOriginalTax: 0,
      totalOriginalGrand: 0,
      
      totalConvertedSubtotal: 0,
      totalConvertedDiscount: 0,
      totalConvertedTax: 0,
      totalConvertedGrand: 0
    };

    lineItemsData.forEach(item => {
      summary.totalOriginalSubtotal += item.originalSubtotal || 0;
      summary.totalOriginalDiscount += item.originalDiscount || 0;
      summary.totalOriginalTax += item.originalTaxAmount || 0;
      summary.totalOriginalGrand += item.originalLineTotal || 0;

      summary.totalConvertedSubtotal += item.convertedSubtotal || 0;
      summary.totalConvertedDiscount += item.convertedDiscount || 0;
      summary.totalConvertedTax += item.convertedTaxAmount || 0;
      summary.totalConvertedGrand += item.convertedLineTotal || 0;
    });

    // Apply invoice level discount on subtotal AFTER line discounts (matches backend)
    const subtotalAfterLineDiscounts = summary.totalConvertedSubtotal - summary.totalConvertedDiscount;
    const invDiscount = (subtotalAfterLineDiscounts * (parseFloat(invoiceDiscountPercentage) || 0)) / 100;
    const finalTotal = summary.totalConvertedGrand - invDiscount;

    return {
      ...summary,
      invoiceLevelDiscount: invDiscount,
      finalGrandTotal: finalTotal
    };
  },
  
  calculateInvoiceTotals: (items, discountPercentage = 0, shippingAmount = 0, roundOff = 0) => {
    // unit_price is ALWAYS in invoice currency (already converted if needed).
    // Calculate directly without exchange rate multiplication.
    const calculatedItems = items.map(item => {
        const qty = parseFloat(item.quantity) || 0;
        const price = parseFloat(item.unit_price) || 0;
        const discPct = parseFloat(item.discount_percentage) || 0;
        const taxPct = parseFloat(item.tax_percentage) || 0;

        const subtotal = qty * price;
        const discountAmt = (subtotal * discPct) / 100;
        let taxable = subtotal - discountAmt;
        let lineTotal;
        let taxAmt;
        if (item.is_tax_inclusive && taxPct > 0) {
          const divisor = 1 + taxPct / 100;
          const taxableBase = taxable / divisor;
          const taxAmtIncl = taxableBase * taxPct / 100;
          lineTotal = taxable; // total stays the same, tax is extracted
          taxAmt = taxAmtIncl;
          taxable = taxableBase;
        } else {
          taxAmt = (taxable * taxPct) / 100;
          lineTotal = taxable + taxAmt;
        }

        return {
          convertedSubtotal: subtotal,
          convertedDiscount: discountAmt,
          convertedTaxAmount: taxAmt,
          convertedLineTotal: lineTotal,
        };
    });

    let totalConvertedSubtotal = 0;
    let totalConvertedDiscount = 0;
    let totalConvertedTax = 0;

    calculatedItems.forEach(item => {
      totalConvertedSubtotal += item.convertedSubtotal;
      totalConvertedDiscount += item.convertedDiscount;
      totalConvertedTax += item.convertedTaxAmount;
    });

    const invDiscount = ((totalConvertedSubtotal - totalConvertedDiscount) * (parseFloat(discountPercentage) || 0)) / 100;
    const ship = parseFloat(shippingAmount) || 0;
    const rnd = parseFloat(roundOff) || 0;
    const grandTotal = totalConvertedSubtotal - totalConvertedDiscount - invDiscount + totalConvertedTax + ship + rnd;

    return {
      subtotal: totalConvertedSubtotal,
      discount: invDiscount + totalConvertedDiscount,
      tax: totalConvertedTax,
      shipping: ship,
      roundOff: rnd,
      grandTotal: grandTotal
    };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Convenience helpers used by the invoice wizard UI.
// These delegate to CalculationEngine — NO logic is duplicated here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the subtotal (quantity × converted unit price) for a line-item object.
 * unit_price is always in invoice currency (already converted).
 * @param {object} item - A lineItems array element from the wizard state.
 */
export const calcItemTotal = (item) => {
  const qty = parseFloat(item.quantity) || 0;
  const price = parseFloat(item.unit_price) || 0;
  return qty * price;
};

/**
 * Returns the discount amount (converted) for a line-item object.
 * @param {object} item - A lineItems array element from the wizard state.
 */
export const calcItemDiscount = (item) => {
  const qty = parseFloat(item.quantity) || 0;
  const price = parseFloat(item.unit_price) || 0;
  const discPct = parseFloat(item.discount_percentage) || 0;
  const subtotal = qty * price;
  return (subtotal * discPct) / 100;
};

/**
 * Returns the net amount (subtotal − discount + tax, converted) for a line-item.
 * This is what appears as the "Amount" column in the invoice wizard.
 *
 * Must mirror CalculationEngine.calculateInvoiceTotals()'s per-item math
 * exactly — including the is_tax_inclusive branch — otherwise this column
 * disagrees with its own contribution to the wizard's grand-total footer
 * for any tax-inclusive line item.
 * @param {object} item - A lineItems array element from the wizard state.
 */
export const calcItemNet = (item) => {
  const qty = parseFloat(item.quantity) || 0;
  const price = parseFloat(item.unit_price) || 0;
  const discPct = parseFloat(item.discount_percentage) || 0;
  const taxPct = parseFloat(item.tax_percentage) || 0;
  const subtotal = qty * price;
  const discountAmt = (subtotal * discPct) / 100;
  const taxable = subtotal - discountAmt;
  if (item.is_tax_inclusive && taxPct > 0) {
    // Tax-inclusive: the line's total is the taxable amount itself — tax is
    // extracted from it, not added on top.
    return taxable;
  }
  const taxAmt = (taxable * taxPct) / 100;
  return taxable + taxAmt;
};
