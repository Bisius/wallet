import { computed, effect, inject, Injectable, Injector, signal, untracked } from '@angular/core';
import type {
  BudgetDto,
  Cents,
  ImportPreviewResponse,
  ImportPreviewRow,
  IsoDate,
  MonthKey,
} from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { apiErrorDetails, parseApiError } from '../../core/api-error';
import { reloaded, resourceState } from '../../core/resource-state';
import { SavingsStore } from '../../core/savings.store';
import { TodayStore } from '../../core/today.store';
import { BudgetsApi } from '../budgets/budgets.api';
import { ImportApi } from './import.api';
import { ImportWizardStore } from './import-wizard.store';

/** How many rows of the preview one page of the table shows. */
export const PAGE_SIZE = 100;

export type RowFilter = 'all' | 'importable' | 'duplicates' | 'credits' | 'errors' | 'needs-budget';

export const ROW_FILTERS: readonly { id: RowFilter; label: string }[] = [
  { id: 'all', label: 'All rows' },
  { id: 'importable', label: 'Ready to import' },
  { id: 'needs-budget', label: 'Needs a budget' },
  { id: 'duplicates', label: 'Already imported' },
  { id: 'credits', label: 'Credits' },
  { id: 'errors', label: 'With errors' },
];

/** What a successful commit leaves: how many spendings, and the months they are dated in. */
export interface CommitSuccess {
  created: number;
  /** Ascending, without repeats. */
  months: readonly MonthKey[];
}

/** A commit that failed with nothing imported, and what the API said. */
export interface CommitFailure {
  status: number;
  message: string;
}

/** A row the commit refused, with every code that applies (as the API sent them). */
export interface RejectedRow {
  line: number;
  codes: readonly string[];
}

/** The budgets that are active in a month: the only ones a spending of that month may belong to. */
export function budgetsActiveIn(budgets: readonly BudgetDto[], month: MonthKey): BudgetDto[] {
  return budgets.filter(
    (budget) =>
      budget.startMonth <= month && (budget.endMonth === null || month <= budget.endMonth),
  );
}

/** A row that can be imported at all: no error, and no spending with its hash stored yet. */
export function isSelectable(row: ImportPreviewRow): boolean {
  return row.errors.length === 0 && !row.duplicate;
}

const monthOf = (date: IsoDate | null): MonthKey | null =>
  date === null ? null : date.slice(0, 7);

/** Reads the rows of a 422 `import_rows_rejected` (`ImportRowsRejectedDetails`), ignoring what is malformed. */
function rejectedRows(details: unknown): RejectedRow[] {
  const rows: unknown = (details as { rows?: unknown } | null | undefined)?.rows;
  if (!Array.isArray(rows)) return [];
  return (rows as unknown[]).flatMap((row) => {
    const { line, errors } = (row ?? {}) as { line?: unknown; errors?: unknown };
    if (typeof line !== 'number' || !Array.isArray(errors)) return [];
    return [
      { line, codes: (errors as unknown[]).filter((c): c is string => typeof c === 'string') },
    ];
  });
}

const NO_LINES: ReadonlySet<number> = new Set();
const NO_CHOICES: ReadonlyMap<number, number | null> = new Map();

/**
 * The review of an import: the preview of the file (`POST /api/import/preview`), which rows the user
 * ticked and the budget each goes to, the filter and page of the table, and the commit
 * (`POST /api/import/commit`). Everything about a row (its date, amount, errors, whether it is a
 * duplicate or a credit, the suggested budget) is the server's; this only holds the choices.
 *
 * Provided by the import page next to `ImportWizardStore`, whose file and mapping it uses.
 */
@Injectable()
export class ImportReviewStore {
  private readonly api = inject(ImportApi);
  private readonly wizard = inject(ImportWizardStore);
  private readonly today = inject(TodayStore);
  private readonly injector = inject(Injector);

  /** Every budget, for the choices of each row. Asked for once a file has been read. */
  private readonly budgetsResource = inject(BudgetsApi).list(() => this.wizard.parse() !== null);
  readonly budgetsState = resourceState(this.budgetsResource);
  readonly budgetsError = computed(() =>
    this.budgetsState() === 'error' ? this.budgetsResource.error() : undefined,
  );
  readonly budgets = computed<readonly BudgetDto[]>(() =>
    this.budgetsResource.hasValue() ? this.budgetsResource.value() : [],
  );

  /** Loads the budgets again (after they failed to load). */
  reloadBudgets(): void {
    this.budgetsResource.reload();
  }

  // --- the preview ------------------------------------------------------------------------------

  readonly preview = signal<ImportPreviewResponse | null>(null);
  readonly previewing = signal(false);
  /** Why the preview could not be made. Shown on the mapping step, where it was asked for. */
  readonly previewError = signal<string | null>(null);
  /** The file and mapping the preview in `preview` was made for. */
  private previewKey: string | null = null;

  readonly rows = computed<readonly ImportPreviewRow[]>(() => this.preview()?.rows ?? []);
  readonly summary = computed(() => this.preview()?.summary ?? null);
  private readonly rowsByLine = computed(
    () => new Map(this.rows().map((row) => [row.line, row] as const)),
  );

  // --- what the user chose ----------------------------------------------------------------------

  /** The lines ticked. Only rows that can be imported are ever in it. */
  readonly checked = signal<ReadonlySet<number>>(NO_LINES);
  /** A budget the user picked for a line (`null`: cleared). A line not in it has the suggestion. */
  private readonly chosen = signal<ReadonlyMap<number, number | null>>(NO_CHOICES);

  readonly filter = signal<RowFilter>('all');
  private readonly requestedPage = signal(0);

  /** The budgets active in the month of each date in the preview: the choices of a row. */
  private readonly optionsByMonth = computed(() => {
    const budgets = this.budgets();
    const options = new Map<MonthKey, readonly BudgetDto[]>();
    for (const row of this.rows()) {
      const month = monthOf(row.date);
      if (month !== null && !options.has(month))
        options.set(month, budgetsActiveIn(budgets, month));
    }
    return options;
  });

  // --- the commit -------------------------------------------------------------------------------

  readonly committing = signal(false);
  /** A commit that failed in a way that is not a list of rows. Nothing was imported. */
  readonly commitFailure = signal<CommitFailure | null>(null);
  /** The rows the last commit refused (422). Nothing was imported. */
  readonly rejected = signal<readonly RejectedRow[]>([]);
  /** Set once a commit succeeded. */
  readonly result = signal<CommitSuccess | null>(null);
  /** What the last "set the budget of the selected rows" did, for a polite live region. */
  readonly bulkNotice = signal<string | null>(null);

  constructor() {
    // A new file (or starting over) makes everything here about another file.
    effect(() => {
      this.wizard.fileVersion();
      untracked(() => this.clear());
    });
  }

  // --- reading a row ----------------------------------------------------------------------------

  /** The budget a row goes to: the user's pick, else the server's suggestion, else none. */
  budgetFor(row: ImportPreviewRow): number | null {
    const picked = this.chosen().get(row.line);
    return picked === undefined ? row.suggestedBudgetId : picked;
  }

  /** The budgets a row may be put in: those active in the month of its date. None without a date. */
  optionsFor(row: ImportPreviewRow): readonly BudgetDto[] {
    const month = monthOf(row.date);
    return month === null ? [] : (this.optionsByMonth().get(month) ?? []);
  }

  isChecked(line: number): boolean {
    return this.checked().has(line);
  }

  private matches(filter: RowFilter, row: ImportPreviewRow): boolean {
    switch (filter) {
      case 'all':
        return true;
      case 'importable':
        return isSelectable(row) && !row.credit;
      case 'duplicates':
        return row.duplicate;
      case 'credits':
        return row.credit;
      case 'errors':
        return row.errors.length > 0;
      case 'needs-budget':
        return isSelectable(row) && this.budgetFor(row) === null;
    }
  }

  /** How many rows each filter shows, for its label. */
  readonly filterCounts = computed<Record<RowFilter, number>>(() => {
    const counts: Record<RowFilter, number> = {
      all: 0,
      importable: 0,
      duplicates: 0,
      credits: 0,
      errors: 0,
      'needs-budget': 0,
    };
    for (const row of this.rows()) {
      for (const { id } of ROW_FILTERS) if (this.matches(id, row)) counts[id]++;
    }
    return counts;
  });

  readonly filteredRows = computed(() => {
    const filter = this.filter();
    return filter === 'all' ? this.rows() : this.rows().filter((row) => this.matches(filter, row));
  });

  readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.filteredRows().length / PAGE_SIZE)),
  );
  /** The page shown, from 0: never past the last one, even when the filter just got shorter. */
  readonly page = computed(() => Math.min(this.requestedPage(), this.pageCount() - 1));
  readonly pageRows = computed(() =>
    this.filteredRows().slice(this.page() * PAGE_SIZE, (this.page() + 1) * PAGE_SIZE),
  );

  // --- what is selected -------------------------------------------------------------------------

  readonly selectedCount = computed(() => this.checked().size);

  /** The ticked rows that have no budget yet: they block the import. */
  readonly selectedWithoutBudget = computed(() => {
    let missing = 0;
    for (const line of this.checked()) {
      const row = this.rowsByLine().get(line);
      if (row && this.budgetFor(row) === null) missing++;
    }
    return missing;
  });

  /**
   * The sum of the ticked rows' amounts in spending sign (credits count as refunds), for the person
   * to compare with their statement. Whole cents added: a sum to look at, not a figure of the ledger.
   */
  readonly selectedTotal = computed<Cents>(() => {
    let total = 0;
    for (const line of this.checked()) total += this.rowsByLine().get(line)?.amount ?? 0;
    return total;
  });

  /** Why the Import button is off, or null when it is on. */
  readonly commitBlocker = computed<string | null>(() => {
    if (this.selectedCount() === 0) return 'Tick at least one row to import.';
    const missing = this.selectedWithoutBudget();
    if (missing > 0) {
      return `${missing} ticked ${missing === 1 ? 'row needs' : 'rows need'} a budget before you can import.`;
    }
    return null;
  });
  readonly canCommit = computed(() => this.commitBlocker() === null && !this.committing());

  // --- changing the choices ---------------------------------------------------------------------

  setFilter(filter: RowFilter): void {
    this.filter.set(filter);
    this.requestedPage.set(0);
  }

  goToPage(page: number): void {
    this.requestedPage.set(Math.min(Math.max(0, page), this.pageCount() - 1));
  }

  /** Ticks or unticks a row. A row that cannot be imported (an error, a duplicate) stays unticked. */
  toggle(line: number, on: boolean): void {
    const row = this.rowsByLine().get(line);
    if (!row || (on && !isSelectable(row))) return;
    this.checked.update((lines) => {
      const next = new Set(lines);
      if (on) next.add(line);
      else next.delete(line);
      return next;
    });
  }

  /**
   * Puts a row in a budget (`null` clears it). A row that is ready to import and was not ticked gets
   * ticked: picking its budget is the decision. A credit is only ever ticked on purpose.
   */
  setBudget(line: number, budgetId: number | null): void {
    const row = this.rowsByLine().get(line);
    if (!row) return;
    this.chosen.update((choices) => new Map(choices).set(line, budgetId));
    if (budgetId !== null && isSelectable(row) && !row.credit) this.toggle(line, true);
  }

  /**
   * Ticks every row of the filter that can be imported. Credits are skipped unless the filter is
   * "Credits": money coming in is ticked on purpose.
   */
  selectMatching(): void {
    const filter = this.filter();
    const lines = this.filteredRows()
      .filter((row) => isSelectable(row) && (!row.credit || filter === 'credits'))
      .map((row) => row.line);
    this.checked.update((current) => new Set([...current, ...lines]));
  }

  /** Unticks every row of the filter. */
  unselectMatching(): void {
    const lines = new Set(this.filteredRows().map((row) => row.line));
    this.checked.update((current) => new Set([...current].filter((line) => !lines.has(line))));
  }

  /**
   * Puts the ticked rows in one budget. A row whose month the budget is not active in is left as it
   * is, and the notice says how many. Returns nothing: the notice is the answer.
   */
  applyBudgetToSelected(budgetId: number): void {
    const budget = this.budgets().find((candidate) => candidate.id === budgetId);
    if (!budget) return;
    const choices = new Map(this.chosen());
    let applied = 0;
    let skipped = 0;
    for (const line of this.checked()) {
      const row = this.rowsByLine().get(line);
      const month = row ? monthOf(row.date) : null;
      if (month !== null && budgetsActiveIn([budget], month).length > 0) {
        choices.set(line, budgetId);
        applied++;
      } else {
        skipped++;
      }
    }
    this.chosen.set(choices);
    const rows = (count: number) => `${count} ${count === 1 ? 'row' : 'rows'}`;
    this.bulkNotice.set(
      `${budget.name} set for ${rows(applied)}.` +
        (skipped > 0
          ? ` ${rows(skipped)} kept ${skipped === 1 ? 'its' : 'their'} budget, because ${budget.name} is not active in ${skipped === 1 ? 'its' : 'their'} month.`
          : ''),
    );
  }

  // --- loading the preview ----------------------------------------------------------------------

  /**
   * Opens the review step. The preview is asked for unless the one already here is for this file and
   * this mapping (going Back and forward again keeps the choices). On failure the step stays where it
   * is and `previewError` says why. Returns whether the review step is open.
   */
  async openPreview(): Promise<boolean> {
    const mapping = this.wizard.mapping();
    if (mapping === null || !this.wizard.mappingReady()) return false;
    const key = `${this.wizard.fileVersion()}|${JSON.stringify(mapping)}`;
    if (this.preview() !== null && this.previewKey === key) return this.wizard.goTo('preview');
    if (!(await this.loadPreview(key, false))) return false;
    return this.wizard.goTo('preview');
  }

  /**
   * Asks for the preview. With `keepChoices` (after a commit was refused) the user's ticks and
   * budgets are kept where they still make sense; otherwise the defaults apply: the rows that are
   * ready to import and have a suggested budget are ticked.
   */
  private async loadPreview(key: string, keepChoices: boolean): Promise<boolean> {
    const file = this.wizard.file();
    const mapping = this.wizard.mapping();
    if (file === null || mapping === null) return false;

    this.previewing.set(true);
    this.previewError.set(null);
    try {
      const response = await firstValueFrom(this.api.preview({ csv: file.text, mapping }));
      if (keepChoices) this.keepChoices(response);
      else this.chooseDefaults(response);
      this.preview.set(response);
      this.previewKey = key;
      this.requestedPage.set(0);
      return true;
    } catch (error) {
      this.previewError.set(parseApiError(error).message);
      return false;
    } finally {
      this.previewing.set(false);
    }
  }

  private chooseDefaults(response: ImportPreviewResponse): void {
    this.checked.set(
      new Set(
        response.rows
          .filter((row) => isSelectable(row) && !row.credit && row.suggestedBudgetId !== null)
          .map((row) => row.line),
      ),
    );
    this.chosen.set(NO_CHOICES);
    this.filter.set('all');
    this.bulkNotice.set(null);
  }

  /**
   * After a refused commit: the fresh preview is the truth. A ticked row that can no longer be
   * imported is unticked, and a budget that is not active in the row's month any more is cleared (the
   * row stays ticked and asks for a budget).
   */
  private keepChoices(response: ImportPreviewResponse): void {
    const rows = new Map(response.rows.map((row) => [row.line, row] as const));
    const budgets = this.budgets();
    const checked = new Set<number>();
    const choices = new Map<number, number | null>();

    for (const [line, budgetId] of this.chosen()) {
      if (rows.has(line)) choices.set(line, budgetId);
    }
    for (const line of this.checked()) {
      const row = rows.get(line);
      if (!row || !isSelectable(row)) continue;
      checked.add(line);
      const picked = choices.get(line);
      const budgetId = picked === undefined ? row.suggestedBudgetId : picked;
      const month = monthOf(row.date);
      const stillActive =
        budgetId !== null &&
        month !== null &&
        budgetsActiveIn(budgets, month).some((budget) => budget.id === budgetId);
      if (budgetId !== null && !stillActive) choices.set(line, null);
    }
    this.checked.set(checked);
    this.chosen.set(choices);
  }

  // --- the commit -------------------------------------------------------------------------------

  /** The lines to send, ascending, each with the budget it goes to. Only meaningful when `canCommit()`. */
  private commitRows(): { line: number; budgetId: number }[] {
    const rows: { line: number; budgetId: number }[] = [];
    for (const line of [...this.checked()].sort((a, b) => a - b)) {
      const row = this.rowsByLine().get(line);
      const budgetId = row ? this.budgetFor(row) : null;
      if (budgetId !== null) rows.push({ line, budgetId });
    }
    return rows;
  }

  /**
   * Stores the ticked rows. It is all or nothing: on success the wizard moves to "done"; when the API
   * refuses some rows (422) their lines and codes are in `rejected` and the preview is made again so
   * the table is current; any other failure is in `commitFailure`. Nothing is imported in a failure.
   */
  async commit(): Promise<void> {
    const file = this.wizard.file();
    const mapping = this.wizard.mapping();
    if (!this.canCommit() || file === null || mapping === null) return;

    const rows = this.commitRows();
    this.committing.set(true);
    this.commitFailure.set(null);
    this.rejected.set([]);
    this.bulkNotice.set(null);
    try {
      const response = await firstValueFrom(this.api.commit({ csv: file.text, mapping, rows }));
      const months = this.monthsOf(rows.map((row) => row.line));
      this.result.set({ created: response.created, months });
      this.refreshSavings(months);
      this.wizard.goTo('done');
    } catch (error) {
      const parsed = parseApiError(error);
      const refused =
        parsed.code === 'import_rows_rejected' ? rejectedRows(apiErrorDetails(error)) : [];
      if (refused.length > 0) {
        this.rejected.set(refused);
        await this.refreshAfterRejection();
      } else {
        this.commitFailure.set({ status: parsed.status, message: parsed.message });
      }
    } finally {
      this.committing.set(false);
    }
  }

  /** The commit was refused: the budgets and the preview may have changed, so load both again. */
  private async refreshAfterRejection(): Promise<void> {
    await reloaded(this.budgetsResource, this.injector);
    const mapping = this.wizard.mapping();
    if (mapping === null) return;
    const key = `${this.wizard.fileVersion()}|${JSON.stringify(mapping)}`;
    await this.loadPreview(key, true);
  }

  /** The months the given lines are dated in, ascending. */
  private monthsOf(lines: readonly number[]): MonthKey[] {
    const months = new Set<MonthKey>();
    for (const line of lines) {
      const month = monthOf(this.rowsByLine().get(line)?.date ?? null);
      if (month !== null) months.add(month);
    }
    return [...months].sort();
  }

  /**
   * Spendings in a closed month change what is due to savings, and the badge in the navigation counts
   * those months, which it only looks at again when the person moves to another page. So an import
   * that touches a month before the current one asks for the overview at once (the same rule as
   * adding a spending to a closed month).
   */
  private refreshSavings(months: readonly MonthKey[]): void {
    const current = this.today.month();
    if (current === undefined || months.some((month) => month < current)) {
      this.injector.get(SavingsStore).refresh();
    }
  }

  // --- starting over ----------------------------------------------------------------------------

  /** Forgets the preview and every choice made on it. */
  clear(): void {
    this.preview.set(null);
    this.previewKey = null;
    this.previewError.set(null);
    this.previewing.set(false);
    this.checked.set(NO_LINES);
    this.chosen.set(NO_CHOICES);
    this.filter.set('all');
    this.requestedPage.set(0);
    this.committing.set(false);
    this.commitFailure.set(null);
    this.rejected.set([]);
    this.result.set(null);
    this.bulkNotice.set(null);
  }
}
