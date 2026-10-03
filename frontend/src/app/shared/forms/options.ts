/** Suggestions for the currency and locale inputs (free text is still accepted). */
export const COMMON_CURRENCIES: readonly string[] = [
  'EUR',
  'USD',
  'GBP',
  'CHF',
  'JPY',
  'CAD',
  'AUD',
  'NZD',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'CZK',
  'HUF',
  'RON',
  'BRL',
  'MXN',
  'INR',
  'CNY',
];

export const COMMON_LOCALES: readonly string[] = [
  'en-US',
  'en-GB',
  'it-IT',
  'de-DE',
  'fr-FR',
  'es-ES',
  'pt-PT',
  'pt-BR',
  'nl-NL',
  'pl-PL',
  'sv-SE',
  'ja-JP',
];

function displayName(type: 'currency' | 'language', code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** "Euro" for `EUR`. */
export function currencyName(code: string): string {
  return displayName('currency', code);
}

/** "Italian (Italy)" for `it-IT`. */
export function localeName(tag: string): string {
  return displayName('language', tag);
}
