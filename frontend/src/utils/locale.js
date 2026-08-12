import { CURRENCY_MASTER } from './currency';
import { LANGUAGE_MASTER } from './language';

export function getLocaleForCurrency(currencyCode) {
  const info = CURRENCY_MASTER[currencyCode];
  return info ? info.locale : 'en-US';
}

export function getLocaleForLanguage(langCode) {
  const info = LANGUAGE_MASTER[langCode];
  return info ? info.locale : 'en-US';
}

export function getEffectiveLocale(langCode, currencyCode) {
  const langLocale = getLocaleForLanguage(langCode);
  const currencyLocale = getLocaleForCurrency(currencyCode);
  return currencyLocale || langLocale || 'en-US';
}

export function getLanguageName(langCode) {
  const info = LANGUAGE_MASTER[langCode];
  return info ? `${info.nameNative} (${info.name})` : langCode;
}

export function getCurrencyName(currencyCode) {
  const info = CURRENCY_MASTER[currencyCode];
  return info ? `${info.flag} ${info.name} (${info.code})` : currencyCode;
}

export function formatNumber(amount, locale = 'en-US', precision = 2) {
  if (amount === null || amount === undefined) return '';
  try {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    }).format(amount);
  } catch {
    return Number(amount).toFixed(precision);
  }
}

export function formatCurrency(amount, currencyCode, locale = 'en-US', position = 'before') {
  const cleanCurrency = currencyCode || 'USD';
  const info = CURRENCY_MASTER[cleanCurrency] || { symbol: '$', decimalDigits: 2, locale: 'en-US' };
  const symbol = info.symbol || '$';
  const precision = typeof info.decimalDigits === 'number' ? info.decimalDigits : 2;
  const numLocale = info.locale || locale || 'en-US';

  let cleanAmount = 0;
  if (amount !== null && amount !== undefined && amount !== '' && !isNaN(amount)) {
    cleanAmount = Number(amount);
  }

  let formatted;
  try {
    formatted = new Intl.NumberFormat(numLocale, {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    }).format(cleanAmount);
  } catch {
    formatted = cleanAmount.toFixed(precision);
  }

  if (position === 'after') {
    return `${formatted}${symbol}`;
  }
  return `${symbol}${formatted}`;
}

export function formatCompactCurrency(amount, currencyCode, locale = 'en-US', position = 'before') {
  const cleanCurrency = currencyCode || 'USD';
  const info = CURRENCY_MASTER[cleanCurrency] || { symbol: '$', decimalDigits: 2, locale: 'en-US' };
  const symbol = info.symbol || '$';
  let num = 0;
  if (amount !== null && amount !== undefined && amount !== '' && !isNaN(amount)) {
    num = Number(amount);
  }
  const absNum = Math.abs(num);
  let valStr = '';
  if (absNum >= 1e9) {
    valStr = (num / 1e9).toFixed(2) + 'B';
  } else if (absNum >= 1e6) {
    valStr = (num / 1e6).toFixed(2) + 'M';
  } else if (absNum >= 1e3) {
    valStr = (num / 1e3).toFixed(2) + 'K';
  } else {
    valStr = num.toFixed(2);
  }
  return position === 'after' ? `${valStr}${symbol}` : `${symbol}${valStr}`;
}

export function formatDate(date, format = 'DD-MM-YYYY') {
  if (!date) return '';
  const d = new Date(date);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  const yyyy = String(d.getFullYear());

  switch (format) {
    case 'DD-MM-YYYY': return `${dd}-${mm}-${yyyy}`;
    case 'MM-DD-YYYY': return `${mm}-${dd}-${yyyy}`;
    case 'YYYY-MM-DD': return `${yyyy}-${mm}-${dd}`;
    case 'DD-MM-YY': return `${dd}-${mm}-${yy}`;
    case 'MM-DD-YY': return `${mm}-${dd}-${yy}`;
    default: return `${dd}-${mm}-${yyyy}`;
  }
}

export function getLocaleDisplayName(localeCode) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(localeCode) || localeCode;
  } catch {
    return localeCode;
  }
}
