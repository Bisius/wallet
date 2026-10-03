import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  OnInit,
  output,
  signal,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import type { Cents, GoalCreateInput, GoalDto, GoalUpdateInput } from '@wallet/shared';
import { NAME_MAX_LENGTH } from '@wallet/shared/limits';
import { firstValueFrom, type Observable } from 'rxjs';
import { aliveFlag } from '../../core/alive';
import { parseApiError } from '../../core/api-error';
import { applyApiErrors, focusFirstInvalid } from '../../shared/forms/api-errors';
import { AppInput } from '../../shared/forms/app-input';
import { ColorPicker } from '../../shared/forms/color-picker';
import { Field } from '../../shared/forms/field';
import { MoneyInput } from '../../shared/forms/money-input';
import { positiveAmount } from '../../shared/forms/validators';
import { Button } from '../../shared/ui/button';
import { AppDialog } from '../../shared/ui/dialog';
import { Icon } from '../../shared/ui/icon';
import { ToastService } from '../../shared/ui/toast.service';
import { GoalsApi } from './goals.api';

/**
 * Creates a goal, or edits one when `goal` is given: a name, the amount to save, an optional
 * deadline (only its month counts) and an optional color. Editing sends only what changed
 * (`PATCH /api/goals/:id`, where `null` clears the deadline or the color).
 *
 * `changed` fires when the goal was saved (the page reloads) and `finished` closes the dialog. After
 * a failure the dialog stays open with the message on the field the API named.
 */
@Component({
  selector: 'app-goal-form',
  imports: [ReactiveFormsModule, AppDialog, Field, AppInput, MoneyInput, ColorPicker, Button, Icon],
  templateUrl: './goal-form.html',
  host: { class: 'block' },
})
export class GoalForm implements OnInit {
  private readonly api = inject(GoalsApi);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly alive = aliveFlag();

  /** The goal to edit. Leave unset to create one. */
  readonly goal = input<GoalDto>();

  readonly changed = output<void>();
  readonly finished = output<void>();
  readonly cancelled = output<void>();

  protected readonly nameMaxLength = NAME_MAX_LENGTH;
  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);
  protected readonly editing = computed(() => this.goal() !== undefined);

  /** The control names are the request's field names, so a field error from the API lands on its control. */
  protected readonly form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(NAME_MAX_LENGTH)],
    }),
    targetAmount: new FormControl<Cents | null>(null, [Validators.required, positiveAmount]),
    /** `YYYY-MM-DD`, or empty for no deadline. */
    deadline: new FormControl('', { nonNullable: true }),
    color: new FormControl<string | null>(null),
  });

  ngOnInit(): void {
    const goal = this.goal();
    if (!goal) return;
    this.form.setValue({
      name: goal.name,
      targetAmount: goal.targetAmount,
      deadline: goal.deadline ?? '',
      color: goal.color,
    });
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.form.markAllAsTouched();
    const value = this.form.getRawValue();
    if (this.form.invalid || value.targetAmount === null) {
      this.focusInvalidAfterRender();
      return;
    }

    const name = value.name.trim();
    const deadline = value.deadline === '' ? null : value.deadline;
    const goal = this.goal();

    let request: Observable<GoalDto>;
    if (goal) {
      const changes: GoalUpdateInput = {};
      if (name !== goal.name) changes.name = name;
      if (value.targetAmount !== goal.targetAmount) changes.targetAmount = value.targetAmount;
      if (deadline !== goal.deadline) changes.deadline = deadline;
      if (value.color !== goal.color) changes.color = value.color;
      if (Object.keys(changes).length === 0) {
        this.cancelled.emit();
        return;
      }
      request = this.api.update(goal.id, changes);
    } else {
      const input: GoalCreateInput = {
        name,
        targetAmount: value.targetAmount,
        ...(deadline ? { deadline } : {}),
        ...(value.color ? { color: value.color } : {}),
      };
      request = this.api.create(input);
    }

    this.saving.set(true);
    this.formError.set(null);
    try {
      await firstValueFrom(request);
      this.toast.success(goal ? `${name} updated.` : `${name} created.`);
      if (this.alive()) {
        this.changed.emit();
        this.finished.emit();
      }
    } catch (error) {
      if (!this.alive()) return;
      this.formError.set(applyApiErrors(this.form, parseApiError(error)));
      this.focusInvalidAfterRender();
    } finally {
      this.saving.set(false);
    }
  }

  private focusInvalidAfterRender(): void {
    afterNextRender(() => focusFirstInvalid(this.host.nativeElement), { injector: this.injector });
  }
}
