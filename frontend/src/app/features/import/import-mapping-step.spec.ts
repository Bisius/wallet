import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { IMPORT_MAX_ROWS, importPreviewSchema, type ImportParseResponse } from '@wallet/shared';
import { a11yProblems } from '../../../testing/a11y';
import {
  getByLabel,
  getByRole,
  queryAllByRole,
  queryByRole,
  textOf,
  typeInto,
} from '../../../testing/dom';
import {
  importMapping,
  importProfileDto,
  parseResponse,
  previewResponse,
  previewRow,
} from '../../../testing/fixtures';
import { flushError, settle } from '../../../testing/harness';
import { IMPORT_STORES } from '../../../testing/import-harness';
import {
  answerBudgetsIfAsked,
  describedText,
  type MountOptions,
  mountStep,
  optionTexts,
  SAMPLE_CSV,
  selectedText,
} from '../../../testing/import-steps-helpers';
import { ImportMappingStep } from './import-mapping-step';

/** A file whose columns are named differently from what they hold, so a mix-up cannot go unseen. */
const BANK: ImportParseResponse = parseResponse({
  header: ['Booked', 'Sum', 'Memo', 'Ref'],
  sample: [
    { line: 2, cells: ['25/03/2026', '12,30', 'Coffee', 'a1'] },
    { line: 3, cells: ['26/03/2026', '4,00', 'Lunch', 'a2'] },
  ],
  recordCount: 3,
  columnCount: 4,
});

const PROFILE = importProfileDto({
  id: 4,
  name: 'My bank',
  mapping: importMapping({
    dateColumn: 0,
    amountColumn: 1,
    descriptionColumn: 2,
    dateFormat: 'DD/MM/YYYY',
    decimalSeparator: ',',
    signConvention: 'expenses_positive',
  }),
});

describe('ImportMappingStep', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), ...IMPORT_STORES],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function setup(options: MountOptions = {}) {
    const { fixture, element, wizard } = await mountStep(http, ImportMappingStep, options);
    // The page shows this step while the wizard is on it.
    wizard.goTo('mapping');
    await settle(fixture);
    const t = {
      fixture,
      element,
      wizard,
      section: () => getByRole(element, 'region', 'How is the file laid out?'),
      select: (label: string) => getByLabel<HTMLSelectElement>(element, label),
      table: () => getByRole(element, 'region', 'The first rows of the file'),
      header: () => getByRole(element, 'checkbox', /^First row is a header/) as HTMLInputElement,
      next: () => getByRole(element, 'button', 'Next: review the rows') as HTMLButtonElement,
      back: () => getByRole(element, 'button', 'Back') as HTMLButtonElement,
      alerts: () => queryAllByRole(element, 'alert').map(textOf),
      /** What the Next button says about why it is off (its description), or null. */
      problem: () => describedText(t.next()) || null,
      choose: async (label: string, value: string) => {
        typeInto(t.select(label), value);
        await settle(fixture);
      },
      /** The first three columns as date, amount and description. */
      mapColumns: async () => {
        await t.choose('Date column', '0');
        await t.choose('Amount column', '1');
        await t.choose('Description column', '2');
      },
      toggleHeader: async () => {
        t.header().click();
        await settle(fixture);
      },
      press: async (button: HTMLElement) => {
        button.click();
        await settle(fixture);
      },
    };
    return t;
  }

  describe('the controls', () => {
    it('is a region named by its heading, which can take focus when the step opens', async () => {
      const t = await setup();

      const heading = getByRole(t.element, 'heading', 'How is the file laid out?');
      expect(t.section().getAttribute('aria-labelledby')).toBe(heading.id);
      expect(heading.getAttribute('tabindex')).toBe('-1');
    });

    it('starts with the delimiter the server detected, a header, ISO dates, dot decimals and negative expenses', async () => {
      const t = await setup({ file: { parse: parseResponse({ delimiter: '|' }) } });

      expect(selectedText(t.select('Delimiter'))).toBe('Pipe (|)');
      expect(t.header().checked).toBe(true);
      expect(selectedText(t.select('Date format'))).toBe('YYYY-MM-DD (2026-03-25)');
      expect(selectedText(t.select('Decimal separator'))).toBe('Dot (1,234.56)');
      expect(selectedText(t.select('Sign of an expense'))).toBe(
        'Expenses are negative (-12.30 is money spent)',
      );
    });

    it('asks for the three columns, which are not chosen yet', async () => {
      const t = await setup();

      for (const label of ['Date column', 'Amount column', 'Description column']) {
        expect(selectedText(t.select(label)), label).toBe('Choose a column');
      }
    });

    it('offers the four delimiters, the eight date formats written with the same day, and both separators and signs', async () => {
      const t = await setup();

      expect(optionTexts(t.select('Delimiter'))).toEqual([
        'Comma (,)',
        'Semicolon (;)',
        'Tab',
        'Pipe (|)',
      ]);
      expect(optionTexts(t.select('Date format'))).toEqual([
        'YYYY-MM-DD (2026-03-25)',
        'YYYY/MM/DD (2026/03/25)',
        'YYYYMMDD (20260325)',
        'DD/MM/YYYY (25/03/2026)',
        'MM/DD/YYYY (03/25/2026)',
        'DD.MM.YYYY (25.03.2026)',
        'DD-MM-YYYY (25-03-2026)',
        'MM-DD-YYYY (03-25-2026)',
      ]);
      expect(optionTexts(t.select('Decimal separator'))).toEqual([
        'Dot (1,234.56)',
        'Comma (1.234,56)',
      ]);
      expect(optionTexts(t.select('Sign of an expense'))).toEqual([
        'Expenses are negative (-12.30 is money spent)',
        'Expenses are positive (12.30 is money spent)',
      ]);
    });

    it('says a file with separate debit and credit columns is not supported yet', async () => {
      const t = await setup();

      expect(textOf(t.section())).toContain(
        'One amount column: a file with separate debit and credit columns is not supported yet.',
      );
    });
  });

  describe('the columns on offer', () => {
    it('are the names of the header, one per column of the file', async () => {
      const t = await setup({ file: { parse: BANK } });

      for (const label of ['Date column', 'Amount column', 'Description column']) {
        expect(optionTexts(t.select(label)), label).toEqual([
          'Choose a column',
          'Booked',
          'Sum',
          'Memo',
          'Ref',
        ]);
      }
    });

    it('are numbered for a column the header does not name, and for a name that is empty', async () => {
      const t = await setup({
        file: { parse: parseResponse({ header: ['Date', '  ', 'Memo'], columnCount: 5 }) },
      });

      expect(optionTexts(t.select('Date column'))).toEqual([
        'Choose a column',
        'Date',
        'Column 2',
        'Memo',
        'Column 4',
        'Column 5',
      ]);
    });

    it('say which is which when a name is repeated', async () => {
      const t = await setup({
        file: { parse: parseResponse({ header: ['Amount', 'Amount', 'Memo'] }) },
      });

      expect(optionTexts(t.select('Amount column'))).toEqual([
        'Choose a column',
        'Amount (column 1)',
        'Amount (column 2)',
        'Memo',
      ]);
    });

    it('are named by the first row of data when the file has no header', async () => {
      const t = await setup({ file: { parse: BANK } });

      await t.toggleHeader();

      expect(optionTexts(t.select('Date column'))).toEqual([
        'Choose a column',
        'Column 1: Booked',
        'Column 2: Sum',
        'Column 3: Memo',
        'Column 4: Ref',
      ]);
    });

    it('show a long first cell cut short', async () => {
      const t = await setup({
        file: {
          parse: parseResponse({
            header: ['Date', 'Amount', 'A very long description of a payment'],
          }),
        },
      });

      await t.toggleHeader();

      expect(optionTexts(t.select('Description column'))).toContain(
        'Column 3: A very long description…',
      );
    });

    it('are still numbered when the first row has an empty cell', async () => {
      const t = await setup({ file: { parse: parseResponse({ header: ['Date', '', 'Memo'] }) } });

      await t.toggleHeader();

      expect(optionTexts(t.select('Date column'))).toEqual([
        'Choose a column',
        'Column 1: Date',
        'Column 2',
        'Column 3: Memo',
      ]);
    });

    it('do not run past the 100 columns a mapping can name', async () => {
      const t = await setup({ file: { parse: parseResponse({ columnCount: 250 }) } });

      expect(optionTexts(t.select('Date column'))).toHaveLength(101);
      expect(optionTexts(t.select('Date column')).at(-1)).toBe('Column 100');
    });
  });

  describe('choosing the columns', () => {
    it('shows the chosen column in each picker, and marks it in the header of the table', async () => {
      const t = await setup({ file: { parse: BANK } });

      await t.choose('Date column', '0');
      await t.choose('Amount column', '1');
      await t.choose('Description column', '2');

      expect(selectedText(t.select('Date column'))).toBe('Booked');
      expect(selectedText(t.select('Amount column'))).toBe('Sum');
      expect(selectedText(t.select('Description column'))).toBe('Memo');
      expect(queryAllByRole(t.table(), 'columnheader').map(textOf)).toEqual([
        'Booked Date',
        'Sum Amount',
        'Memo Description',
        'Ref',
      ]);
    });

    it('moves the mark when a column is chosen for another role', async () => {
      const t = await setup({ file: { parse: BANK } });
      await t.mapColumns();

      await t.choose('Description column', '3');

      expect(queryAllByRole(t.table(), 'columnheader').map(textOf)).toEqual([
        'Booked Date',
        'Sum Amount',
        'Memo',
        'Ref Description',
      ]);
    });

    it('goes back to "Choose a column" when that is chosen again', async () => {
      const t = await setup();
      await t.mapColumns();

      await t.choose('Amount column', '');

      expect(selectedText(t.select('Amount column'))).toBe('Choose a column');
      expect(t.next().disabled).toBe(true);
    });

    it("tells the date format the file's first date, and the amount format its first amount", async () => {
      const t = await setup({ file: { parse: BANK } });
      expect(describedText(t.select('Date format'))).toBe('');
      expect(describedText(t.select('Decimal separator'))).toBe('');

      await t.choose('Date column', '0');
      await t.choose('Amount column', '1');

      expect(describedText(t.select('Date format'))).toBe(
        'Your file\'s first date reads "25/03/2026".',
      );
      expect(describedText(t.select('Decimal separator'))).toBe(
        'Your file\'s first amount reads "12,30".',
      );
    });

    it('explains the sign of an expense in plain words, with the first amount of the file', async () => {
      const t = await setup({ file: { parse: BANK } });
      expect(describedText(t.select('Sign of an expense'))).toBe(
        'A bank amount of -12.30 is money you spent, and +5.00 is money that came in (a credit).',
      );

      await t.choose('Amount column', '1');
      await t.choose('Sign of an expense', 'expenses_positive');

      expect(describedText(t.select('Sign of an expense'))).toBe(
        'A bank amount of 12.30 is money you spent, and -5.00 is money that came in (a credit). Your file\'s first amount reads "12,30".',
      );
    });

    it('reads the hints from the first row when the file has no header, because that row is data', async () => {
      const t = await setup({
        file: {
          parse: parseResponse({
            header: ['25/03/2026', '12,30', 'Coffee'],
            sample: [{ line: 2, cells: ['26/03/2026', '4,00', 'Lunch'] }],
            recordCount: 2,
          }),
        },
      });
      await t.mapColumns();
      expect(describedText(t.select('Date format'))).toBe(
        'Your file\'s first date reads "26/03/2026".',
      );

      await t.toggleHeader();

      expect(describedText(t.select('Date format'))).toBe(
        'Your file\'s first date reads "25/03/2026".',
      );
      expect(describedText(t.select('Decimal separator'))).toBe(
        'Your file\'s first amount reads "12,30".',
      );
    });

    it('says nothing about a first cell that is empty', async () => {
      const t = await setup({
        file: { parse: parseResponse({ sample: [{ line: 2, cells: ['', '-3.50', 'Coffee'] }] }) },
      });

      await t.choose('Date column', '0');

      expect(describedText(t.select('Date format'))).toBe('');
    });
  });

  describe('the first rows of the file', () => {
    it('shows the data rows under the columns, and not the header row', async () => {
      const t = await setup({ file: { parse: BANK } });

      expect(queryAllByRole(t.table(), 'columnheader').map(textOf)).toEqual([
        'Booked',
        'Sum',
        'Memo',
        'Ref',
      ]);
      const text = textOf(t.table());
      expect(text).toContain('25/03/2026 12,30 Coffee a1 26/03/2026 4,00 Lunch a2');
    });

    it('shows the first record as a row of data when the file has no header', async () => {
      const t = await setup({ file: { parse: BANK } });

      await t.toggleHeader();

      expect(textOf(t.table())).toContain(
        'Booked Sum Memo Ref 25/03/2026 12,30 Coffee a1 26/03/2026 4,00 Lunch a2',
      );
    });

    it('leaves a cell empty where a short row has none', async () => {
      const t = await setup({
        file: { parse: parseResponse({ sample: [{ line: 2, cells: ['2026-10-01'] }] }) },
      });

      expect(textOf(t.table())).toContain('2026-10-01');
      expect(textOf(t.table())).not.toContain('undefined');
    });

    it('counts the data rows, less the header, and says only the first are shown', async () => {
      const t = await setup({ file: { parse: parseResponse({ recordCount: 41 }) } });

      expect(textOf(t.section())).toContain(
        'The file has 40 data rows. Only the first few are shown.',
      );

      await t.toggleHeader();

      expect(textOf(t.section())).toContain('The file has 41 data rows.');
    });

    it('speaks of one data row in the singular', async () => {
      const t = await setup({ file: { parse: parseResponse({ recordCount: 2 }) } });

      expect(textOf(t.section())).toContain('The file has 1 data row. Only the first');
    });

    it('can be scrolled with the keyboard, and has a name', async () => {
      const t = await setup();

      expect(t.table().getAttribute('tabindex')).toBe('0');
      expect(getByRole(t.table(), 'table').querySelector('caption')?.textContent).toContain(
        'The first rows of the file',
      );
    });
  });

  describe('the header row', () => {
    it('is on by default, and can be turned off', async () => {
      const t = await setup();
      expect(t.header().checked).toBe(true);

      await t.toggleHeader();

      expect(t.header().checked).toBe(false);
    });

    it('explains the choice', async () => {
      const t = await setup();

      expect(textOf(t.section())).toContain(
        'Column names, not a transaction. Turn it off if the first row is data.',
      );
    });

    it('changes what is sent: without a header the first record is a row to import', async () => {
      const t = await setup();
      await t.mapColumns();
      await t.toggleHeader();

      await t.press(t.next());

      const request = http.expectOne('/api/import/preview');
      expect(request.request.body).toMatchObject({ mapping: { hasHeader: false } });
      request.flush(previewResponse([previewRow()]));
      await settle(t.fixture);
    });
  });

  describe('changing the delimiter', () => {
    it('reads the file again with it, says so meanwhile, and clears the columns that were chosen', async () => {
      const t = await setup();
      await t.mapColumns();
      expect(t.next().disabled).toBe(false);

      await t.choose('Delimiter', ',');

      expect(textOf(getByRole(t.element, 'status', /Reading the file again/))).toBe(
        'Reading the file again…',
      );
      expect(t.select('Delimiter').disabled).toBe(true);
      const request = http.expectOne('/api/import/parse');
      expect(request.request.body).toEqual({ csv: SAMPLE_CSV, delimiter: ',' });
      request.flush(
        parseResponse({
          delimiter: ',',
          header: ['Date;Amount;Description'],
          sample: [{ line: 2, cells: ['2026-10-01;-3.50;Coffee'] }],
          columnCount: 1,
        }),
      );
      await settle(t.fixture);
      await answerBudgetsIfAsked(http, t.fixture);

      expect(queryByRole(t.element, 'status', /Reading the file again/)).toBeNull();
      expect(t.select('Delimiter').disabled).toBe(false);
      expect(selectedText(t.select('Delimiter'))).toBe('Comma (,)');
      expect(optionTexts(t.select('Date column'))).toEqual([
        'Choose a column',
        'Date;Amount;Description',
      ]);
      for (const label of ['Date column', 'Amount column', 'Description column']) {
        expect(selectedText(t.select(label)), label).toBe('Choose a column');
      }
      expect(t.next().disabled).toBe(true);
      expect(t.problem()).toBe('Choose the date, amount and description columns.');
    });

    it('shows why when the file cannot be read with it', async () => {
      const t = await setup();

      await t.choose('Delimiter', '|');
      flushError(http.expectOne('/api/import/parse'), 500, 'internal_error', 'The parser broke');
      await settle(t.fixture);

      expect(t.alerts()).toEqual(["Couldn't read the file. The parser broke"]);
      expect(t.select('Delimiter').disabled).toBe(false);
      expect(queryByRole(t.element, 'status', /Reading the file again/)).toBeNull();
    });

    it('asks for nothing when the delimiter chosen is the one in use', async () => {
      const t = await setup();

      await t.choose('Delimiter', ';');

      http.expectNone('/api/import/parse');
    });
  });

  describe('Next: review the rows', () => {
    it('is off, and says what is missing, until the three columns are chosen', async () => {
      const t = await setup();

      expect(t.next().disabled).toBe(true);
      expect(t.problem()).toBe('Choose the date, amount and description columns.');
      expect(textOf(t.section())).toContain('Choose the date, amount and description columns.');

      await t.choose('Date column', '0');
      await t.choose('Amount column', '1');
      expect(t.next().disabled).toBe(true);
      expect(t.problem()).toBe('Choose the date, amount and description columns.');
    });

    it('is off when two roles share a column, and says so', async () => {
      const t = await setup();
      await t.choose('Date column', '0');
      await t.choose('Amount column', '0');
      await t.choose('Description column', '2');

      expect(t.next().disabled).toBe(true);
      expect(t.problem()).toBe('The date, amount and description must be three different columns.');
    });

    it('is on, with nothing left to explain, once the three columns are different', async () => {
      const t = await setup();

      await t.mapColumns();

      expect(t.next().disabled).toBe(false);
      expect(t.problem()).toBeNull();
      expect(textOf(t.section())).not.toContain('three different columns');
      expect(textOf(t.section())).not.toContain('Choose the date, amount');
    });

    it('asks the server to judge the rows with the file and the mapping as chosen, then opens the review', async () => {
      const t = await setup({ file: { parse: BANK } });
      await t.choose('Date column', '0');
      await t.choose('Amount column', '1');
      await t.choose('Description column', '2');
      await t.choose('Date format', 'DD/MM/YYYY');
      await t.choose('Decimal separator', ',');
      await t.choose('Sign of an expense', 'expenses_positive');

      await t.press(t.next());

      const request = http.expectOne('/api/import/preview');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({
        csv: SAMPLE_CSV,
        mapping: {
          delimiter: ';',
          hasHeader: true,
          dateColumn: 0,
          amountColumn: 1,
          descriptionColumn: 2,
          dateFormat: 'DD/MM/YYYY',
          decimalSeparator: ',',
          signConvention: 'expenses_positive',
        },
      });
      expect(importPreviewSchema.safeParse(request.request.body).success).toBe(true);
      request.flush(previewResponse([previewRow()]));
      await settle(t.fixture);

      expect(t.wizard.step()).toBe('preview');
    });

    it('is busy, and Back is off, while the server judges the rows', async () => {
      const t = await setup();
      await t.mapColumns();

      await t.press(t.next());

      expect(t.next().disabled).toBe(true);
      expect(t.next().getAttribute('aria-busy')).toBe('true');
      expect(t.back().disabled).toBe(true);
      expect(t.wizard.step()).toBe('mapping');
      http.expectOne('/api/import/preview').flush(previewResponse([previewRow()]));
      await settle(t.fixture);
    });

    it('stays on the columns, says nothing was imported and lets the user try again when the rows cannot be judged', async () => {
      const t = await setup();
      await t.mapColumns();
      await t.press(t.next());

      flushError(http.expectOne('/api/import/preview'), 500, 'internal_error', 'The preview broke');
      await settle(t.fixture);

      expect(t.alerts()).toEqual([
        "Couldn't check the rows. The preview broke Nothing was imported.",
      ]);
      expect(t.wizard.step()).toBe('mapping');
      expect(t.next().disabled).toBe(false);
      expect(t.back().disabled).toBe(false);

      await t.press(t.next());
      expect(queryByRole(t.element, 'alert')).toBeNull();
      http.expectOne('/api/import/preview').flush(previewResponse([previewRow()]));
      await settle(t.fixture);
      expect(t.wizard.step()).toBe('preview');
    });

    it('is off for a file with only a header row, which has nothing to import', async () => {
      const t = await setup({ file: { parse: parseResponse({ sample: [], recordCount: 1 }) } });

      await t.mapColumns();

      expect(textOf(t.section())).toContain('The file has 0 data rows.');
      expect(t.next().disabled).toBe(true);
    });

    it('is on for a file of one data row', async () => {
      const t = await setup({
        file: {
          parse: parseResponse({
            sample: [{ line: 2, cells: ['2026-10-01', '-3.50', 'Coffee'] }],
            recordCount: 2,
          }),
        },
      });

      await t.mapColumns();

      expect(t.next().disabled).toBe(false);
    });
  });

  describe('a file with too many rows', () => {
    it('says how many rows it has and what the limit is, and cannot go on', async () => {
      const t = await setup({
        file: { parse: parseResponse({ recordCount: IMPORT_MAX_ROWS + 2 }) },
      });

      await t.mapColumns();

      expect(t.alerts()).toEqual([
        'This file has 10001 rows. The importer takes at most 10,000 per file: split it and import the parts one by one.',
      ]);
      expect(t.next().disabled).toBe(true);
    });

    it('counts the header row as data once it is turned off', async () => {
      const t = await setup({
        file: { parse: parseResponse({ recordCount: IMPORT_MAX_ROWS + 1 }) },
      });
      await t.mapColumns();
      expect(t.alerts()).toEqual([]);
      expect(t.next().disabled).toBe(false);

      await t.toggleHeader();

      expect(t.alerts()).toEqual([
        'This file has 10001 rows. The importer takes at most 10,000 per file: split it and import the parts one by one.',
      ]);
      expect(t.next().disabled).toBe(true);
    });

    it('takes a file of exactly the limit', async () => {
      const t = await setup({
        file: { parse: parseResponse({ recordCount: IMPORT_MAX_ROWS + 1 }) },
      });

      await t.mapColumns();

      expect(queryByRole(t.element, 'alert')).toBeNull();
      expect(t.next().disabled).toBe(false);
    });
  });

  describe('Back', () => {
    it('goes back to the file step, keeping what was chosen', async () => {
      const t = await setup();
      await t.mapColumns();
      expect(t.wizard.step()).toBe('mapping');

      await t.press(t.back());

      expect(t.wizard.step()).toBe('file');
      expect(t.wizard.mapping()).toEqual(importMapping());
    });
  });

  describe('saved profiles', () => {
    it('lists the profiles in the picker and offers to save these settings', async () => {
      const t = await setup({ profiles: [PROFILE] });

      expect(optionTexts(t.select('Saved profile'))).toEqual([
        'None: set the columns below',
        'My bank',
      ]);
      expect(getByRole(t.element, 'button', 'Manage profiles')).toBeTruthy();
      expect(textOf(t.element)).toContain('Save these settings as a profile');
    });

    it('fills in the columns and formats of the profile the server recognised, and says so', async () => {
      const t = await setup({
        profiles: [PROFILE],
        file: { parse: { ...BANK, suggestedProfileId: 4 } },
      });

      expect(selectedText(t.select('Saved profile'))).toBe('My bank');
      expect(selectedText(t.select('Date column'))).toBe('Booked');
      expect(selectedText(t.select('Amount column'))).toBe('Sum');
      expect(selectedText(t.select('Description column'))).toBe('Memo');
      expect(selectedText(t.select('Date format'))).toBe('DD/MM/YYYY (25/03/2026)');
      expect(selectedText(t.select('Decimal separator'))).toBe('Comma (1.234,56)');
      expect(selectedText(t.select('Sign of an expense'))).toBe(
        'Expenses are positive (12.30 is money spent)',
      );
      expect(textOf(getByRole(t.element, 'status', /looks like your/))).toBe(
        'This file looks like your "My bank" profile, so its columns and formats are filled in. Check them against the first rows below.',
      );
      expect(t.next().disabled).toBe(false);
    });

    it('fills in the controls when a profile is picked, and the user may still change them', async () => {
      const t = await setup({ profiles: [PROFILE], file: { parse: BANK } });

      await t.choose('Saved profile', '4');
      expect(selectedText(t.select('Date column'))).toBe('Booked');
      expect(selectedText(t.select('Date format'))).toBe('DD/MM/YYYY (25/03/2026)');
      expect(t.next().disabled).toBe(false);

      await t.choose('Date format', 'MM/DD/YYYY');
      expect(selectedText(t.select('Date format'))).toBe('MM/DD/YYYY (03/25/2026)');
    });

    it('asks to choose the columns again when the profile names a column this file does not have', async () => {
      const wide = importProfileDto({
        id: 7,
        name: 'Wide bank',
        mapping: importMapping({ dateColumn: 0, amountColumn: 1, descriptionColumn: 8 }),
      });
      const t = await setup({ profiles: [wide], file: { parse: BANK } });

      await t.choose('Saved profile', '7');

      expect(t.next().disabled).toBe(true);
      expect(t.problem()).toBe(
        'A chosen column is not in the file with this delimiter. Choose the columns again.',
      );
    });

    it('lets the mapping be set by hand when the profiles cannot be loaded', async () => {
      const t = await setup({ profiles: 'error' });

      expect(textOf(t.section())).toContain(
        'The saved profiles could not be loaded, so none was applied.',
      );
      await t.mapColumns();

      expect(t.next().disabled).toBe(false);
    });
  });

  describe('for a keyboard and a screen reader', () => {
    it('labels every control and has nothing a screen reader cannot use, at every stage', async () => {
      const t = await setup({ profiles: [PROFILE], file: { parse: BANK } });
      for (const label of [
        'Saved profile',
        'Delimiter',
        'Date column',
        'Amount column',
        'Description column',
        'Date format',
        'Decimal separator',
        'Sign of an expense',
      ]) {
        expect(t.select(label), label).toBeTruthy();
      }
      expect(t.header()).toBeTruthy();
      expect(a11yProblems(t.element)).toEqual([]);

      await t.mapColumns();
      expect(a11yProblems(t.element)).toEqual([]);

      await t.toggleHeader();
      expect(a11yProblems(t.element)).toEqual([]);

      await t.press(t.next());
      flushError(http.expectOne('/api/import/preview'), 500, 'internal_error', 'The preview broke');
      await settle(t.fixture);
      expect(t.alerts()).toHaveLength(1);
      expect(a11yProblems(t.element)).toEqual([]);
    });

    it('announces the errors in live regions that are in the page before the error', async () => {
      const t = await setup({
        file: { parse: parseResponse({ recordCount: IMPORT_MAX_ROWS + 1 }) },
      });
      const before = Array.from(t.element.querySelectorAll('[aria-live="polite"]'));
      expect(queryByRole(t.element, 'alert')).toBeNull();

      await t.toggleHeader();

      expect(before).toContain(getByRole(t.element, 'alert').closest('[aria-live="polite"]'));
    });
  });
});
