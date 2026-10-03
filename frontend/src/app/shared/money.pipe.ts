import { inject, Pipe, PipeTransform } from '@angular/core';
import type { Cents } from '@wallet/shared';
import { SettingsStore } from '../core/settings.store';

interface MoneyFormat {
  format(amount: number): string;
}

const formats = new Map<string, MoneyFormat>();

/**
 * A cached formatter for a locale and currency. Creating an `Intl.NumberFormat` is slow compared to
 * using one, and a page can show hundreds of amounts. With `whole` there are no decimals ("€2,000"),
 * for the labels of a chart axis whose ticks are all whole currency units.
 */
export function moneyFormat(locale: string, currency: string, whole = false): MoneyFormat {
  const key = `${locale}|${currency}|${whole ? 'whole' : 'full'}`;
  let format = formats.get(key);
  if (!format) {
    try {
      format = new Intl.NumberFormat(
        locale,
        whole
          ? { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }
          : { style: 'currency', currency },
      );
    } catch {
      // An ill-formed currency or locale (a half-typed one in a form) must not break the page.
      const digits = whole ? 0 : 2;
      const plain = new Intl.NumberFormat(undefined, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
      format = { format: (amount) => `${plain.format(amount)} ${currency}` };
    }
    formats.set(key, format);
  }
  return format;
}

/**
 * Cents as a currency amount. The one place cents become a decimal number: the display edge. `whole`
 * drops the decimals, so use it only for amounts that are whole units (chart axis ticks).
 */
export function formatMoney(cents: Cents, locale: string, currency: string, whole = false): string {
  return moneyFormat(locale, currency, whole).format(cents / 100);
}

/**
 * Formats integer cents as currency: `{{ budget.remaining | money }}`. It uses the currency and
 * locale of the settings, or the ones passed in (`{{ cents | money: 'USD' : 'en-US' }}`).
 *
 * The pipe is impure on purpose. It reads the settings signals, and a pure pipe only re-runs when its
 * inputs change, so it would keep showing the fallback format after the settings load or change. An
 * impure pipe re-runs with every check of the view that uses it, which is cheap here (a cached
 * formatter), and the signal reads make Angular check that view when a setting changes.
 */
@Pipe({ name: 'money', pure: false })
export class MoneyPipe implements PipeTransform {
  private readonly settings = inject(SettingsStore);

  transform(cents: Cents | null | undefined, currency?: string, locale?: string): string {
    if (cents == null) return '';
    return formatMoney(
      cents,
      locale ?? this.settings.locale(),
      currency ?? this.settings.currency(),
    );
  }
}
