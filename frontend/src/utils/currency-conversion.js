/**
 * Currency Conversion Utility for Billing Reports
 * 
 * Converts transaction amounts to the organization's base/reporting currency
 * using stored exchange-rate snapshots from each transaction.
 * 
 * Policy:
 * - Historical reports use the exchange rate stored on the transaction
 * - Never use today's rate to recalculate historical transactions
 * - If no exchange rate is available, exclude the amount and log a warning
 * - If transaction currency == base currency, rate = 1
 */

/**
 * Convert a single amount to base currency.
 * @param {number} amount - The transaction amount
 * @param {string} transactionCurrency - Currency of the transaction (e.g., "USD", "INR")
 * @param {string} baseCurrency - Organization's base/reporting currency
 * @param {number|null} storedExchangeRate - Exchange rate stored on the transaction
 * @returns {{ convertedAmount: number, rateUsed: number, isReliable: boolean }}
 */
export function convertToBaseCurrency(amount, transactionCurrency, baseCurrency, storedExchangeRate = null) {
  const amt = parseFloat(amount) || 0;
  const txnCurr = (transactionCurrency || "").toUpperCase().trim();
  const baseCurr = (baseCurrency || "").toUpperCase().trim();

  // Same currency — no conversion needed
  if (txnCurr === baseCurr) {
    return { convertedAmount: amt, rateUsed: 1, isReliable: true };
  }

  // No amount to convert
  if (amt === 0) {
    return { convertedAmount: 0, rateUsed: 1, isReliable: true };
  }

  // Use stored exchange rate from the transaction snapshot
  const rate = parseFloat(storedExchangeRate);
  if (rate && rate > 0) {
    return { convertedAmount: amt * rate, rateUsed: rate, isReliable: true };
  }

  // No exchange rate available — cannot reliably convert
  // Return 0 with isReliable=false so callers can handle appropriately
  console.warn(
    `Cannot convert ${txnCurr} to ${baseCurr}: no stored exchange rate. Amount ${amt} excluded from aggregate.`
  );
  return { convertedAmount: 0, rateUsed: 0, isReliable: false };
}

/**
 * Sum amounts across mixed currencies, converting to base currency.
 * @param {Array<{ amount: number, currency?: string, exchange_rate?: number }>} transactions
 * @param {string} baseCurrency - Organization's base/reporting currency
 * @returns {{ total: number, convertedCount: number, excludedCount: number, unconvertedAmounts: number }}
 */
export function sumInBaseCurrency(transactions, baseCurrency) {
  let total = 0;
  let convertedCount = 0;
  let excludedCount = 0;
  let unconvertedAmount = 0;

  for (const txn of transactions) {
    const amt = parseFloat(txn.total_amount || txn.total || txn.amount || txn.revenue || 0);
    if (!amt) continue;

    const { convertedAmount, isReliable } = convertToBaseCurrency(
      amt,
      txn.currency || baseCurrency,
      baseCurrency,
      txn.exchange_rate ?? null
    );

    if (isReliable) {
      total += convertedAmount;
      convertedCount++;
    } else {
      excludedCount++;
      unconvertedAmount += amt;
    }
  }

  return { total, convertedCount, excludedCount, unconvertedAmount };
}

/**
 * Group transactions by currency and sum each group.
 * @param {Array<{ amount: number, currency?: string }>} transactions
 * @returns {{ [currency: string]: number }}
 */
export function sumByCurrency(transactions) {
  const groups = {};
  for (const txn of transactions) {
    const curr = (txn.currency || "UNKNOWN").toUpperCase();
    const amt = parseFloat(txn.total_amount || txn.total || txn.amount || 0);
    groups[curr] = (groups[curr] || 0) + amt;
  }
  return groups;
}
