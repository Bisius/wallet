import { Component, ElementRef, inject, viewChild } from '@angular/core';
import { IMPORT_MAX_BODY_BYTES, IMPORT_MAX_ROWS } from '@wallet/shared';
import { SettingsStore } from '../../core/settings.store';
import { formatBytes } from '../../shared/format';
import { AppInput } from '../../shared/forms/app-input';
import { Field } from '../../shared/forms/field';
import { Button } from '../../shared/ui/button';
import { Icon } from '../../shared/ui/icon';
import { LoadingState } from '../../shared/ui/states';
import { encodingNote } from './decode-csv';
import { DELIMITER_LABELS } from './import-text';
import { ImportWizardStore } from './import-wizard.store';

/**
 * Step 1: choose the file. It is read here (as UTF-8, else windows-1252) and kept in memory; the
 * server is asked what it holds (`POST /api/import/parse`) and answers with the delimiter it
 * detected, the number of rows and the columns. A file the server cannot take is refused with the
 * reason, before or after the request. The file is sent again with every later call: the server
 * keeps nothing.
 */
@Component({
  selector: 'app-import-file-step',
  imports: [Field, AppInput, Button, Icon, LoadingState],
  template: `
    <section aria-labelledby="import-file-heading" class="card max-w-2xl space-y-4">
      <h2 #heading id="import-file-heading" tabindex="-1" class="text-xl font-semibold tracking-tight">
        Choose your bank's file
      </h2>
      <p class="text-sm text-muted">
        A .csv or .txt file with one row per transaction, up to {{ maxSize }} and
        {{ maxRows }} rows. It is read in your browser and sent to your own Wallet server. Nothing is
        stored until you confirm the last step.
      </p>

      <app-field label="CSV file">
        <input
          #picker
          appInput
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          class="file:mr-3 file:cursor-pointer file:rounded-control file:border-0 file:bg-subtle file:px-3 file:py-1 file:font-medium file:text-ink"
          (change)="onPick($event)"
        />
      </app-field>

      @if (wizard.reading()) {
        <app-loading-state label="Reading the file…" />
      }

      <div aria-live="polite">
        @if (wizard.readError(); as error) {
          <p
            role="alert"
            class="flex items-start gap-2 rounded-control border border-negative bg-negative-soft p-3 text-sm text-ink"
          >
            <app-icon name="alert" class="mt-0.5 text-negative" />
            <span>
              <strong class="font-semibold">Couldn't use this file.</strong> {{ error }}
            </span>
          </p>
        }
      </div>

      @if (wizard.file(); as file) {
        @if (wizard.parse(); as parse) {
          <dl class="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            <dt class="font-medium">File</dt>
            <dd class="break-all">{{ file.name }} ({{ size(file.sizeBytes) }})</dd>
            <dt class="font-medium">Rows found</dt>
            <dd>{{ parse.recordCount }} (the first one may be a header)</dd>
            <dt class="font-medium">Columns</dt>
            <dd>{{ parse.columnCount }}</dd>
            <dt class="font-medium">Cells separated by</dt>
            <dd>{{ delimiterLabels[parse.delimiter] }}, detected</dd>
          </dl>
          @if (note(); as text) {
            <p class="text-sm text-muted">{{ text }}</p>
          }
          @if (parse.recordCount === 0) {
            <p
              role="alert"
              class="flex items-start gap-2 rounded-control border border-negative bg-negative-soft p-3 text-sm text-ink"
            >
              <app-icon name="alert" class="mt-0.5 text-negative" />
              <span>The file has no rows. Choose another file.</span>
            </p>
          }
        }
      }

      <div class="flex justify-end border-t border-line pt-4">
        <button
          appButton
          [disabled]="!wizard.fileReady() || wizard.reading()"
          (click)="wizard.goTo('mapping')"
        >
          Next: choose the columns
        </button>
      </div>
    </section>
  `,
  host: { class: 'block' },
})
export class ImportFileStep {
  protected readonly wizard = inject(ImportWizardStore);
  private readonly settings = inject(SettingsStore);
  private readonly picker = viewChild.required<ElementRef<HTMLInputElement>>('picker');

  protected readonly delimiterLabels = DELIMITER_LABELS;
  protected readonly maxSize = formatBytes(IMPORT_MAX_BODY_BYTES, 'en-US');
  protected readonly maxRows = new Intl.NumberFormat('en-US').format(IMPORT_MAX_ROWS);

  protected size(bytes: number): string {
    return formatBytes(bytes, this.settings.locale());
  }

  protected note(): string | null {
    const file = this.wizard.file();
    return file ? encodingNote(file.encoding) : null;
  }

  protected async onPick(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    await this.wizard.loadFile(file);
    // Choosing the same file again (after fixing it) must count as a change.
    this.picker().nativeElement.value = '';
  }
}
