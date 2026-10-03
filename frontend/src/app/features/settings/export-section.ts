import { Component, computed } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { type ExportKind, type ExportQuery, exportQuerySchema } from '@wallet/shared';
import { map, startWith } from 'rxjs';
import { AppInput } from '../../shared/forms/app-input';
import { Field } from '../../shared/forms/field';
import { Button } from '../../shared/ui/button';
import { Icon } from '../../shared/ui/icon';
import { LinkButton } from '../../shared/ui/link-button';
import { exportFileName, exportUrl } from './export-url';

interface ExportChoice {
  kind: ExportKind;
  title: string;
  description: string;
}

const CHOICES: readonly ExportChoice[] = [
  {
    kind: 'spendings',
    title: 'Spendings',
    description: 'Date, amount, budget, description, notes and tags. Refunds are negative.',
  },
  {
    kind: 'incomes',
    title: 'Incomes',
    description: 'The extra incomes you added. Your salary is not in this file.',
  },
  {
    kind: 'savings',
    title: 'Savings',
    description: 'Every savings transaction: settlements, deposits, withdrawals and reallocations.',
  },
];

/** What is wrong with the range, in words, or null. The shared query schema decides; this words it. */
function rangeProblem(range: { from: string; to: string }): {
  query: ExportQuery | null;
  problem: string | null;
} {
  const input: { from?: string; to?: string } = {};
  if (range.from !== '') input.from = range.from;
  if (range.to !== '') input.to = range.to;
  const result = exportQuerySchema.safeParse(input);
  if (result.success) return { query: result.data, problem: null };

  const issue = result.error.issues[0];
  const field = issue?.path[0];
  if (issue?.code === 'custom') {
    return {
      query: null,
      problem: '"From" is after "To". Choose a From date that is on or before the To date.',
    };
  }
  return {
    query: null,
    problem: `Enter a valid ${field === 'from' ? '"From"' : '"To"'} date, with a four-digit year.`,
  };
}

/**
 * The three CSV downloads (`GET /api/export/<kind>.csv`) for a spreadsheet or an accountant, with an
 * optional date range they share. Each download is a plain `<a download>`: the browser fetches the
 * file itself, so nothing here reads or builds it. An empty box is no limit; a range that ends before
 * it starts turns the links off and says why.
 */
@Component({
  selector: 'app-export-section',
  imports: [ReactiveFormsModule, Field, AppInput, Button, Icon, LinkButton],
  template: `
    <section aria-labelledby="export-heading" class="card space-y-4">
      <div>
        <h2 id="export-heading" class="text-lg font-semibold">Export</h2>
        <p class="mt-1 text-sm text-muted">
          Download your records as CSV files that a spreadsheet opens. An export is for reading, not
          a backup: it holds these records only, not your budgets, subscriptions or settings.
        </p>
      </div>

      <form [formGroup]="range" class="grid gap-3 sm:grid-cols-2" novalidate>
        <app-field label="From" optional hint="First day included. Empty: from the start.">
          <input appInput type="date" formControlName="from" />
        </app-field>
        <app-field
          label="To"
          optional
          hint="Last day included. Empty: up to the latest."
          [error]="problem() ?? undefined"
        >
          <input appInput type="date" formControlName="to" />
        </app-field>
      </form>

      <ul class="divide-y divide-line rounded-card border border-line">
        @for (choice of choices; track choice.kind) {
          <li class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3">
            <div class="min-w-0 flex-1">
              <p class="font-medium">{{ choice.title }}</p>
              <p class="text-sm text-muted">{{ choice.description }}</p>
            </div>
            @if (query(); as current) {
              <a
                appLinkButton
                [href]="url(choice.kind, current)"
                [attr.download]="fileName(choice.kind, current)"
              >
                <app-icon name="download" />
                Download {{ choice.title.toLowerCase() }} CSV
              </a>
            } @else {
              <button appButton variant="secondary" disabled>
                <app-icon name="download" />
                Download {{ choice.title.toLowerCase() }} CSV
              </button>
            }
          </li>
        }
      </ul>
    </section>
  `,
  host: { class: 'block' },
})
export class ExportSection {
  protected readonly choices = CHOICES;

  protected readonly range = new FormGroup({
    from: new FormControl('', { nonNullable: true }),
    to: new FormControl('', { nonNullable: true }),
  });

  private readonly draft = toSignal(
    this.range.valueChanges.pipe(
      startWith(null),
      map(() => this.range.getRawValue()),
    ),
    { requireSync: true },
  );
  private readonly checked = computed(() => rangeProblem(this.draft()));

  /** The range as the API takes it, or null while it is not a valid one (the links are off). */
  protected readonly query = computed(() => this.checked().query);
  /** Why the range is not valid, in words. */
  protected readonly problem = computed(() => this.checked().problem);

  protected url(kind: ExportKind, range: ExportQuery): string {
    return exportUrl(kind, range);
  }

  protected fileName(kind: ExportKind, range: ExportQuery): string {
    return exportFileName(kind, range);
  }
}
