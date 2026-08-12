export const LANGUAGE_MASTER = {
  en: { code: 'en', name: 'English', nameNative: 'English', locale: 'en-US', dir: 'ltr' },
  hi: { code: 'hi', name: 'Hindi', nameNative: '\u0939\u093F\u0928\u094D\u0926\u0940', locale: 'hi-IN', dir: 'ltr' },
  te: { code: 'te', name: 'Telugu', nameNative: '\u0C24\u0C46\u0C32\u0C41\u0C17\u0C41', locale: 'te-IN', dir: 'ltr' },
  ta: { code: 'ta', name: 'Tamil', nameNative: '\u0BA4\u0BAE\u0BBF\u0BB4\u0BCD', locale: 'ta-IN', dir: 'ltr' },
  kn: { code: 'kn', name: 'Kannada', nameNative: '\u0C95\u0CA8\u0CCD\u0CA8\u0CA1', locale: 'kn-IN', dir: 'ltr' },
  ml: { code: 'ml', name: 'Malayalam', nameNative: '\u0D2E\u0D32\u0D2F\u0D3E\u0D33\u0D02', locale: 'ml-IN', dir: 'ltr' },
  mr: { code: 'mr', name: 'Marathi', nameNative: '\u092E\u0930\u093E\u0920\u0940', locale: 'mr-IN', dir: 'ltr' },
  bn: { code: 'bn', name: 'Bengali', nameNative: '\u09AC\u09BE\u0982\u09B2\u09BE', locale: 'bn-BD', dir: 'ltr' },
  gu: { code: 'gu', name: 'Gujarati', nameNative: '\u0A97\u0AC1\u0A9C\u0AB0\u0ABE\u0AA4\u0AC0', locale: 'gu-IN', dir: 'ltr' },
  pa: { code: 'pa', name: 'Punjabi', nameNative: '\u0A2A\u0A70\u0A1C\u0A3E\u0A2C\u0A40', locale: 'pa-IN', dir: 'ltr' },
  ur: { code: 'ur', name: 'Urdu', nameNative: '\u0627\u0631\u062F\u0648', locale: 'ur-PK', dir: 'rtl' },
  ar: { code: 'ar', name: 'Arabic', nameNative: '\u0627\u0644\u0639\u0631\u0628\u064A\u0629', locale: 'ar-SA', dir: 'rtl' },
  fr: { code: 'fr', name: 'French', nameNative: 'Fran\u00E7ais', locale: 'fr-FR', dir: 'ltr' },
  de: { code: 'de', name: 'German', nameNative: 'Deutsch', locale: 'de-DE', dir: 'ltr' },
  es: { code: 'es', name: 'Spanish', nameNative: 'Espa\u00F1ol', locale: 'es-ES', dir: 'ltr' },
  pt: { code: 'pt', name: 'Portuguese', nameNative: 'Portugu\u00EAs', locale: 'pt-PT', dir: 'ltr' },
  nl: { code: 'nl', name: 'Dutch', nameNative: 'Nederlands', locale: 'nl-NL', dir: 'ltr' },
  zh: { code: 'zh', name: 'Chinese', nameNative: '\u4E2D\u6587', locale: 'zh-CN', dir: 'ltr' },
  ja: { code: 'ja', name: 'Japanese', nameNative: '\u65E5\u672C\u8A9E', locale: 'ja-JP', dir: 'ltr' },
  ko: { code: 'ko', name: 'Korean', nameNative: '\uD55C\uAD6D\uC5B4', locale: 'ko-KR', dir: 'ltr' },
  ru: { code: 'ru', name: 'Russian', nameNative: '\u0420\u0443\u0441\u0441\u043A\u0438\u0439', locale: 'ru-RU', dir: 'ltr' },
  it: { code: 'it', name: 'Italian', nameNative: 'Italiano', locale: 'it-IT', dir: 'ltr' },
  tr: { code: 'tr', name: 'Turkish', nameNative: 'T\u00FCrk\u00E7e', locale: 'tr-TR', dir: 'ltr' },
};

export function getLanguageInfo(code) {
  return LANGUAGE_MASTER[code] || null;
}

export function getLanguageOptions() {
  return Object.keys(LANGUAGE_MASTER).map((code) => ({
    value: code,
    label: LANGUAGE_MASTER[code].nameNative,
    searchLabel: `${code} ${LANGUAGE_MASTER[code].name} ${LANGUAGE_MASTER[code].nameNative}`,
  }));
}

export function getLanguageSelectOptions() {
  return Object.keys(LANGUAGE_MASTER).map((code) => ({
    value: code,
    label: `${LANGUAGE_MASTER[code].nameNative} (${LANGUAGE_MASTER[code].name})`,
  }));
}

export function getSupportedLanguageCodes() {
  return Object.keys(LANGUAGE_MASTER);
}

export function getLocaleForLanguage(code) {
  const info = LANGUAGE_MASTER[code];
  return info ? info.locale : 'en-US';
}
