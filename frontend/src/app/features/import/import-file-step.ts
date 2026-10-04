import { Component, ElementRef, inject, viewChild } from '@angular/core';
import { IMPORT_MAX_BODY_BYTES, IMPORT_MAX_ROWS } from '@wallet/shared';
import { SettingsStore } from '../../core/settings.store';
import { formatBytes } from '../../shared/format';
import { AppInput } from '../../shared/forms/app-input';
import { Field } from '../../shared/forms/field';
import { AppSection, SectionHelp } from '../../shared/ui/section';
import { Alert } from '../../shared/ui/alert';
import { Button } from '../../shared/ui/button';
import { KeyValue, KeyValues } from '../../shared/ui/key-values';
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
  imports: [
    AppSection,
    SectionHelp,
    Alert,
    Field,
    AppInput,
    Button,
    KeyValue,
    KeyValues,
    LoadingState,
  ],
  template: `
    <app-section
      heading="Choose your bank's file"
      description="A .csv or .txt file with one row per transaction."
      focusable
    >
      <p sectionHelp>{{ limits }}</p>
      <p sectionHelp>
        It is read in your browser and sent to your own Wallet server. Nothing is stored until you
        confirm the last step.
      </p>

      <app-field label="CSV file">
        <input
          #picker
          appInput
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          (change)="onPick($event)"
        />
      </app-field>

      @if (wizard.reading()) {
        <app-loading-state label="Reading the file…" />
      }

      <div aria-live="polite">
        @if (wizard.readError(); as error) {
          <app-alert tone="error">
            <strong class="font-semibold">Couldn't use this file.</strong> {{ error }}
          </app-alert>
        }
      </div>

      @if (wizard.file(); as file) {
        @if (wizard.parse(); as parse) {
          <dl appKeyValues>
            <div appKeyValue label="File">
              <span class="break-all">{{ file.name }} ({{ size(file.sizeBytes) }})</span>
            </div>
            <div appKeyValue label="Rows found">
              {{ parse.recordCount }} (the first one may be a header)
            </div>
            <div appKeyValue label="Columns">{{ parse.columnCount }}</div>
            <div appKeyValue label="Cells separated by">
              {{ delimiterLabels[parse.delimiter] }}, detected
            </div>
          </dl>
          @if (note(); as text) {
            <p class="text-sm text-muted">{{ text }}</p>
          }
          @if (parse.recordCount === 0) {
            <app-alert tone="error">The file has no rows. Choose another file.</app-alert>
          }
        }
      }

      <div class="wizard-actions">
        <button
          appButton
          [disabled]="!wizard.fileReady() || wizard.reading()"
          (click)="wizard.goTo('mapping')"
        >
          Next: choose the columns
        </button>
      </div>
    </app-section>
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
  protected readonly limits = `Up to ${this.maxSize} and ${this.maxRows} rows.`;

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
