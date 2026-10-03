import { Component, input, output } from '@angular/core';
import type { MonthBudgetLine, MonthKey, SpendingDto } from '@wallet/shared';
import { AppDialog } from '../../shared/ui/dialog';
import { SpendingForm } from './spending-form';

/** The form that edits a spending, in a dialog. Escape does nothing while the change is saved. */
@Component({
  selector: 'app-spending-edit-dialog',
  imports: [AppDialog, SpendingForm],
  template: `
    <app-dialog heading="Edit spending" [locked]="form.saving()" (closed)="cancelled.emit()">
      <app-spending-form
        #form
        [month]="month()"
        [budgets]="budgets()"
        [spending]="spending()"
        (saved)="saved.emit($event)"
        (cancelled)="cancelled.emit()"
      />
    </app-dialog>
  `,
})
export class SpendingEditDialog {
  readonly spending = input.required<SpendingDto>();
  readonly month = input.required<MonthKey>();
  readonly budgets = input.required<readonly MonthBudgetLine[]>();

  readonly saved = output<SpendingDto>();
  readonly cancelled = output<void>();
}
