import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { IMPORT_MAX_BODY_BYTES, type ImportParseResponse } from '@wallet/shared';
import { a11yProblems } from '../../../testing/a11y';
import { getByLabel, getByRole, queryByRole, textOf } from '../../../testing/dom';
import { parseResponse } from '../../../testing/fixtures';
import { flushError, settle } from '../../../testing/harness';
import { csvFile, IMPORT_STORES } from '../../../testing/import-harness';
import { mountStep, pickFile, SAMPLE_CSV } from '../../../testing/import-steps-helpers';
import { ImportFileStep } from './import-file-step';

/** A file of this many bytes without holding them: the size is what the step looks at. */
function fileOfSize(bytes: number, name: string): File {
  const file = csvFile('x', name);
  Object.defineProperty(file, 'size', { value: bytes });
  return file;
}

/** Latin-1 text as single bytes, which is how a windows-1252 export writes "é". */
const latin1 = (text: string) => Uint8Array.from(text, (character) => character.charCodeAt(0));

/** UTF-16 little endian with a byte order mark, as "Unicode Text" exports are. */
function utf16le(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes.set([0xff, 0xfe]);
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    bytes[2 + 2 * index] = unit & 0xff;
    bytes[3 + 2 * index] = unit >> 8;
  }
  return bytes;
}

describe('ImportFileStep', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), ...IMPORT_STORES],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function setup() {
    const { fixture, element, wizard } = await mountStep(http, ImportFileStep, { file: null });
    const t = {
      fixture,
      element,
      wizard,
      section: () => getByRole(element, 'region', "Choose your bank's file"),
      input: () => getByLabel(element, 'CSV file'),
      next: () => getByRole(element, 'button', 'Next: choose the columns') as HTMLButtonElement,
      alert: () => queryByRole(element, 'alert'),
      /** Chooses a file and lets it be read: the request for `parse`, if any, is then open. */
      choose: async (file: File) => {
        pickFile(t.input(), file);
        await settle(fixture);
      },
      /** Answers the open request for `parse`. */
      answer: async (response: ImportParseResponse = parseResponse()) => {
        http.expectOne('/api/import/parse').flush(response);
        await settle(fixture);
      },
      /** Chooses a file and the server takes it. */
      load: async (file: File, response: ImportParseResponse = parseResponse()) => {
        await t.choose(file);
        await t.answer(response);
      },
      /** Chooses a file and the server refuses it. */
      refuse: async (
        file: File,
        status: number,
        code: Parameters<typeof flushError>[2],
        message: string,
        details?: unknown,
      ) => {
        await t.choose(file);
        flushError(http.expectOne('/api/import/parse'), status, code, message, details);
        await settle(fixture);
      },
    };
    return t;
  }

  describe('before a file is chosen', () => {
    it('asks for the file and says what the importer takes and that nothing is stored yet', async () => {
      const t = await setup();

      expect(textOf(getByRole(t.element, 'heading'))).toBe("Choose your bank's file");
      const text = textOf(t.section());
      expect(text).toContain('A .csv or .txt file with one row per transaction.');
      // The limits and where the file goes are in the help, which is part of the step.
      expect(text).toContain('Up to 10 MB and 10,000 rows.');
      expect(text).toContain('It is read in your browser and sent to your own Wallet server.');
      expect(text).toContain('Nothing is stored until you confirm the last step.');
    });

    it('offers a file input for csv and text files', async () => {
      const t = await setup();

      expect(t.input().getAttribute('type')).toBe('file');
      expect(t.input().getAttribute('accept')).toBe('.csv,.txt,text/csv,text/plain');
    });

    it('cannot go on yet, and shows neither details nor an error', async () => {
      const t = await setup();

      expect(t.next().disabled).toBe(true);
      expect(t.alert()).toBeNull();
      expect(queryByRole(t.element, 'status')).toBeNull();
      expect(textOf(t.section())).not.toContain('Rows found');
    });
  });

  describe('choosing a file', () => {
    it('sends its text to parse, with no delimiter so the server detects one, and asks for nothing else', async () => {
      const t = await setup();

      await t.choose(csvFile(SAMPLE_CSV, 'ing.csv'));

      const request = http.expectOne('/api/import/parse');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ csv: SAMPLE_CSV });
      request.flush(parseResponse());
      await settle(t.fixture);
    });

    it('shows the file name and size, the rows found, the columns and the delimiter that was detected', async () => {
      const t = await setup();

      await t.load(csvFile(SAMPLE_CSV, 'ing.csv'));

      expect(textOf(t.section())).toContain(
        'File ing.csv (72 B) Rows found 3 (the first one may be a header) Columns 3 Cells separated by Semicolon (;), detected',
      );
    });

    it('shows the size in the unit that fits, with the decimals of the locale', async () => {
      const t = await setup();

      await t.load(csvFile('x'.repeat(1536), 'big.csv'));

      expect(textOf(t.section())).toContain('big.csv (1.5 KB)');
    });

    it('shows the rows and columns the server counted, not what the file seems to hold', async () => {
      const t = await setup();

      await t.load(csvFile(SAMPLE_CSV), parseResponse({ recordCount: 1201, columnCount: 7 }));

      expect(textOf(t.section())).toContain(
        'Rows found 1201 (the first one may be a header) Columns 7',
      );
    });

    it.each([
      [',', 'Comma (,)'],
      [';', 'Semicolon (;)'],
      ['\t', 'Tab'],
      ['|', 'Pipe (|)'],
    ] as const)('names the detected delimiter %j as "%s"', async (delimiter, name) => {
      const t = await setup();

      await t.load(csvFile(SAMPLE_CSV), parseResponse({ delimiter }));

      expect(textOf(t.section())).toContain(`Cells separated by ${name}, detected`);
    });

    it('says it is reading the file, and cannot go on, until the server has answered', async () => {
      const t = await setup();

      await t.choose(csvFile(SAMPLE_CSV));

      expect(textOf(getByRole(t.element, 'status'))).toBe('Reading the file…');
      expect(t.next().disabled).toBe(true);
      expect(textOf(t.section())).not.toContain('Rows found');

      await t.answer();

      expect(queryByRole(t.element, 'status')).toBeNull();
      expect(t.next().disabled).toBe(false);
    });

    it('lets the user go on to the columns once the file is read', async () => {
      const t = await setup();
      await t.load(csvFile(SAMPLE_CSV));

      expect(t.next().disabled).toBe(false);
      t.next().click();
      await settle(t.fixture);

      expect(t.wizard.step()).toBe('mapping');
    });

    it('replaces the details of the file chosen before', async () => {
      const t = await setup();
      await t.load(csvFile(SAMPLE_CSV, 'one.csv'));

      await t.choose(csvFile(SAMPLE_CSV, 'two.csv'));
      // The old file is gone as soon as the new one is chosen, not when its answer comes.
      expect(textOf(t.section())).not.toContain('one.csv');
      expect(t.next().disabled).toBe(true);
      await t.answer(parseResponse({ recordCount: 9 }));

      const text = textOf(t.section());
      expect(text).toContain('File two.csv (72 B) Rows found 9');
      expect(text).not.toContain('one.csv');
    });

    it('takes the same file again once it was fixed (the input is emptied, so the browser reports the change)', async () => {
      const t = await setup();
      await t.refuse(csvFile('a;"b\n', 'bank.csv'), 400, 'validation_error', 'Invalid request', [
        { path: 'csv', message: 'A quoted field starting on line 1 is never closed' },
      ]);
      expect((t.input() as HTMLInputElement).value).toBe('');
      expect((t.input() as HTMLInputElement).files).toHaveLength(0);

      // The person fixes the file and chooses it again.
      await t.load(csvFile(SAMPLE_CSV, 'bank.csv'));

      expect(t.alert()).toBeNull();
      expect(textOf(t.section())).toContain('File bank.csv (72 B)');
      expect(t.next().disabled).toBe(false);
    });
  });

  describe('the encoding of the file', () => {
    it('says nothing about a file that is UTF-8', async () => {
      const t = await setup();

      await t.load(csvFile('Date;Amount;Description\n2026-10-01;-3,50;Café\n'));

      expect(textOf(t.section())).not.toContain('windows-1252');
      expect(textOf(t.section())).not.toContain('UTF-16');
    });

    it('says a file that is not valid UTF-8 was read as windows-1252, and what to do if accents look wrong', async () => {
      const t = await setup();

      await t.choose(
        csvFile(latin1('Date;Amount;Description\n2026-10-01;-3,50;Café\n'), 'old.csv'),
      );
      // The server is sent the text as windows-1252 reads it.
      const request = http.expectOne('/api/import/parse');
      expect(request.request.body).toEqual({
        csv: 'Date;Amount;Description\n2026-10-01;-3,50;Café\n',
      });
      request.flush(parseResponse());
      await settle(t.fixture);

      expect(textOf(t.section())).toContain(
        "It isn't valid UTF-8, so it was read as windows-1252, the usual encoding of bank files. If accents look wrong in the preview, save the file as UTF-8 and choose it again.",
      );
    });

    it('says a file with a UTF-16 byte order mark was read as UTF-16', async () => {
      const t = await setup();

      await t.choose(csvFile(utf16le('Date;Amount;Description\n'), 'excel.txt'));
      const request = http.expectOne('/api/import/parse');
      expect(request.request.body).toEqual({ csv: 'Date;Amount;Description\n' });
      request.flush(parseResponse());
      await settle(t.fixture);

      expect(textOf(t.section())).toContain(
        'It starts with a UTF-16 byte order mark, so it was read as UTF-16.',
      );
    });

    it('forgets the note when another file replaces the file it was about', async () => {
      const t = await setup();
      await t.load(csvFile(latin1('Date;Amount;Description\nCafé\n'), 'old.csv'));
      expect(textOf(t.section())).toContain('windows-1252');

      await t.load(csvFile(SAMPLE_CSV, 'new.csv'));

      expect(textOf(t.section())).not.toContain('windows-1252');
    });
  });

  describe('a file that cannot be used', () => {
    it('refuses a file above the size the server takes, with the reason and no request', async () => {
      const t = await setup();

      await t.choose(fileOfSize(25 * 1048576, 'statement.csv'));

      http.expectNone('/api/import/parse');
      const alert = t.alert()!;
      expect(textOf(alert)).toBe(
        "Couldn't use this file. statement.csv is 25 MB, which is more than the 10 MB the importer takes. Split the file and import the parts one by one.",
      );
      expect(t.next().disabled).toBe(true);
      expect(textOf(t.section())).not.toContain('Rows found');
    });

    it('takes a file of exactly the size the server takes', async () => {
      const t = await setup();

      await t.load(fileOfSize(IMPORT_MAX_BODY_BYTES, 'edge.csv'));

      expect(t.alert()).toBeNull();
      expect(textOf(t.section())).toContain('File edge.csv (10 MB)');
      expect(t.next().disabled).toBe(false);
    });

    it('drops the file chosen before when the next one is refused', async () => {
      const t = await setup();
      await t.load(csvFile(SAMPLE_CSV, 'good.csv'));

      await t.choose(fileOfSize(25 * 1048576, 'huge.csv'));

      expect(textOf(t.alert()!)).toContain('huge.csv is 25 MB');
      expect(textOf(t.section())).not.toContain('good.csv');
      expect(t.next().disabled).toBe(true);
    });

    it('shows a refusal of the server (a quoted field that is never closed) in an alert and takes no file', async () => {
      const t = await setup();

      await t.refuse(csvFile('a;"b\n', 'broken.csv'), 400, 'validation_error', 'Invalid request', [
        { path: 'csv', message: 'A quoted field starting on line 1 is never closed' },
      ]);

      const alert = t.alert()!;
      expect(textOf(alert)).toContain("Couldn't use this file.");
      expect(textOf(t.section())).not.toContain('Rows found');
      expect(t.next().disabled).toBe(true);
      expect(t.wizard.parse()).toBeNull();
    });

    it('explains a 413 from the server with its limit', async () => {
      const t = await setup();

      await t.refuse(csvFile(SAMPLE_CSV, 'big.csv'), 413, 'payload_too_large', 'Too big', {
        limitBytes: IMPORT_MAX_BODY_BYTES,
      });

      expect(textOf(t.alert()!)).toBe(
        "Couldn't use this file. The server refused the file as too large (the limit is 10 MB). Split it and import the parts one by one.",
      );
      expect(t.next().disabled).toBe(true);
    });

    it('says what a failing server means, in words', async () => {
      const t = await setup();

      await t.refuse(csvFile(SAMPLE_CSV), 500, 'internal_error', '');

      expect(textOf(t.alert()!)).toBe(
        "Couldn't use this file. The server ran into a problem. Try again in a moment.",
      );
      expect(t.next().disabled).toBe(true);
    });

    it('says when the file itself could not be read', async () => {
      const t = await setup();
      const unreadable = csvFile(SAMPLE_CSV, 'locked.csv');
      Object.defineProperty(unreadable, 'arrayBuffer', {
        value: () => Promise.reject(new Error('NotReadableError')),
      });

      await t.choose(unreadable);

      http.expectNone('/api/import/parse');
      expect(textOf(t.alert()!)).toBe(
        "Couldn't use this file. Couldn't read locked.csv. Check that it is a text file and try again.",
      );
      expect(queryByRole(t.element, 'status')).toBeNull();
      expect(t.next().disabled).toBe(true);
    });

    it('takes away the alert once a good file is chosen', async () => {
      const t = await setup();
      await t.choose(fileOfSize(25 * 1048576, 'huge.csv'));
      expect(t.alert()).not.toBeNull();

      await t.load(csvFile(SAMPLE_CSV, 'good.csv'));

      expect(t.alert()).toBeNull();
      expect(t.next().disabled).toBe(false);
    });
  });

  describe('an empty file', () => {
    const EMPTY = parseResponse({ header: [], sample: [], recordCount: 0, columnCount: 0 });

    it('says the file has no rows and cannot go on', async () => {
      const t = await setup();

      await t.load(csvFile('', 'empty.csv'), EMPTY);

      expect(textOf(t.alert()!)).toBe('The file has no rows. Choose another file.');
      expect(textOf(t.section())).toContain('File empty.csv (0 B) Rows found 0');
      expect(t.next().disabled).toBe(true);
    });

    it('goes away when a file with rows is chosen', async () => {
      const t = await setup();
      await t.load(csvFile('', 'empty.csv'), EMPTY);

      await t.load(csvFile(SAMPLE_CSV, 'bank.csv'));

      expect(t.alert()).toBeNull();
      expect(t.next().disabled).toBe(false);
    });
  });

  describe('for a keyboard and a screen reader', () => {
    it('is a region named by its heading, and the heading can take focus when the step opens', async () => {
      const t = await setup();

      const heading = getByRole(t.element, 'heading', "Choose your bank's file");
      expect(t.section().getAttribute('aria-labelledby')).toBe(heading.id);
      // The page focuses this heading when the step is shown: it must be focusable, but not by Tab.
      expect(heading.getAttribute('tabindex')).toBe('-1');
      heading.focus();
      expect(document.activeElement).toBe(heading);
    });

    it('announces what went wrong in a live region that is in the page before the error', async () => {
      const t = await setup();
      // A screen reader only announces what appears inside a region that was already there.
      const regionsBefore = Array.from(t.element.querySelectorAll('[aria-live="polite"]'));

      await t.choose(fileOfSize(25 * 1048576, 'huge.csv'));

      expect(regionsBefore).toContain(t.alert()!.closest('[aria-live="polite"]'));
    });

    it('labels the file input and has nothing a screen reader cannot use, at every stage', async () => {
      const t = await setup();
      expect(getByLabel(t.element, 'CSV file')).toBeTruthy();
      expect(a11yProblems(t.element)).toEqual([]);

      await t.choose(csvFile(SAMPLE_CSV));
      expect(a11yProblems(t.element)).toEqual([]);

      await t.answer();
      expect(a11yProblems(t.element)).toEqual([]);

      await t.load(csvFile(latin1('Date;Amount;Description\nCafé\n')));
      expect(a11yProblems(t.element)).toEqual([]);

      await t.choose(fileOfSize(25 * 1048576, 'huge.csv'));
      expect(t.alert()).not.toBeNull();
      expect(a11yProblems(t.element)).toEqual([]);
    });
  });
});
