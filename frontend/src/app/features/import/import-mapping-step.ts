import { Component, computed, inject } from '@angular/core';
import {
  CSV_DELIMITERS,
  IMPORT_DATE_FORMATS,
  IMPORT_DECIMAL_SEPARATORS,
  IMPORT_MAX_ROWS,
  IMPORT_SIGN_CONVENTIONS,
  type CsvDelimiter,
  type ImportDateFormat,
  type ImportDecimalSeparator,
  type ImportSignConvention,
} from '@wallet/shared';
import { AppInput } from '../../shared/forms/app-input';
import { Field } from '../../shared/forms/field';
import { Button } from '../../shared/ui/button';
import { Icon } from '../../shared/ui/icon';
import { DATE_FORMAT_EXAMPLES, DELIMITER_LABELS, SIGN_LABELS } from './import-text';
import { ImportProfilePicker } from './import-profile-picker';
import { ImportProfileSave } from './import-profile-save';
import { ImportReviewStore } from './import-review.store';
import { ImportWizardStore, type MappingDraft } from './import-wizard.store';

type ColumnKey = 'dateColumn' | 'amountColumn' | 'descriptionColumn';

/** A column the pickers offer, with the name the user knows it by. */
interface ColumnChoice {
  index: number;
  label: string;
}

const DECIMAL_LABELS: Record<ImportDecimalSeparator, string> = {
  '.': 'Dot (1,234.56)',
  ',': 'Comma (1.234,56)',
};

const SAMPLE_CELL_MAX = 24;

const shorten = (text: string): string =>
  text.length > SAMPLE_CELL_MAX ? `${text.slice(0, SAMPLE_CELL_MAX - 1)}…` : text;

/**
 * Step 2: tell the server how to read the file. The delimiter (changing it reads the file again),
 * whether the first row is a header, the date, amount and description columns, and the formats of the
 * date and the amount. A table of the first rows lets the person check the columns by eye. A saved
 * profile (suggested by the server, or picked) fills all of it in. Next asks the server to judge every
 * row (`POST /api/import/preview`) and is off until the three columns are different.
 */
@Component({
  selector: 'app-import-mapping-step',
  imports: [Field, AppInput, Button, Icon, ImportProfilePicker, ImportProfileSave],
  template: `
    <section aria-labelledby="import-mapping-heading" class="card space-y-5">
      <h2
        #heading
        id="import-mapping-heading"
        tabindex="-1"
        class="text-xl font-semibold tracking-tight"
      >
        How is the file laid out?
      </h2>

      <app-import-profile-picker />

      <div aria-live="polite">
        @if (wizard.readError(); as error) {
          <p
            role="alert"
            class="flex items-start gap-2 rounded-control border border-negative bg-negative-soft p-3 text-sm text-ink"
          >
            <app-icon name="alert" class="mt-0.5 text-negative" />
            <span><strong class="font-semibold">Couldn't read the file.</strong> {{ error }}</span>
          </p>
        }
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <app-field
          label="Delimiter"
          hint="What separates the cells of a row. Detected from your file; change it if the columns look wrong."
        >
          <select appInput [disabled]="wizard.parsing()" (change)="onDelimiter($event)">
            @for (delimiter of delimiters; track delimiter) {
              <option [value]="delimiter" [selected]="delimiter === draft().delimiter">
                {{ delimiterLabels[delimiter] }}
              </option>
            }
          </select>
        </app-field>

        <div class="sm:pt-7">
          <label class="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              class="mt-0.5 size-6 shrink-0 accent-accent"
              [checked]="draft().hasHeader"
              (change)="onHeader($event)"
            />
            <span class="min-w-0">
              <span class="block text-sm font-medium">First row is a header</span>
              <span class="block text-sm text-muted"
                >Column names, not a transaction. Turn it off if the first row is data.</span
              >
            </span>
          </label>
        </div>
      </div>

      @if (wizard.parsing()) {
        <p role="status" class="text-sm text-muted">Reading the file again…</p>
      }

      <div class="grid gap-4 sm:grid-cols-3">
        <app-field label="Date column">
          <select appInput (change)="onColumn('dateColumn', $event)">
            <option value="" [selected]="draft().dateColumn === null">Choose a column</option>
            @for (column of columns(); track column.index) {
              <option [value]="column.index" [selected]="column.index === draft().dateColumn">
                {{ column.label }}
              </option>
            }
          </select>
        </app-field>
        <app-field label="Amount column">
          <select appInput (change)="onColumn('amountColumn', $event)">
            <option value="" [selected]="draft().amountColumn === null">Choose a column</option>
            @for (column of columns(); track column.index) {
              <option [value]="column.index" [selected]="column.index === draft().amountColumn">
                {{ column.label }}
              </option>
            }
          </select>
        </app-field>
        <app-field label="Description column">
          <select appInput (change)="onColumn('descriptionColumn', $event)">
            <option value="" [selected]="draft().descriptionColumn === null">Choose a column</option>
            @for (column of columns(); track column.index) {
              <option [value]="column.index" [selected]="column.index === draft().descriptionColumn">
                {{ column.label }}
              </option>
            }
          </select>
        </app-field>
      </div>
      <p class="-mt-2 text-sm text-muted">
        One amount column: a file with separate debit and credit columns is not supported yet.
      </p>

      <div class="grid gap-4 sm:grid-cols-2">
        <app-field label="Date format" [hint]="dateHint()">
          <select appInput (change)="onDateFormat($event)">
            @for (format of dateFormats; track format) {
              <option [value]="format" [selected]="format === draft().dateFormat">
                {{ format }} ({{ dateExamples[format] }})
              </option>
            }
          </select>
        </app-field>
        <app-field label="Decimal separator" [hint]="amountHint()">
          <select appInput (change)="onDecimal($event)">
            @for (separator of decimalSeparators; track separator) {
              <option [value]="separator" [selected]="separator === draft().decimalSeparator">
                {{ decimalLabels[separator] }}
              </option>
            }
          </select>
        </app-field>
      </div>

      <div>
        <app-field label="Sign of an expense" [hint]="signHint()">
          <select appInput (change)="onSign($event)">
            @for (convention of signConventions; track convention) {
              <option [value]="convention" [selected]="convention === draft().signConvention">
                {{ signLabels[convention] }}
              </option>
            }
          </select>
        </app-field>
      </div>

      @if (wizard.parse(); as parse) {
        <div
          role="region"
          aria-label="The first rows of the file"
          tabindex="0"
          class="overflow-x-auto rounded-card border border-line"
        >
          <table class="w-full min-w-[32rem] border-collapse text-left text-sm">
            <caption class="sr-only">
              The first rows of the file, with the columns you chose marked in the header
            </caption>
            <thead class="bg-subtle">
              <tr>
                @for (column of columns(); track column.index) {
                  <th scope="col" class="px-3 py-2 align-bottom font-semibold">
                    <span class="block">{{ column.label }}</span>
                    @if (roleOf(column.index); as role) {
                      <span
                        class="mt-1 inline-block rounded-full border border-accent px-2 py-0.5 text-xs font-medium text-accent-text"
                        >{{ role }}</span
                      >
                    }
                  </th>
                }
              </tr>
            </thead>
            <tbody class="divide-y divide-line">
              @for (row of sampleRows(); track $index) {
                <tr>
                  @for (column of columns(); track column.index) {
                    <td class="max-w-[16rem] truncate px-3 py-2">{{ row[column.index] ?? '' }}</td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
        <p class="-mt-3 text-sm text-muted">
          {{ dataRowsText() }}
        </p>
      }

      <app-import-profile-save />

      <div aria-live="polite" class="space-y-2">
        @if (wizard.tooManyRows()) {
          <p
            role="alert"
            class="flex items-start gap-2 rounded-control border border-negative bg-negative-soft p-3 text-sm text-ink"
          >
            <app-icon name="alert" class="mt-0.5 text-negative" />
            <span>
              This file has {{ wizard.dataRows() }} rows. The importer takes at most {{ maxRows }} per
              file: split it and import the parts one by one.
            </span>
          </p>
        }
        @if (review.previewError(); as error) {
          <p
            role="alert"
            class="flex items-start gap-2 rounded-control border border-negative bg-negative-soft p-3 text-sm text-ink"
          >
            <app-icon name="alert" class="mt-0.5 text-negative" />
            <span>
              <strong class="font-semibold">Couldn't check the rows.</strong> {{ error }}
              Nothing was imported.
            </span>
          </p>
        }
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <button appButton variant="secondary" [disabled]="review.previewing()" (click)="wizard.back()">
          Back
        </button>
        <div class="flex flex-wrap items-center gap-3">
          @if (wizard.mappingProblem(); as problem) {
            <p id="mapping-problem" class="text-sm text-muted">{{ problem }}</p>
          }
          <button
            appButton
            [loading]="review.previewing()"
            [disabled]="!wizard.mappingReady()"
            [attr.aria-describedby]="wizard.mappingProblem() ? 'mapping-problem' : null"
            (click)="review.openPreview()"
          >
            Next: review the rows
          </button>
        </div>
      </div>
    </section>
  `,
  host: { class: 'block' },
})
export class ImportMappingStep {
  protected readonly wizard = inject(ImportWizardStore);
  protected readonly review = inject(ImportReviewStore);

  protected readonly delimiters = CSV_DELIMITERS;
  protected readonly delimiterLabels = DELIMITER_LABELS;
  protected readonly dateFormats = IMPORT_DATE_FORMATS;
  protected readonly dateExamples = DATE_FORMAT_EXAMPLES;
  protected readonly decimalSeparators = IMPORT_DECIMAL_SEPARATORS;
  protected readonly decimalLabels = DECIMAL_LABELS;
  protected readonly signConventions = IMPORT_SIGN_CONVENTIONS;
  protected readonly signLabels = SIGN_LABELS;
  protected readonly maxRows = new Intl.NumberFormat('en-US').format(IMPORT_MAX_ROWS);

  protected readonly draft = this.wizard.draft;

  /** The first row of the data: the second record with a header, the first record without one. */
  private readonly firstDataRow = computed<readonly string[] | null>(() => {
    const parse = this.wizard.parse();
    if (!parse) return null;
    return this.draft().hasHeader ? (parse.sample[0]?.cells ?? null) : parse.header;
  });

  /** The columns the pickers offer: the header's names with a header, else "Column N" and a sample. */
  protected readonly columns = computed<readonly ColumnChoice[]>(() => {
    const parse = this.wizard.parse();
    const count = this.wizard.columnCount();
    if (!parse) return [];
    const { hasHeader } = this.draft();
    const names = Array.from({ length: count }, (_, index) => parse.header[index]?.trim() ?? '');
    const sample = this.firstDataRow();

    return names.map((name, index) => {
      if (hasHeader) {
        const repeated = name !== '' && names.filter((other) => other === name).length > 1;
        const label = name === '' ? `Column ${index + 1}` : repeated ? `${name} (column ${index + 1})` : name;
        return { index, label };
      }
      const cell = (sample?.[index] ?? '').trim();
      return { index, label: cell === '' ? `Column ${index + 1}` : `Column ${index + 1}: ${shorten(cell)}` };
    });
  });

  /** The rows of the sample table: the header is not one of them, but without a header the first record is. */
  protected readonly sampleRows = computed<readonly (readonly string[])[]>(() => {
    const parse = this.wizard.parse();
    if (!parse) return [];
    const rows = parse.sample.map((record) => record.cells);
    return this.draft().hasHeader ? rows : [parse.header, ...rows];
  });

  protected readonly dataRowsText = computed(() => {
    const rows = this.wizard.dataRows();
    return `The file has ${rows} data ${rows === 1 ? 'row' : 'rows'}. Only the first few are shown.`;
  });

  /** What the file's first date looks like, to compare with the format. */
  protected readonly dateHint = computed(() => this.hintFor(this.draft().dateColumn, 'date'));
  protected readonly amountHint = computed(() => this.hintFor(this.draft().amountColumn, 'amount'));

  /** The sign convention in plain words, with the file's first amount when a column is chosen. */
  protected readonly signHint = computed(() => {
    const first = this.hintFor(this.draft().amountColumn, 'amount');
    const rule =
      this.draft().signConvention === 'expenses_negative'
        ? 'A bank amount of -12.30 is money you spent, and +5.00 is money that came in (a credit).'
        : 'A bank amount of 12.30 is money you spent, and -5.00 is money that came in (a credit).';
    return first ? `${rule} ${first}` : rule;
  });

  private hintFor(column: number | null, what: 'date' | 'amount'): string | undefined {
    if (column === null) return undefined;
    const cell = this.firstDataRow()?.[column]?.trim();
    return cell ? `Your file's first ${what} reads "${cell}".` : undefined;
  }

  protected roleOf(index: number): string | null {
    const { dateColumn, amountColumn, descriptionColumn } = this.draft();
    if (index === dateColumn) return 'Date';
    if (index === amountColumn) return 'Amount';
    if (index === descriptionColumn) return 'Description';
    return null;
  }

  protected onDelimiter(event: Event): void {
    void this.wizard.setDelimiter((event.target as HTMLSelectElement).value as CsvDelimiter);
  }

  protected onHeader(event: Event): void {
    this.wizard.patchMapping({ hasHeader: (event.target as HTMLInputElement).checked });
  }

  protected onColumn(key: ColumnKey, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.wizard.patchMapping({ [key]: value === '' ? null : Number(value) } as Pick<MappingDraft, ColumnKey>);
  }

  protected onDateFormat(event: Event): void {
    this.wizard.patchMapping({ dateFormat: (event.target as HTMLSelectElement).value as ImportDateFormat });
  }

  protected onDecimal(event: Event): void {
    this.wizard.patchMapping({
      decimalSeparator: (event.target as HTMLSelectElement).value as ImportDecimalSeparator,
    });
  }

  protected onSign(event: Event): void {
    this.wizard.patchMapping({
      signConvention: (event.target as HTMLSelectElement).value as ImportSignConvention,
    });
  }
}
