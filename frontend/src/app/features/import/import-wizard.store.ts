import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import {
  type CsvDelimiter,
  IMPORT_MAX_BODY_BYTES,
  IMPORT_MAX_COLUMN_INDEX,
  IMPORT_MAX_ROWS,
  type ImportDateFormat,
  type ImportDecimalSeparator,
  type ImportMapping,
  importMappingSchema,
  type ImportParseResponse,
  type ImportProfileDto,
  type ImportSignConvention,
} from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { apiErrorDetails, parseApiError } from '../../core/api-error';
import { formatBytes } from '../../shared/format';
import { SettingsStore } from '../../core/settings.store';
import { type CsvEncoding, decodeCsvBytes } from './decode-csv';
import { ImportApi } from './import.api';
import { ImportProfilesStore } from './import-profiles.store';

export type WizardStep = 'file' | 'mapping' | 'preview' | 'done';

/** The steps in order, with the name the stepper shows. */
export const WIZARD_STEPS: readonly { id: WizardStep; label: string }[] = [
  { id: 'file', label: 'File' },
  { id: 'mapping', label: 'Columns' },
  { id: 'preview', label: 'Review' },
  { id: 'done', label: 'Done' },
];

/** The file the user chose, read and decoded: the text is what every call sends again. */
export interface LoadedFile {
  name: string;
  sizeBytes: number;
  text: string;
  encoding: CsvEncoding;
}

/**
 * A mapping while it is being filled in. The three columns are `null` until chosen; once they are
 * three different columns it is an `ImportMapping` (see `ImportWizardStore.mapping`).
 */
export interface MappingDraft {
  delimiter: CsvDelimiter;
  hasHeader: boolean;
  dateColumn: number | null;
  amountColumn: number | null;
  descriptionColumn: number | null;
  dateFormat: ImportDateFormat;
  decimalSeparator: ImportDecimalSeparator;
  signConvention: ImportSignConvention;
}

export const INITIAL_MAPPING: MappingDraft = {
  delimiter: ',',
  hasHeader: true,
  dateColumn: null,
  amountColumn: null,
  descriptionColumn: null,
  dateFormat: 'YYYY-MM-DD',
  decimalSeparator: '.',
  signConvention: 'expenses_negative',
};

/** The most header cells, and the longest cell, a saved profile keeps. */
const HEADER_CELLS_MAX = 100;
const HEADER_CELL_LENGTH_MAX = 200;

/** `text` cut to `max` UTF-16 units, never inside a surrogate pair. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  const splitsPair = code >= 0xd800 && code <= 0xdbff;
  return text.slice(0, splitsPair ? max - 1 : max);
}

/**
 * The header of the file as a profile keeps it: at most 100 cells of at most 200 characters (what
 * `POST /api/import/profiles` accepts).
 */
export function profileHeader(header: readonly string[]): string[] {
  return header.slice(0, HEADER_CELLS_MAX).map((cell) => truncate(cell, HEADER_CELL_LENGTH_MAX));
}

/**
 * The state of the import wizard up to the mapping: where the user is, the file, what `parse` said
 * about it and the mapping being filled in. It lives in one place so that Back keeps every choice.
 * The server is the only reader of the file: this holds its text and sends it with each call.
 *
 * What comes after (the preview, the rows chosen and the commit) is `ImportReviewStore`.
 *
 * Provided by the import page, so each visit starts empty and the file (up to 10 MiB of text) is
 * let go of when the user leaves.
 */
@Injectable()
export class ImportWizardStore {
  private readonly api = inject(ImportApi);
  private readonly settings = inject(SettingsStore);
  private readonly profileStore = inject(ImportProfilesStore);

  readonly step = signal<WizardStep>('file');

  readonly file = signal<LoadedFile | null>(null);
  /** Changes with every file chosen: something that depends on the file can tell it was replaced. */
  readonly fileVersion = signal(0);
  /** The file is being read, or its first parse is on its way. */
  readonly reading = signal(false);
  /** A new parse is on its way (the delimiter changed). */
  readonly parsing = signal(false);
  /** Why the file could not be used, or why the last parse failed. Shown on the step that is open. */
  readonly readError = signal<string | null>(null);
  readonly parse = signal<ImportParseResponse | null>(null);

  readonly draft = signal<MappingDraft>(INITIAL_MAPPING);

  /** The profile picked (or suggested) in the profile list. */
  readonly selectedProfileId = signal<number | null>(null);
  /** What the profile did, for a polite live region: "Using your profile …". */
  readonly profileNotice = signal<string | null>(null);

  private fileToken = 0;
  private parseToken = 0;
  private suggestionHandled = false;

  /** The data rows of the file under the header choice: every record, less the header row if any. */
  readonly dataRows = computed(() => {
    const parse = this.parse();
    if (!parse) return 0;
    return Math.max(0, parse.recordCount - (this.draft().hasHeader ? 1 : 0));
  });
  readonly tooManyRows = computed(() => this.dataRows() > IMPORT_MAX_ROWS);

  /** How many columns the pickers offer: the widest record, and no more than a mapping can address. */
  readonly columnCount = computed(() =>
    Math.min(this.parse()?.columnCount ?? 0, IMPORT_MAX_COLUMN_INDEX + 1),
  );

  /** What is missing or wrong in the mapping, in words, or null when it is a valid one. */
  readonly mappingProblem = computed<string | null>(() => {
    const { dateColumn, amountColumn, descriptionColumn } = this.draft();
    const columns = [dateColumn, amountColumn, descriptionColumn];
    if (columns.some((column) => column === null)) {
      return 'Choose the date, amount and description columns.';
    }
    if (new Set(columns).size < 3) {
      return 'The date, amount and description must be three different columns.';
    }
    const count = this.columnCount();
    if (columns.some((column) => (column as number) >= count)) {
      return 'A chosen column is not in the file with this delimiter. Choose the columns again.';
    }
    return importMappingSchema.safeParse(this.draft()).success
      ? null
      : 'The mapping is not valid. Check the columns and formats.';
  });

  /** The mapping the API takes, or null until the draft is a valid one. */
  readonly mapping = computed<ImportMapping | null>(() => {
    if (this.mappingProblem() !== null) return null;
    const result = importMappingSchema.safeParse(this.draft());
    return result.success ? result.data : null;
  });

  /** The file was read and has at least one record: the mapping step has something to work with. */
  readonly fileReady = computed(() => {
    const parse = this.parse();
    return this.file() !== null && parse !== null && parse.recordCount > 0;
  });

  /** The mapping is valid and the file has rows to import, and not too many. */
  readonly mappingReady = computed(
    () =>
      this.fileReady() && this.mapping() !== null && this.dataRows() > 0 && !this.tooManyRows(),
  );

  /** Something the user would lose by leaving: a file was read and nothing was imported yet. */
  readonly hasWork = computed(() => this.step() !== 'done' && this.parse() !== null);

  constructor() {
    // The profile the server recognised in the file is applied once, as soon as the profiles are in.
    effect(() => {
      const parse = this.parse();
      const state = this.profileStore.state();
      if (parse === null || state === 'loading' || this.suggestionHandled) return;
      const profiles = this.profileStore.profiles();
      untracked(() => {
        this.suggestionHandled = true;
        const suggested = profiles.find((profile) => profile.id === parse.suggestedProfileId);
        if (suggested) void this.applyProfile(suggested, 'suggested');
      });
    });
  }

  // --- the file ---------------------------------------------------------------------------------

  /**
   * Reads and decodes the file the user chose, then asks the server what is in it. Anything the user
   * had before (the file, the mapping, a preview) is dropped: it was about another file. A file above
   * the size the server takes is refused here, with no request.
   */
  async loadFile(file: File): Promise<void> {
    const token = ++this.fileToken;
    this.clearFile();
    this.reading.set(false);
    const locale = this.settings.locale();

    if (file.size > IMPORT_MAX_BODY_BYTES) {
      this.readError.set(
        `${file.name} is ${formatBytes(file.size, locale)}, which is more than the ${formatBytes(IMPORT_MAX_BODY_BYTES, locale)} the importer takes. Split the file and import the parts one by one.`,
      );
      return;
    }

    this.reading.set(true);
    try {
      const bytes = await file.arrayBuffer();
      if (token !== this.fileToken) return;
      const { text, encoding } = decodeCsvBytes(bytes);
      this.file.set({ name: file.name, sizeBytes: file.size, text, encoding });
      await this.runParse(undefined, text);
    } catch {
      if (token === this.fileToken) {
        this.readError.set(`Couldn't read ${file.name}. Check that it is a text file and try again.`);
      }
    } finally {
      if (token === this.fileToken) this.reading.set(false);
    }
  }

  /** Asks the server for the delimiter (detected unless named), the header, the sample and the profile. */
  private async runParse(delimiter: CsvDelimiter | undefined, csv: string): Promise<void> {
    const token = ++this.parseToken;
    this.readError.set(null);
    try {
      const response = await firstValueFrom(
        this.api.parse(delimiter === undefined ? { csv } : { csv, delimiter }),
      );
      if (token !== this.parseToken) return;
      this.parse.set(response);
      this.draft.update((draft) => ({ ...draft, delimiter: response.delimiter }));
    } catch (error) {
      if (token !== this.parseToken) return;
      const parsed = parseApiError(error);
      this.readError.set(parsed.status === 413 ? this.tooLargeMessage(error) : parsed.message);
    }
  }

  /** The server's 413 `payload_too_large`, in words, with its limit when it says what it is. */
  private tooLargeMessage(error: unknown): string {
    const details = apiErrorDetails(error) as { limitBytes?: unknown } | undefined;
    const limit =
      typeof details?.limitBytes === 'number'
        ? ` (the limit is ${formatBytes(details.limitBytes, this.settings.locale())})`
        : '';
    return `The server refused the file as too large${limit}. Split it and import the parts one by one.`;
  }

  /** Forgets the file and everything that came from it, but not the profiles. */
  private clearFile(): void {
    this.fileVersion.update((version) => version + 1);
    this.parseToken++;
    this.file.set(null);
    this.parse.set(null);
    this.readError.set(null);
    this.parsing.set(false);
    this.draft.set(INITIAL_MAPPING);
    this.selectedProfileId.set(null);
    this.profileNotice.set(null);
    this.suggestionHandled = false;
    this.step.set('file');
  }

  /** Starts over: no file, the first step. */
  reset(): void {
    this.fileToken++;
    this.reading.set(false);
    this.clearFile();
  }

  // --- the mapping ------------------------------------------------------------------------------

  /** Changes some fields of the mapping. A change of the delimiter goes through `setDelimiter`. */
  patchMapping(patch: Partial<Omit<MappingDraft, 'delimiter'>>): void {
    this.draft.update((draft) => ({ ...draft, ...patch }));
  }

  /**
   * Reads the file again with another delimiter. The columns were chosen against the old split, so
   * they are cleared: the user chooses them again from the new sample.
   */
  async setDelimiter(delimiter: CsvDelimiter): Promise<void> {
    const file = this.file();
    if (file === null || delimiter === this.draft().delimiter) return;
    this.draft.update((draft) => ({
      ...draft,
      delimiter,
      dateColumn: null,
      amountColumn: null,
      descriptionColumn: null,
    }));
    this.parsing.set(true);
    try {
      await this.runParse(delimiter, file.text);
    } finally {
      this.parsing.set(false);
    }
  }

  // --- profiles ---------------------------------------------------------------------------------

  /**
   * Fills the mapping in from a saved profile. When its delimiter is not the one the file was read
   * with, the file is read again with it, so the sample and the columns match.
   */
  async applyProfile(profile: ImportProfileDto, how: 'suggested' | 'chosen'): Promise<void> {
    const file = this.file();
    if (file === null) return;
    this.selectedProfileId.set(profile.id);
    this.draft.set({ ...profile.mapping });
    this.profileNotice.set(
      how === 'suggested'
        ? `This file looks like your "${profile.name}" profile, so its columns and formats are filled in. Check them against the first rows below.`
        : `Profile "${profile.name}" applied. Check the columns against the first rows below.`,
    );
    if (profile.mapping.delimiter !== this.parse()?.delimiter) {
      this.parsing.set(true);
      try {
        await this.runParse(profile.mapping.delimiter, file.text);
      } finally {
        this.parsing.set(false);
      }
    }
  }

  /** Stops using a profile: the mapping stays as it is, the picker says "none". */
  clearProfile(): void {
    this.selectedProfileId.set(null);
    this.profileNotice.set(null);
  }

  // --- the steps --------------------------------------------------------------------------------

  /** Whether the wizard may be at `step` now: a step needs what the steps before it produce. */
  canGoTo(step: WizardStep): boolean {
    switch (step) {
      case 'file':
        return this.step() !== 'done';
      case 'mapping':
        return this.fileReady() && this.step() !== 'done';
      case 'preview':
        return this.mappingReady() && this.step() !== 'done';
      case 'done':
        return true;
    }
  }

  /** Moves to a step, if the wizard may be there. Returns whether it moved. */
  goTo(step: WizardStep): boolean {
    if (!this.canGoTo(step)) return false;
    this.step.set(step);
    return true;
  }

  /** One step back, keeping everything. Not from the first step, and not out of "done". */
  back(): void {
    const step = this.step();
    if (step === 'preview') this.step.set('mapping');
    else if (step === 'mapping') this.step.set('file');
  }
}
