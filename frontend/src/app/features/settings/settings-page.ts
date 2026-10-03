import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import {
  currencySchema,
  localeSchema,
  type MonthKey,
  type RuleViolationRule,
  type SettingsInput,
  THEMES,
  type Theme,
} from '@wallet/shared';
import { distinctUntilChanged, firstValueFrom, map, skip, startWith } from 'rxjs';
import { parseApiError } from '../../core/api-error';
import { resourceState } from '../../core/resource-state';
import { SettingsStore } from '../../core/settings.store';
import { ThemeService } from '../../core/theme.service';
import { TodayStore } from '../../core/today.store';
import { applyApiErrors, focusFirstInvalid } from '../../shared/forms/api-errors';
import { AppInput } from '../../shared/forms/app-input';
import { Field } from '../../shared/forms/field';
import { MonthInput } from '../../shared/forms/month-input';
import {
  COMMON_CURRENCIES,
  COMMON_LOCALES,
  currencyName,
  localeName,
} from '../../shared/forms/options';
import { START_MONTH_HINT, START_MONTH_RULE_HELP } from '../../shared/forms/start-month-help';
import { wholePercent, zodValidator } from '../../shared/forms/validators';
import { MoneyPipe } from '../../shared/money.pipe';
import { PageHeader } from '../../shared/page-header';
import { Button } from '../../shared/ui/button';
import { Icon } from '../../shared/ui/icon';
import { ToastService } from '../../shared/ui/toast.service';
import { OpeningBalanceDialog } from '../savings/opening-balance-dialog';
import { SavingsApi } from '../savings/savings.api';

const THEME_LABELS: Record<Theme, string> = {
  system: 'Same as my device',
  light: 'Light',
  dark: 'Dark',
};

/**
 * Currency, locale, theme, budget warning threshold and start month (`PUT /api/settings`). After the
 * start month changed, it asks for the savings balance on the new first day: the opening balance
 * follows the start month's date but never its amount.
 */
@Component({
  selector: 'app-settings-page',
  imports: [
    ReactiveFormsModule,
    PageHeader,
    Field,
    AppInput,
    MonthInput,
    Button,
    Icon,
    MoneyPipe,
    OpeningBalanceDialog,
  ],
  templateUrl: './settings-page.html',
})
export class SettingsPage {
  private readonly store = inject(SettingsStore);
  private readonly theme = inject(ThemeService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly today = inject(TodayStore);

  protected readonly themes = THEMES;
  protected readonly themeLabels = THEME_LABELS;
  protected readonly currencies = COMMON_CURRENCIES;
  protected readonly locales = COMMON_LOCALES;
  protected readonly currencyName = currencyName;
  protected readonly localeName = localeName;
  protected readonly sampleAmount = 123456;

  protected readonly form = new FormGroup({
    currency: new FormControl(this.store.currency(), {
      nonNullable: true,
      validators: [Validators.required, zodValidator(currencySchema)],
    }),
    locale: new FormControl(this.store.locale(), {
      nonNullable: true,
      validators: [Validators.required, zodValidator(localeSchema)],
    }),
    theme: new FormControl<Theme>(this.store.theme(), { nonNullable: true }),
    alertWarnPercent: new FormControl<number | null>(this.store.alertWarnPercent(), [
      Validators.required,
      wholePercent,
    ]),
    startMonth: new FormControl<MonthKey | null>(this.store.startMonth() ?? null, [
      Validators.required,
    ]),
  });

  protected readonly saving = signal(false);
  /** An error that belongs to no field. */
  protected readonly formError = signal<string | null>(null);
  /** The rule the API said the start month broke, if any. */
  private readonly brokenRule = signal<RuleViolationRule | null>(null);

  protected readonly startMonthHint = computed(() => {
    const rule = this.brokenRule();
    return (rule && START_MONTH_RULE_HELP[rule]) || START_MONTH_HINT;
  });

  /** The prompt for the opening balance is open: the start month has just changed. */
  protected readonly askingForOpening = signal(false);
  /** `GET /api/savings/opening`, loaded only while the prompt is open (the date is the new first day). */
  protected readonly opening = inject(SavingsApi).opening(() => this.askingForOpening());
  protected readonly openingState = resourceState(this.opening);
  protected readonly openingValue = computed(() =>
    this.opening.hasValue() ? this.opening.value() : undefined,
  );

  private readonly draft = toSignal(
    this.form.valueChanges.pipe(
      startWith(null),
      map(() => this.form.getRawValue()),
    ),
    { requireSync: true },
  );
  protected readonly currency = computed(() => this.draft().currency.trim().toUpperCase());
  protected readonly locale = computed(() => this.draft().locale.trim());

  constructor() {
    // Picking a theme shows it right away; Save keeps it. Leaving the page without saving undoes it.
    this.form.controls.theme.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((theme) => this.theme.preview(theme));
    inject(DestroyRef).onDestroy(() => this.theme.preview(null));

    // The explanation of a broken rule is about the value that was rejected.
    const startMonth = this.form.controls.startMonth;
    startMonth.valueChanges
      .pipe(startWith(startMonth.value), distinctUntilChanged(), skip(1), takeUntilDestroyed())
      .subscribe(() => this.brokenRule.set(null));
  }

  protected uppercaseCurrency(): void {
    const control = this.form.controls.currency;
    const upper = control.value.toUpperCase();
    if (upper !== control.value) control.setValue(upper);
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.form.markAllAsTouched();
    const value = this.form.getRawValue();
    if (this.form.invalid || value.startMonth === null || value.alertWarnPercent === null) {
      this.focusFirstInvalidAfterRender();
      return;
    }

    const input: SettingsInput = {
      currency: value.currency.trim().toUpperCase(),
      locale: value.locale.trim(),
      startMonth: value.startMonth,
      theme: value.theme,
      alertWarnPercent: value.alertWarnPercent,
    };

    const startMonthBefore = this.store.startMonth();

    this.saving.set(true);
    this.formError.set(null);
    this.brokenRule.set(null);
    try {
      await firstValueFrom(this.store.save(input));
      this.toast.success('Settings saved.');
      this.form.markAsPristine();
      // The opening balance moved to the new first day with the same amount: ask what it is now.
      if (startMonthBefore !== undefined && startMonthBefore !== input.startMonth) {
        this.askingForOpening.set(true);
      }
    } catch (error) {
      const parsed = parseApiError(error);
      this.brokenRule.set(parsed.rule);
      this.formError.set(applyApiErrors(this.form, parsed));
      this.focusFirstInvalidAfterRender();
    } finally {
      this.saving.set(false);
    }
  }

  /** The user left the opening balance as it is: say where to change it later. */
  protected skipOpening(): void {
    this.askingForOpening.set(false);
    this.toast.info(
      'Your opening balance was left as it is. You can change it on the Savings page.',
      {
        label: 'Open savings',
        run: () => void this.router.navigateByUrl('/savings'),
      },
    );
  }

  private focusFirstInvalidAfterRender(): void {
    afterNextRender(() => focusFirstInvalid(this.host.nativeElement), { injector: this.injector });
  }
}
