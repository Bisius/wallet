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
import { AppList, ListRow } from '../../shared/ui/list';
import { AppSection, SectionHelp } from '../../shared/ui/section';
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
    description: 'Date, amount, budget, notes and tags.',
  },
  {
    kind: 'incomes',
    title: 'Incomes',
    description: 'The extra incomes you added.',
  },
  {
    kind: 'savings',
    title: 'Savings',
    description: 'Every savings transaction.',
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
 *
 * It is a block of the "Data" section of the settings, so its heading is a level 3 one (still a named
 * region). Each row says "Download" and names the file for assistive technology ("Download
 * spendings CSV"): the row's title already says which. On a phone the button goes under the
 * description (`actionsBelow`) instead of squeezing it. What each file holds, in full, is in the
 * section's help.
 */
@Component({
  selector: 'app-export-section',
  imports: [
    ReactiveFormsModule,
    AppList,
    AppSection,
    Field,
    AppInput,
    Button,
    Icon,
    LinkButton,
    ListRow,
    SectionHelp,
  ],
  template: `
    <app-section
      level="3"
      landmark
      heading="Export"
      description="Download your records as CSV files that a spreadsheet opens."
    >
      <p sectionHelp>
        An export is for reading, not a backup: it holds these records only, not your budgets,
        subscriptions or settings.
      </p>
      <p sectionHelp>
        Spendings: date, amount, budget, description, notes and tags. Refunds are negative. Incomes:
        the extra incomes you added. Your salary is not in this file. Savings: every savings
        transaction: settlements, deposits, withdrawals and reallocations.
      </p>

      <form [formGroup]="range" class="grid gap-4 sm:grid-cols-2" novalidate>
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

      <ul appList>
        @for (choice of choices; track choice.kind) {
          <li appListRow actionsBelow>
            <span rowTitle>{{ choice.title }}</span>
            <p rowMeta>{{ choice.description }}</p>
            @if (query(); as current) {
              <a
                rowActions
                appLinkButton
                size="sm"
                [href]="url(choice.kind, current)"
                [attr.download]="fileName(choice.kind, current)"
                [attr.aria-label]="downloadName(choice)"
              >
                <app-icon name="download" />
                Download
              </a>
            } @else {
              <button
                rowActions
                appButton
                variant="secondary"
                size="sm"
                disabled
                [attr.aria-label]="downloadName(choice)"
              >
                <app-icon name="download" />
                Download
              </button>
            }
          </li>
        }
      </ul>
    </app-section>
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

  /** What the link is, for a screen reader: the visible word is only "Download". */
  protected downloadName(choice: ExportChoice): string {
    return `Download ${choice.title.toLowerCase()} CSV`;
  }
}
