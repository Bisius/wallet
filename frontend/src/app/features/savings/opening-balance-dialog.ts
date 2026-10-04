import {
  afterNextRender,
  Component,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import type { Cents, SavingsOpeningDto } from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { aliveFlag } from '../../core/alive';
import { parseApiError } from '../../core/api-error';
import type { LoadState } from '../../core/resource-state';
import { SettingsStore } from '../../core/settings.store';
import { formatDate } from '../../shared/format';
import { applyApiErrors, focusFirstInvalid } from '../../shared/forms/api-errors';
import { Field } from '../../shared/forms/field';
import { MoneyInput } from '../../shared/forms/money-input';
import { nonNegativeAmount } from '../../shared/forms/validators';
import { Alert } from '../../shared/ui/alert';
import { Button } from '../../shared/ui/button';
import { AppDialog } from '../../shared/ui/dialog';
import { ErrorState, LoadingState } from '../../shared/ui/states';
import { ToastService } from '../../shared/ui/toast.service';
import { SavingsApi } from './savings.api';

/**
 * Sets the savings balance on the first day of the start month (`PUT /api/savings/opening`). The
 * caller loads the current value and hands it over with its state, so the dialog can say that it is
 * loading or could not load, and shows the form once the value is there. The texts are inputs
 * because two places use it: the Savings page ("Edit") and the Settings page, which asks for the
 * balance again after the start month changed, since moving the start month never changes the amount.
 *
 * `saved` carries what the API stored. The caller reloads what it shows.
 */
@Component({
  selector: 'app-opening-balance-dialog',
  imports: [
    Alert,
    ReactiveFormsModule,
    AppDialog,
    Field,
    MoneyInput,
    Button,
    ErrorState,
    LoadingState,
  ],
  template: `
    <app-dialog [heading]="heading()" [locked]="saving()" (closed)="cancelled.emit()">
      @switch (state()) {
        @case ('loading') {
          <app-loading-state label="Loading your opening balance…" />
          <div class="dialog-footer">
            <button appButton variant="secondary" (click)="cancelled.emit()">
              {{ cancelLabel() }}
            </button>
          </div>
        }
        @case ('error') {
          <app-error-state
            title="Couldn't load your opening balance"
            [error]="error()"
            (retry)="retry.emit()"
          />
          <div class="dialog-footer">
            <button appButton variant="secondary" (click)="cancelled.emit()">
              {{ cancelLabel() }}
            </button>
          </div>
        }
        @default {
          @if (opening(); as current) {
            <form [formGroup]="form" (ngSubmit)="save()" novalidate class="space-y-4">
              @if (intro()) {
                <p class="text-sm">{{ intro() }}</p>
              }
              <app-field
                [label]="'Savings balance on ' + dateLabel(current.date)"
                hint="What you had in savings on that day. Everything after it is tracked as it happens."
              >
                <app-money-input formControlName="amount" />
              </app-field>

              @if (formError(); as message) {
                <app-alert tone="error">{{ message }}</app-alert>
              }

              <div class="dialog-footer">
                <button
                  appButton
                  variant="secondary"
                  [disabled]="saving()"
                  (click)="cancelled.emit()"
                >
                  {{ cancelLabel() }}
                </button>
                <button appButton type="submit" [loading]="saving()">{{ confirmLabel() }}</button>
              </div>
            </form>
          }
        }
      }
    </app-dialog>
  `,
  host: { class: 'block' },
})
export class OpeningBalanceDialog {
  private readonly api = inject(SavingsApi);
  private readonly settings = inject(SettingsStore);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly alive = aliveFlag();

  /** The stored opening balance, undefined until it has loaded. */
  readonly opening = input<SavingsOpeningDto | undefined>();
  readonly state = input<LoadState>('ready');
  /** Why loading failed, while `state` is `error`. */
  readonly error = input<unknown>();
  readonly heading = input('Opening balance');
  /** A line of explanation above the field. */
  readonly intro = input<string>();
  readonly confirmLabel = input('Save opening balance');
  readonly cancelLabel = input('Cancel');

  readonly saved = output<SavingsOpeningDto>();
  readonly cancelled = output<void>();
  readonly retry = output<void>();

  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);

  protected readonly form = new FormGroup({
    amount: new FormControl<Cents | null>(null, [Validators.required, nonNegativeAmount]),
  });

  private filled = false;

  constructor() {
    // The form starts from the stored amount once, when it arrives. A later reload does not
    // overwrite what the user is typing.
    effect(() => {
      const opening = this.opening();
      if (!opening || this.filled) return;
      untracked(() => {
        this.filled = true;
        this.form.controls.amount.setValue(opening.amount);
        // The form is rendered after this: put the cursor on the amount.
        afterNextRender(
          () => this.host.nativeElement.querySelector<HTMLElement>('input')?.focus(),
          { injector: this.injector },
        );
      });
    });
  }

  protected dateLabel(date: string): string {
    return formatDate(date, this.settings.locale(), 'medium');
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.form.markAllAsTouched();
    const amount = this.form.controls.amount.value;
    if (this.form.invalid || amount === null) {
      afterNextRender(() => focusFirstInvalid(this.host.nativeElement), {
        injector: this.injector,
      });
      return;
    }

    this.saving.set(true);
    this.formError.set(null);
    try {
      const saved = await firstValueFrom(this.api.setOpening(amount));
      this.toast.success('Opening balance saved.');
      if (this.alive()) this.saved.emit(saved);
    } catch (error) {
      if (!this.alive()) return;
      this.formError.set(applyApiErrors(this.form, parseApiError(error)));
      afterNextRender(() => focusFirstInvalid(this.host.nativeElement), {
        injector: this.injector,
      });
    } finally {
      this.saving.set(false);
    }
  }
}
