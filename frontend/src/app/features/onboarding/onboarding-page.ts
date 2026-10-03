import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  LOCALE_ID,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  type AbstractControl,
  FormArray,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { Router } from '@angular/router';
import {
  type Cents,
  currencySchema,
  localeSchema,
  MAX_ONBOARDING_BUDGETS,
  type MonthKey,
  NAME_MAX_LENGTH,
  type OnboardingInput,
  type RuleViolationRule,
} from '@wallet/shared';
import { distinctUntilChanged, firstValueFrom, map, skip, startWith } from 'rxjs';
import { parseApiError } from '../../core/api-error';
import { SettingsStore } from '../../core/settings.store';
import { TodayStore } from '../../core/today.store';
import { formatMonth } from '../../shared/format';
import { applyApiErrors, focusFirstInvalid } from '../../shared/forms/api-errors';
import { AppInput } from '../../shared/forms/app-input';
import { Field } from '../../shared/forms/field';
import { MoneyInput } from '../../shared/forms/money-input';
import { MonthInput } from '../../shared/forms/month-input';
import {
  COMMON_CURRENCIES,
  COMMON_LOCALES,
  currencyName,
  localeName,
} from '../../shared/forms/options';
import { START_MONTH_HINT, START_MONTH_RULE_HELP } from '../../shared/forms/start-month-help';
import { Toggle } from '../../shared/forms/toggle';
import { nonNegativeAmount, zodValidator } from '../../shared/forms/validators';
import { MoneyPipe } from '../../shared/money.pipe';
import { PageHeader } from '../../shared/page-header';
import { Button } from '../../shared/ui/button';
import { Icon } from '../../shared/ui/icon';
import { ToastService } from '../../shared/ui/toast.service';
import { OnboardingApi } from './onboarding.api';

type StepId = 'basics' | 'salary' | 'savings' | 'budgets' | 'review';

interface Step {
  id: StepId;
  /** Short name in the stepper. */
  label: string;
  /** Heading of the step. Focus moves here when the step opens. */
  heading: string;
}

const STEPS: readonly Step[] = [
  { id: 'basics', label: 'Basics', heading: 'Start month and currency' },
  { id: 'salary', label: 'Salary', heading: 'Your monthly salary' },
  { id: 'savings', label: 'Savings', heading: 'Your savings so far' },
  { id: 'budgets', label: 'Budgets', heading: 'Your first budgets' },
  { id: 'review', label: 'Review', heading: 'Review and finish' },
];

type BudgetForm = FormGroup<{
  name: FormControl<string>;
  amount: FormControl<Cents | null>;
  incremental: FormControl<boolean>;
}>;

/**
 * First-run setup, shown while `GET /api/settings` answers 404. Five steps, one request: nothing
 * is sent until the user presses "Create my wallet", which posts everything to `/api/onboarding`.
 *
 * The form mirrors the request body, so a field error from the API (`budgets.0.amount`) lands on the
 * right control, and the wizard jumps to the step that holds it.
 */
@Component({
  selector: 'app-onboarding-page',
  imports: [
    ReactiveFormsModule,
    PageHeader,
    Field,
    AppInput,
    MoneyInput,
    MonthInput,
    Toggle,
    Button,
    Icon,
    MoneyPipe,
  ],
  templateUrl: './onboarding-page.html',
})
export class OnboardingPage {
  private readonly api = inject(OnboardingApi);
  private readonly settings = inject(SettingsStore);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly defaultLocale = inject(LOCALE_ID);
  protected readonly today = inject(TodayStore);

  protected readonly steps = STEPS;
  protected readonly currencies = COMMON_CURRENCIES;
  protected readonly locales = COMMON_LOCALES;
  protected readonly currencyName = currencyName;
  protected readonly localeName = localeName;
  protected readonly maxBudgets = MAX_ONBOARDING_BUDGETS;
  protected readonly nameMaxLength = NAME_MAX_LENGTH;
  protected readonly sampleAmount: Cents = 123456;

  protected readonly form = new FormGroup({
    // Defaults come from the server's "today", never from the browser clock.
    startMonth: new FormControl<MonthKey | null>(this.today.month() ?? null, [Validators.required]),
    currency: new FormControl('EUR', {
      nonNullable: true,
      validators: [Validators.required, zodValidator(currencySchema)],
    }),
    locale: new FormControl(this.defaultLocale, {
      nonNullable: true,
      validators: [Validators.required, zodValidator(localeSchema)],
    }),
    salary: new FormControl<Cents | null>(null, [Validators.required, nonNegativeAmount]),
    openingSavings: new FormControl<Cents | null>(0, [Validators.required, nonNegativeAmount]),
    budgets: new FormArray<BudgetForm>([]),
  });

  protected readonly stepIndex = signal(0);
  protected readonly current = computed(() => STEPS[this.stepIndex()]);
  protected readonly isFirst = computed(() => this.stepIndex() === 0);
  protected readonly isLast = computed(() => this.stepIndex() === STEPS.length - 1);

  protected readonly saving = signal(false);
  /** An error that belongs to no field: shown above the buttons. */
  protected readonly formError = signal<string | null>(null);

  private readonly stepHeading = viewChild<ElementRef<HTMLElement>>('stepHeading');
  private readonly addBudgetButton = viewChild('addBudgetButton', { read: ElementRef });

  /** Everything typed so far, as a signal (for the review and for the money inputs' currency). */
  protected readonly draft = toSignal(
    this.form.valueChanges.pipe(
      startWith(null),
      map(() => this.form.getRawValue()),
    ),
    { requireSync: true },
  );
  protected readonly currency = computed(() => this.draft().currency.trim().toUpperCase());
  protected readonly locale = computed(() => this.draft().locale.trim());
  protected readonly startMonthLabel = computed(() => {
    const month = this.draft().startMonth;
    return month ? formatMonth(month, this.locale()) : '';
  });
  /** The opening balance is the balance on the first day of the start month: the label says which day. */
  protected readonly openingLabel = computed(
    () => `Savings balance on the 1st of ${this.startMonthLabel() || 'the start month'}`,
  );

  /** The rule the API said the start month broke, if any: its help replaces the hint. */
  private readonly brokenRule = signal<RuleViolationRule | null>(null);
  protected readonly startMonthHint = computed(() => {
    const rule = this.brokenRule();
    return (rule && START_MONTH_RULE_HELP[rule]) || START_MONTH_HINT;
  });

  protected get budgets(): FormArray<BudgetForm> {
    return this.form.controls.budgets;
  }

  constructor() {
    // The explanation of a broken rule is about the start month that was rejected.
    const startMonth = this.form.controls.startMonth;
    startMonth.valueChanges
      .pipe(startWith(startMonth.value), distinctUntilChanged(), skip(1), takeUntilDestroyed())
      .subscribe(() => this.brokenRule.set(null));
  }

  // --- navigation ------------------------------------------------------------------------------

  protected onSubmit(): void {
    if (this.saving()) return;
    if (this.isLast()) void this.submit();
    else this.next();
  }

  protected next(): void {
    if (this.validateStep(this.stepIndex())) this.goTo(this.stepIndex() + 1);
  }

  protected back(): void {
    this.goTo(this.stepIndex() - 1);
  }

  protected goTo(index: number): void {
    if (index < 0 || index >= STEPS.length) return;
    this.stepIndex.set(index);
    this.formError.set(null);
    // The new step's heading takes focus, so screen reader and keyboard users arrive at the top of it.
    afterNextRender(() => this.stepHeading()?.nativeElement.focus(), { injector: this.injector });
  }

  /** Marks the step's controls touched and says whether they are valid. Focuses the first problem. */
  private validateStep(index: number): boolean {
    const controls = this.controlsOf(STEPS[index].id);
    controls.forEach((control) => control.markAllAsTouched());
    if (controls.every((control) => control.valid)) return true;
    this.focusFirstInvalidAfterRender();
    return false;
  }

  private controlsOf(step: StepId): AbstractControl[] {
    const controls = this.form.controls;
    switch (step) {
      case 'basics':
        return [controls.startMonth, controls.currency, controls.locale];
      case 'salary':
        return [controls.salary];
      case 'savings':
        return [controls.openingSavings];
      case 'budgets':
        return [controls.budgets];
      case 'review':
        return [];
    }
  }

  private focusFirstInvalidAfterRender(): void {
    afterNextRender(() => focusFirstInvalid(this.host.nativeElement), { injector: this.injector });
  }

  // --- budgets ---------------------------------------------------------------------------------

  protected addBudget(): void {
    if (this.budgets.length >= MAX_ONBOARDING_BUDGETS) return;
    this.budgets.push(
      new FormGroup({
        name: new FormControl('', {
          nonNullable: true,
          validators: [Validators.required, Validators.maxLength(NAME_MAX_LENGTH)],
        }),
        amount: new FormControl<Cents | null>(null, [Validators.required, nonNegativeAmount]),
        incremental: new FormControl(false, { nonNullable: true }),
      }),
    );
    const index = this.budgets.length - 1;
    afterNextRender(
      () =>
        this.host.nativeElement
          .querySelector<HTMLInputElement>(`[data-budget-row="${index}"] input`)
          ?.focus(),
      { injector: this.injector },
    );
  }

  protected removeBudget(index: number): void {
    this.budgets.removeAt(index);
    // The row that had focus is gone: keep the keyboard user in this part of the page.
    afterNextRender(
      () => (this.addBudgetButton()?.nativeElement as HTMLElement | undefined)?.focus(),
      {
        injector: this.injector,
      },
    );
  }

  protected budgetLabel(index: number): string {
    const name = this.budgets.at(index).controls.name.value.trim();
    return name || `budget ${index + 1}`;
  }

  // --- the currency is always upper case -------------------------------------------------------

  protected uppercaseCurrency(): void {
    const control = this.form.controls.currency;
    const upper = control.value.toUpperCase();
    if (upper !== control.value) control.setValue(upper);
  }

  // --- submit ----------------------------------------------------------------------------------

  private buildBody(): OnboardingInput | null {
    const value = this.form.getRawValue();
    if (value.startMonth === null || value.salary === null || value.openingSavings === null) {
      return null;
    }
    const budgets: OnboardingInput['budgets'] = [];
    for (const budget of value.budgets) {
      if (budget.amount === null) return null;
      budgets.push({
        name: budget.name.trim(),
        amount: budget.amount,
        incremental: budget.incremental,
      });
    }
    return {
      currency: value.currency.trim().toUpperCase(),
      locale: value.locale.trim(),
      startMonth: value.startMonth,
      salary: value.salary,
      openingSavings: value.openingSavings,
      budgets,
    };
  }

  private async submit(): Promise<void> {
    // Every step was checked on the way here, but an API error may have put an error back on a field.
    const firstBad = STEPS.findIndex((step) => !this.controlsOf(step.id).every((c) => c.valid));
    const body = firstBad === -1 ? this.buildBody() : null;
    if (body === null) {
      if (firstBad !== -1 && firstBad !== this.stepIndex()) this.goTo(firstBad);
      this.validateStep(firstBad === -1 ? this.stepIndex() : firstBad);
      return;
    }

    this.saving.set(true);
    this.formError.set(null);
    try {
      const response = await firstValueFrom(this.api.submit(body));
      this.settings.seed(response.settings);
      this.toast.success('Your wallet is ready.');
      await this.router.navigateByUrl('/dashboard');
    } catch (error) {
      await this.showError(error);
    } finally {
      this.saving.set(false);
    }
  }

  private async showError(error: unknown): Promise<void> {
    const parsed = parseApiError(error);

    if (parsed.code === 'already_onboarded') {
      // Set up in another tab or on another device meanwhile: nothing to do but carry on.
      this.settings.reload();
      this.toast.info('Wallet was already set up.');
      await this.router.navigateByUrl('/dashboard');
      return;
    }

    this.brokenRule.set(parsed.rule);
    const formError = applyApiErrors(this.form, parsed);
    // Show the step that holds the first field the API complained about.
    const badStep = STEPS.findIndex((step) => !this.controlsOf(step.id).every((c) => c.valid));
    if (badStep !== -1 && badStep !== this.stepIndex()) this.goTo(badStep);
    this.formError.set(formError);
    this.focusFirstInvalidAfterRender();
  }
}
