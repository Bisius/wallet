import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { IMPORT_MAX_BODY_BYTES, IMPORT_MAX_ROWS } from '@wallet/shared';
import { importMapping, importProfileDto, parseResponse } from '../../../testing/fixtures';
import { flushError, settle } from '../../../testing/harness';
import {
  chooseFile,
  csvFile,
  IMPORT_STORES,
  setupWizard,
} from '../../../testing/import-harness';
import { ImportWizardStore, profileHeader } from './import-wizard.store';

const TEXT = 'Date;Amount;Description\n2026-10-01;-3.50;Coffee\n2026-10-02;-12.30;Lunch\n';

describe('ImportWizardStore', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), ...IMPORT_STORES],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  /** The columns of the three-column test file, chosen. */
  const mapColumns = (wizard: ImportWizardStore) =>
    wizard.patchMapping({ dateColumn: 0, amountColumn: 1, descriptionColumn: 2 });

  describe('reading the file', () => {
    it('starts on the first step with nothing chosen', async () => {
      const wizard = await setupWizard(http);

      expect(wizard.step()).toBe('file');
      expect(wizard.file()).toBeNull();
      expect(wizard.parse()).toBeNull();
      expect(wizard.fileReady()).toBe(false);
      expect(wizard.hasWork()).toBe(false);
    });

    it('decodes the file as UTF-8 and sends its text to parse, with no delimiter so the server detects one', async () => {
      const wizard = await setupWizard(http);

      const loading = wizard.loadFile(csvFile('Date;Amount;Description\n2026-10-01;-3,50;Café\n', 'ing.csv'));
      await settle();
      expect(wizard.reading()).toBe(true);
      const request = http.expectOne('/api/import/parse');
      expect(request.request.body).toEqual({ csv: 'Date;Amount;Description\n2026-10-01;-3,50;Café\n' });
      request.flush(parseResponse());
      await loading;

      expect(wizard.reading()).toBe(false);
      expect(wizard.file()).toMatchObject({ name: 'ing.csv', encoding: 'utf-8' });
      expect(wizard.file()?.text).toContain('Café');
      expect(wizard.parse()).toEqual(parseResponse());
      expect(wizard.readError()).toBeNull();
      expect(wizard.fileReady()).toBe(true);
    });

    it('falls back to windows-1252 when the bytes are not valid UTF-8, and sends the decoded text', async () => {
      const wizard = await setupWizard(http);
      // "Café;-3.50" with é as the single byte 0xE9.
      const bytes = new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x3b, 0x2d, 0x33, 0x2e, 0x35, 0x30]);

      const loading = wizard.loadFile(csvFile(bytes, 'old-bank.csv'));
      await settle();
      const request = http.expectOne('/api/import/parse');
      expect(request.request.body).toEqual({ csv: 'Café;-3.50' });
      request.flush(parseResponse());
      await loading;

      expect(wizard.file()?.encoding).toBe('windows-1252');
    });

    it("prefills the delimiter with the detected one", async () => {
      const wizard = await setupWizard(http);

      await chooseFile(http, wizard, csvFile(TEXT), parseResponse({ delimiter: '|' }));

      expect(wizard.draft().delimiter).toBe('|');
    });

    it('refuses a file above the limit with a clear message, before sending anything', async () => {
      const wizard = await setupWizard(http);
      const huge = csvFile('x', 'huge.csv');
      Object.defineProperty(huge, 'size', { value: IMPORT_MAX_BODY_BYTES + 1 });

      await wizard.loadFile(huge);

      http.expectNone('/api/import/parse');
      expect(wizard.file()).toBeNull();
      expect(wizard.readError()).toContain('huge.csv is 10 MB');
      expect(wizard.readError()).toContain('more than the 10 MB the importer takes');
      expect(wizard.fileReady()).toBe(false);
    });

    it('accepts a file of exactly the limit', async () => {
      const wizard = await setupWizard(http);
      const exact = csvFile(TEXT);
      Object.defineProperty(exact, 'size', { value: IMPORT_MAX_BODY_BYTES });

      await chooseFile(http, wizard, exact);

      expect(wizard.readError()).toBeNull();
      expect(wizard.fileReady()).toBe(true);
    });

    it('shows the 400 for a quoted field that is never closed, naming its line', async () => {
      const wizard = await setupWizard(http);

      const loading = wizard.loadFile(csvFile('a;"b\n'));
      await settle();
      flushError(http.expectOne('/api/import/parse'), 400, 'validation_error', 'Validation failed', [
        { path: 'csv', message: 'A quoted field starting on line 1 is never closed' },
      ]);
      await loading;

      expect(wizard.readError()).toBe('Validation failed');
      expect(wizard.parse()).toBeNull();
      expect(wizard.fileReady()).toBe(false);
      expect(wizard.hasWork()).toBe(false);
    });

    it('explains a 413 from the server, with its limit', async () => {
      const wizard = await setupWizard(http);

      const loading = wizard.loadFile(csvFile(TEXT));
      await settle();
      flushError(http.expectOne('/api/import/parse'), 413, 'payload_too_large', 'Too big', {
        limitBytes: IMPORT_MAX_BODY_BYTES,
      });
      await loading;

      expect(wizard.readError()).toBe(
        'The server refused the file as too large (the limit is 10 MB). Split it and import the parts one by one.',
      );
    });

    it('is not ready for an empty file', async () => {
      const wizard = await setupWizard(http);

      await chooseFile(http, wizard, csvFile(''), parseResponse({ header: [], sample: [], recordCount: 0, columnCount: 0 }));

      expect(wizard.parse()?.recordCount).toBe(0);
      expect(wizard.fileReady()).toBe(false);
      expect(wizard.canGoTo('mapping')).toBe(false);
    });

    it('a new file replaces the old one and everything chosen for it', async () => {
      const wizard = await setupWizard(http);
      await chooseFile(http, wizard, csvFile(TEXT, 'one.csv'));
      mapColumns(wizard);
      wizard.goTo('mapping');
      const version = wizard.fileVersion();

      const loading = wizard.loadFile(csvFile(TEXT, 'two.csv'));
      await settle();
      expect(wizard.step()).toBe('file');
      expect(wizard.parse()).toBeNull();
      expect(wizard.draft().dateColumn).toBeNull();
      http.expectOne('/api/import/parse').flush(parseResponse());
      await loading;

      expect(wizard.file()?.name).toBe('two.csv');
      expect(wizard.fileVersion()).toBeGreaterThan(version);
    });

    it('reset starts over', async () => {
      const wizard = await setupWizard(http);
      await chooseFile(http, wizard, csvFile(TEXT));
      mapColumns(wizard);
      wizard.goTo('mapping');

      wizard.reset();

      expect(wizard.step()).toBe('file');
      expect(wizard.file()).toBeNull();
      expect(wizard.parse()).toBeNull();
      expect(wizard.mapping()).toBeNull();
      expect(wizard.hasWork()).toBe(false);
    });
  });

  describe('the delimiter', () => {
    it('reads the file again with the new delimiter and clears the columns, which were chosen against the old split', async () => {
      const wizard = await setupWizard(http);
      await chooseFile(http, wizard, csvFile(TEXT));
      mapColumns(wizard);

      const changing = wizard.setDelimiter(',');
      await settle();
      expect(wizard.parsing()).toBe(true);
      const request = http.expectOne('/api/import/parse');
      expect(request.request.body).toEqual({ csv: TEXT, delimiter: ',' });
      request.flush(parseResponse({ delimiter: ',', header: [TEXT.split('\n')[0]], columnCount: 1 }));
      await changing;

      expect(wizard.parsing()).toBe(false);
      expect(wizard.draft()).toMatchObject({
        delimiter: ',',
        dateColumn: null,
        amountColumn: null,
        descriptionColumn: null,
      });
      expect(wizard.parse()?.columnCount).toBe(1);
      expect(wizard.columnCount()).toBe(1);
    });

    it('does nothing for the delimiter it already has', async () => {
      const wizard = await setupWizard(http);
      await chooseFile(http, wizard, csvFile(TEXT));

      await wizard.setDelimiter(';');

      http.expectNone('/api/import/parse');
    });

    it('shows a parse error and keeps the answer it had', async () => {
      const wizard = await setupWizard(http);
      await chooseFile(http, wizard, csvFile(TEXT));

      const changing = wizard.setDelimiter('|');
      await settle();
      flushError(http.expectOne('/api/import/parse'), 400, 'validation_error', 'A quote is never closed on line 3');
      await changing;

      expect(wizard.readError()).toBe('A quote is never closed on line 3');
      expect(wizard.parse()).toEqual(parseResponse());
      expect(wizard.parsing()).toBe(false);
    });

    it('ignores the answer to a delimiter that is no longer the one asked for', async () => {
      const wizard = await setupWizard(http);
      await chooseFile(http, wizard, csvFile(TEXT));

      const first = wizard.setDelimiter(',');
      await settle();
      const old = http.expectOne('/api/import/parse');
      const second = wizard.setDelimiter('|');
      await settle();
      const recent = http.expectOne('/api/import/parse');
      expect(recent.request.body).toEqual({ csv: TEXT, delimiter: '|' });

      recent.flush(parseResponse({ delimiter: '|', columnCount: 4 }));
      await second;
      old.flush(parseResponse({ delimiter: ',', columnCount: 9 }));
      await first;

      expect(wizard.parse()?.delimiter).toBe('|');
      expect(wizard.parse()?.columnCount).toBe(4);
    });
  });

  describe('the mapping', () => {
    it('is not valid until the three columns are chosen', async () => {
      const wizard = await setupWizard(http);
      await chooseFile(http, wizard, csvFile(TEXT));

      expect(wizard.mapping()).toBeNull();
      expect(wizard.mappingProblem()).toBe('Choose the date, amount and description columns.');
      wizard.patchMapping({ dateColumn: 0, amountColumn: 1 });
      expect(wizard.mapping()).toBeNull();
      expect(wizard.mappingReady()).toBe(false);
    });

    it('needs three different columns', async () => {
      const wizard = await setupWizard(http);
      await chooseFile(http, wizard, csvFile(TEXT));

      wizard.patchMapping({ dateColumn: 0, amountColumn: 0, descriptionColumn: 2 });
      expect(wizard.mappingProblem()).toBe(
        'The date, amount and description must be three different columns.',
      );
      expect(wizard.mapping()).toBeNull();

      wizard.patchMapping({ amountColumn: 2 });
      expect(wizard.mapping()).toBeNull();

      wizard.patchMapping({ amountColumn: 1 });
      expect(wizard.mappingProblem()).toBeNull();
    });

    it('is the ImportMapping of the contract once valid, with 0-based columns and the formats chosen', async () => {
      const wizard = await setupWizard(http);
      await chooseFile(http, wizard, csvFile(TEXT));

      wizard.patchMapping({
        dateColumn: 2,
        amountColumn: 0,
        descriptionColumn: 1,
        hasHeader: false,
        dateFormat: 'DD/MM/YYYY',
        decimalSeparator: ',',
        signConvention: 'expenses_positive',
      });

      expect(wizard.mapping()).toEqual({
        delimiter: ';',
        hasHeader: false,
        dateColumn: 2,
        amountColumn: 0,
        descriptionColumn: 1,
        dateFormat: 'DD/MM/YYYY',
        decimalSeparator: ',',
        signConvention: 'expenses_positive',
      });
    });

    it('rejects a column that the file does not have', async () => {
      const wizard = await setupWizard(http);
      await chooseFile(http, wizard, csvFile(TEXT));

      wizard.patchMapping({ dateColumn: 0, amountColumn: 1, descriptionColumn: 3 });

      expect(wizard.mappingProblem()).toContain('not in the file');
      expect(wizard.mapping()).toBeNull();
    });

    it('offers no more columns than a mapping can address', async () => {
      const wizard = await setupWizard(http);
      await chooseFile(http, wizard, csvFile(TEXT), parseResponse({ columnCount: 250 }));

      expect(wizard.columnCount()).toBe(100);
    });

    it('counts the data rows: every record, less the header when there is one', async () => {
      const wizard = await setupWizard(http);
      await chooseFile(http, wizard, csvFile(TEXT), parseResponse({ recordCount: 3 }));

      expect(wizard.dataRows()).toBe(2);
      wizard.patchMapping({ hasHeader: false });
      expect(wizard.dataRows()).toBe(3);
    });

    it('is not ready for a file with too many rows', async () => {
      const wizard = await setupWizard(http);
      await chooseFile(http, wizard, csvFile(TEXT), parseResponse({ recordCount: IMPORT_MAX_ROWS + 2 }));
      mapColumns(wizard);

      expect(wizard.dataRows()).toBe(IMPORT_MAX_ROWS + 1);
      expect(wizard.tooManyRows()).toBe(true);
      expect(wizard.mappingReady()).toBe(false);

      // Without a header that row is data as well: exactly the limit is fine one row further down.
      wizard.patchMapping({ hasHeader: false });
      expect(wizard.dataRows()).toBe(IMPORT_MAX_ROWS + 2);
      expect(wizard.tooManyRows()).toBe(true);
    });

    it('is ready at exactly the row limit', async () => {
      const wizard = await setupWizard(http);
      await chooseFile(http, wizard, csvFile(TEXT), parseResponse({ recordCount: IMPORT_MAX_ROWS + 1 }));
      mapColumns(wizard);

      expect(wizard.dataRows()).toBe(IMPORT_MAX_ROWS);
      expect(wizard.mappingReady()).toBe(true);
    });

    it('is not ready for a file with only a header', async () => {
      const wizard = await setupWizard(http);
      await chooseFile(http, wizard, csvFile('Date;Amount;Description\n'), parseResponse({ sample: [], recordCount: 1 }));
      mapColumns(wizard);

      expect(wizard.dataRows()).toBe(0);
      expect(wizard.mappingReady()).toBe(false);
    });
  });

  describe('the steps', () => {
    it('lets nothing past the first step until the file is read', async () => {
      const wizard = await setupWizard(http);

      expect(wizard.canGoTo('file')).toBe(true);
      expect(wizard.canGoTo('mapping')).toBe(false);
      expect(wizard.canGoTo('preview')).toBe(false);
      expect(wizard.goTo('mapping')).toBe(false);
      expect(wizard.step()).toBe('file');
    });

    it('lets the user on to the columns once the file is read, but to the review only with a valid mapping', async () => {
      const wizard = await setupWizard(http);
      await chooseFile(http, wizard, csvFile(TEXT));

      expect(wizard.goTo('mapping')).toBe(true);
      expect(wizard.step()).toBe('mapping');
      expect(wizard.goTo('preview')).toBe(false);
      expect(wizard.step()).toBe('mapping');

      mapColumns(wizard);
      expect(wizard.goTo('preview')).toBe(true);
      expect(wizard.step()).toBe('preview');
    });

    it('Back goes one step at a time and keeps every choice', async () => {
      const wizard = await setupWizard(http);
      await chooseFile(http, wizard, csvFile(TEXT));
      wizard.goTo('mapping');
      mapColumns(wizard);
      wizard.patchMapping({ dateFormat: 'DD.MM.YYYY', decimalSeparator: ',', hasHeader: false });
      wizard.goTo('preview');

      wizard.back();
      expect(wizard.step()).toBe('mapping');
      wizard.back();
      expect(wizard.step()).toBe('file');
      wizard.back();
      expect(wizard.step()).toBe('file');

      expect(wizard.file()?.text).toBe(TEXT);
      expect(wizard.draft()).toMatchObject({
        dateColumn: 0,
        amountColumn: 1,
        descriptionColumn: 2,
        dateFormat: 'DD.MM.YYYY',
        decimalSeparator: ',',
        hasHeader: false,
      });
    });

    it('cannot go back from done, nor to any step once done', async () => {
      const wizard = await setupWizard(http);
      await chooseFile(http, wizard, csvFile(TEXT));
      mapColumns(wizard);
      wizard.goTo('done');

      wizard.back();
      expect(wizard.step()).toBe('done');
      expect(wizard.canGoTo('file')).toBe(false);
      expect(wizard.canGoTo('mapping')).toBe(false);
      expect(wizard.canGoTo('preview')).toBe(false);
      expect(wizard.hasWork()).toBe(false);
    });

    it('has work to lose once a file was read, until the import is done', async () => {
      const wizard = await setupWizard(http);
      expect(wizard.hasWork()).toBe(false);

      await chooseFile(http, wizard, csvFile(TEXT));
      expect(wizard.hasWork()).toBe(true);
    });
  });

  describe('profiles', () => {
    const PROFILE = importProfileDto({
      id: 4,
      name: 'ING',
      mapping: importMapping({
        dateColumn: 2,
        amountColumn: 0,
        descriptionColumn: 1,
        dateFormat: 'DD/MM/YYYY',
        decimalSeparator: ',',
        signConvention: 'expenses_positive',
      }),
    });

    it('applies the profile the server recognised in the file, and says so', async () => {
      const wizard = await setupWizard(http, { profiles: [PROFILE] });

      await chooseFile(http, wizard, csvFile(TEXT), parseResponse({ suggestedProfileId: 4 }));

      expect(wizard.selectedProfileId()).toBe(4);
      expect(wizard.draft()).toEqual(PROFILE.mapping);
      expect(wizard.mapping()).toEqual(PROFILE.mapping);
      expect(wizard.profileNotice()).toBe(
        'This file looks like your "ING" profile, so its columns and formats are filled in. Check them against the first rows below.',
      );
    });

    it('reads the file again when the profile has another delimiter than the one detected', async () => {
      const comma = importProfileDto({ id: 5, name: 'Comma bank', mapping: importMapping({ delimiter: ',' }) });
      const wizard = await setupWizard(http, { profiles: [comma] });

      const loading = wizard.loadFile(csvFile(TEXT));
      await settle();
      http.expectOne('/api/import/parse').flush(parseResponse({ delimiter: ';', suggestedProfileId: 5 }));
      await settle();
      const again = http.expectOne('/api/import/parse');
      expect(again.request.body).toEqual({ csv: TEXT, delimiter: ',' });
      again.flush(parseResponse({ delimiter: ',', suggestedProfileId: 5 }));
      await loading;
      await settle();

      expect(wizard.draft().delimiter).toBe(',');
      expect(wizard.parse()?.delimiter).toBe(',');
      // The suggestion came with the first parse and is not applied a second time.
      http.expectNone('/api/import/parse');
    });

    it('applies nothing when the file has no suggestion, or one for a profile that is not there', async () => {
      const wizard = await setupWizard(http, { profiles: [PROFILE] });

      await chooseFile(http, wizard, csvFile(TEXT), parseResponse({ suggestedProfileId: null }));
      expect(wizard.selectedProfileId()).toBeNull();
      expect(wizard.profileNotice()).toBeNull();
      expect(wizard.draft().dateColumn).toBeNull();

      await chooseFile(http, wizard, csvFile(TEXT), parseResponse({ suggestedProfileId: 99 }));
      expect(wizard.selectedProfileId()).toBeNull();
    });

    it('applies nothing, and does not block the mapping by hand, when the profiles cannot be loaded', async () => {
      const wizard = await setupWizard(http, { profiles: 'error' });

      await chooseFile(http, wizard, csvFile(TEXT), parseResponse({ suggestedProfileId: 4 }));
      mapColumns(wizard);

      expect(wizard.selectedProfileId()).toBeNull();
      expect(wizard.mapping()).not.toBeNull();
    });

    it('applies a profile the user picks, and can stop using it without losing the mapping', async () => {
      const wizard = await setupWizard(http, { profiles: [PROFILE] });
      await chooseFile(http, wizard, csvFile(TEXT));
      wizard.profileNotice.set(null);

      await wizard.applyProfile(PROFILE, 'chosen');
      // Its delimiter is the one the file was read with: no need to read it again.
      http.expectNone('/api/import/parse');
      expect(wizard.selectedProfileId()).toBe(4);
      expect(wizard.profileNotice()).toBe(
        'Profile "ING" applied. Check the columns against the first rows below.',
      );

      wizard.clearProfile();
      expect(wizard.selectedProfileId()).toBeNull();
      expect(wizard.profileNotice()).toBeNull();
      expect(wizard.draft().dateColumn).toBe(2);
    });

    it('forgets the profile with the file', async () => {
      const wizard = await setupWizard(http, { profiles: [PROFILE] });
      await chooseFile(http, wizard, csvFile(TEXT), parseResponse({ suggestedProfileId: 4 }));
      expect(wizard.selectedProfileId()).toBe(4);

      await chooseFile(http, wizard, csvFile(TEXT), parseResponse());

      expect(wizard.selectedProfileId()).toBeNull();
      expect(wizard.profileNotice()).toBeNull();
    });
  });
});

describe('profileHeader', () => {
  it('keeps a header that fits as it is', () => {
    expect(profileHeader(['Date', 'Amount'])).toEqual(['Date', 'Amount']);
  });

  it('keeps 100 cells at most', () => {
    const header = Array.from({ length: 130 }, (_, index) => `c${index}`);

    expect(profileHeader(header)).toHaveLength(100);
    expect(profileHeader(header)[99]).toBe('c99');
  });

  it('cuts a cell to 200 characters', () => {
    expect(profileHeader(['x'.repeat(250)])[0]).toHaveLength(200);
  });

  it('never cuts inside a surrogate pair', () => {
    const cell = `${'a'.repeat(199)}😀`;

    const cut = profileHeader([cell])[0];

    expect(cut).toBe('a'.repeat(199));
  });
});
