import { inject, LOCALE_ID, Pipe, PipeTransform } from '@angular/core';
import { type Cents, formatCents } from '@wallet/shared';

/** Formats an integer amount of cents as currency: `{{ budget.remaining | money }}`. */
@Pipe({ name: 'money' })
export class MoneyPipe implements PipeTransform {
  private readonly locale = inject(LOCALE_ID);

  transform(cents: Cents | null | undefined, currency = 'EUR'): string {
    return cents == null ? '' : formatCents(cents, currency, this.locale);
  }
}
