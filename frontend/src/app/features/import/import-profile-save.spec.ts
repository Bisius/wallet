import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { importProfileSchema, type ImportParseResponse } from '@wallet/shared';
import { a11yProblems } from '../../../testing/a11y';
import {
  fieldError,
  getByLabel,
  getByRole,
  queryAllByRole,
  queryByRole,
  textOf,
  typeInto,
} from '../../../testing/dom';
import { importProfileDto, parseResponse } from '../../../testing/fixtures';
import { flushError, settle } from '../../../testing/harness';
import { IMPORT_STORES } from '../../../testing/import-harness';
import {
  describedText,
  type MountOptions,
  mountStep,
  optionTexts,
  selectedText,
} from '../../../testing/import-steps-helpers';
import { ImportProfilePicker } from './import-profile-picker';
import { ImportProfileSave } from './import-profile-save';

/** The save form with the picker, which is where the profile that was saved shows up. */
@Component({
  selector: 'app-save-host',
  imports: [ImportProfileSave, ImportProfilePicker],
  template: '<app-import-profile-picker /><app-import-profile-save />',
})
class Host {}

const BANK: ImportParseResponse = parseResponse({
  header: ['Booked', 'Sum', 'Memo'],
  sample: [{ line: 2, cells: ['2026-10-01', '-3.50', 'Coffee'] }],
  recordCount: 2,
  columnCount: 3,
});

const EXISTING = importProfileDto({ id: 1, name: 'Revolut' });

describe('ImportProfileSave', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), ...IMPORT_STORES],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  /** The columns are chosen by default, as the mapping step has them once the user has filled it in. */
  async function setup(options: MountOptions & { columns?: boolean } = {}) {
    const { columns = true, ...mount } = options;
    const { fixture, element, wizard } = await mountStep(http, Host, {
      profiles: [EXISTING],
      file: { parse: BANK },
      ...mount,
    });
    if (columns) wizard.patchMapping({ dateColumn: 0, amountColumn: 1, descriptionColumn: 2 });
    await settle(fixture);

    const picker = element.querySelector<HTMLElement>('app-import-profile-picker')!;
    const t = {
      fixture,
      element,
      wizard,
      form: () => element.querySelector('app-import-profile-save')!,
      name: () => getByLabel(t.form(), 'Profile name'),
      save: () => getByRole(t.form(), 'button', 'Save profile') as HTMLButtonElement,
      details: () => t.form().querySelector('details')!,
      notice: () => textOf(getByRole(picker, 'status')),
      chosen: () => selectedText(getByLabel(picker, 'Saved profile')),
      profiles: () => optionTexts(getByLabel(picker, 'Saved profile')),
      open: async () => {
        t.details().open = true;
        t.details().dispatchEvent(new Event('toggle'));
        await settle(fixture);
      },
      type: async (value: string) => {
        typeInto(t.name(), value);
        await settle(fixture);
      },
      press: async () => {
        t.save().click();
        await settle(fixture);
      },
      /** After a profile was saved the store loads the list again. */
      reload: async (profiles = [EXISTING]) => {
        await settle(fixture);
        http.expectOne('/api/import/profiles').flush(profiles);
        await settle(fixture);
      },
    };
    return t;
  }

  describe('the form', () => {
    it('is folded away until it is asked for', async () => {
      const t = await setup();

      expect(textOf(t.form() as HTMLElement)).toContain('Save these settings as a profile');
      expect(t.details().open).toBe(false);

      await t.open();

      expect(t.details().open).toBe(true);
    });

    it('asks for a name, with an example and what it is for, and keeps it within the length the API takes', async () => {
      const t = await setup();
      await t.open();

      expect((t.name() as HTMLInputElement).value).toBe('');
      expect(t.name().getAttribute('maxlength')).toBe('60');
      expect(t.name().getAttribute('autocomplete')).toBe('off');
      expect(describedText(t.name())).toBe(
        'For example the name of your bank. The next file with the same column titles fills itself in.',
      );
    });

    it('is off, and says why, until the three columns are chosen', async () => {
      const t = await setup({ columns: false });
      await t.open();

      expect(t.save().disabled).toBe(true);
      expect(textOf(t.form() as HTMLElement)).toContain('Finish choosing the columns first.');

      t.wizard.patchMapping({ dateColumn: 0, amountColumn: 1, descriptionColumn: 2 });
      await settle(t.fixture);

      expect(t.save().disabled).toBe(false);
      expect(textOf(t.form() as HTMLElement)).not.toContain('Finish choosing the columns first.');
    });

    it('is off again when two roles share a column', async () => {
      const t = await setup();
      await t.open();

      t.wizard.patchMapping({ amountColumn: 0 });
      await settle(t.fixture);

      expect(t.save().disabled).toBe(true);
    });
  });

  describe('saving', () => {
    it('sends the name, the mapping as it stands and the header of the file, then chooses the new profile and says so', async () => {
      const t = await setup();
      t.wizard.patchMapping({ dateFormat: 'DD/MM/YYYY', decimalSeparator: ',' });
      await t.open();
      await t.type('  ING  ');

      await t.press();

      const request = http.expectOne('/api/import/profiles');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({
        name: 'ING',
        mapping: {
          delimiter: ';',
          hasHeader: true,
          dateColumn: 0,
          amountColumn: 1,
          descriptionColumn: 2,
          dateFormat: 'DD/MM/YYYY',
          decimalSeparator: ',',
          signConvention: 'expenses_negative',
        },
        header: ['Booked', 'Sum', 'Memo'],
      });
      expect(importProfileSchema.safeParse(request.request.body).success).toBe(true);
      // Busy while it is on its way, and no second request can go out.
      expect(t.save().disabled).toBe(true);
      expect(t.save().getAttribute('aria-busy')).toBe('true');
      request.flush(importProfileDto({ id: 9, name: 'ING' }));
      await t.reload([EXISTING, importProfileDto({ id: 9, name: 'ING' })]);

      expect(t.profiles()).toEqual(['None: set the columns below', 'Revolut', 'ING']);
      expect(t.chosen()).toBe('ING');
      expect(t.notice()).toBe(
        'Profile "ING" saved. The next file with the same column titles will use it.',
      );
      expect(t.details().open).toBe(false);
      expect((t.name() as HTMLInputElement).value).toBe('');
      expect(t.save().disabled).toBe(false);
    });

    it('leaves out the header when the file has none: there is nothing to recognise the next file by', async () => {
      const t = await setup();
      t.wizard.patchMapping({ hasHeader: false });
      await t.open();
      await t.type('Revolut card');

      await t.press();

      const request = http.expectOne('/api/import/profiles');
      expect(Object.keys(request.request.body)).toEqual(['name', 'mapping']);
      expect(request.request.body.mapping.hasHeader).toBe(false);
      expect(importProfileSchema.safeParse(request.request.body).success).toBe(true);
      request.flush(importProfileDto({ id: 9, name: 'Revolut card' }));
      await t.reload();
    });

    it('keeps no more of a long header than the API takes: 100 cells of 200 characters', async () => {
      const header = Array.from({ length: 130 }, (_, index) => (index === 1 ? 'x'.repeat(250) : `c${index}`));
      const t = await setup({ file: { parse: parseResponse({ header, columnCount: 130 }) } });
      await t.open();
      await t.type('Wide bank');

      await t.press();

      const request = http.expectOne('/api/import/profiles');
      const sent = request.request.body.header as string[];
      expect(sent).toHaveLength(100);
      expect(sent[1]).toHaveLength(200);
      expect(sent[99]).toBe('c99');
      expect(importProfileSchema.safeParse(request.request.body).success).toBe(true);
      request.flush(importProfileDto({ id: 9, name: 'Wide bank' }));
      await t.reload();
    });

    it('sends one request however many times the form is submitted while it is on its way', async () => {
      const t = await setup();
      await t.open();
      await t.type('ING');
      await t.press();

      t.form().querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await settle(t.fixture);

      http.expectOne('/api/import/profiles').flush(importProfileDto({ id: 9, name: 'ING' }));
      await t.reload();
    });
  });

  describe('a name that cannot be used', () => {
    it.each([
      ['empty', ''],
      ['only spaces', '    '],
    ])('refuses a name that is %s on the name field, without a request', async (_label, value) => {
      const t = await setup();
      await t.open();
      await t.type(value);

      await t.press();

      http.expectNone('/api/import/profiles');
      expect(fieldError(t.name())).toBe('Profile name is required.');
      expect(t.name().getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(t.name());
    });

    it('refuses a name above 60 characters, without a request', async () => {
      const t = await setup();
      await t.open();
      await t.type('x'.repeat(61));

      await t.press();

      http.expectNone('/api/import/profiles');
      expect(fieldError(t.name())).toBe('Profile name can have at most 60 characters.');
    });

    it('takes a name of exactly 60 characters', async () => {
      const t = await setup();
      await t.open();
      await t.type('x'.repeat(60));

      await t.press();

      const request = http.expectOne('/api/import/profiles');
      expect(request.request.body.name).toHaveLength(60);
      request.flush(importProfileDto({ id: 9, name: 'x'.repeat(60) }));
      await t.reload();
    });

    it('shows a name another profile has, ignoring case, on the name field, and keeps the form open and the name typed', async () => {
      const t = await setup();
      await t.open();
      await t.type('REVOLUT');
      await t.press();

      flushError(
        http.expectOne('/api/import/profiles'),
        409,
        'import_profile_name_taken',
        'Another import profile is already called "Revolut"',
      );
      await settle(t.fixture);

      expect(fieldError(t.name())).toBe('Another import profile is already called "Revolut"');
      expect(t.name().getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(t.name());
      expect((t.name() as HTMLInputElement).value).toBe('REVOLUT');
      // The problem belongs to the field: nothing is repeated in an alert at the top of the form.
      expect(queryByRole(t.form() as HTMLElement, 'alert')).toBeNull();
      expect(t.details().open).toBe(true);
      expect(t.notice()).toBe('');
      expect(t.chosen()).toBe('None: set the columns below');
      expect(t.save().disabled).toBe(false);
    });

    it('lets another name through once the user edits it', async () => {
      const t = await setup();
      await t.open();
      await t.type('Revolut');
      await t.press();
      flushError(
        http.expectOne('/api/import/profiles'),
        409,
        'import_profile_name_taken',
        'Another import profile is already called "Revolut"',
      );
      await settle(t.fixture);

      await t.type('Revolut business');
      expect(fieldError(t.name())).toBe('');
      await t.press();

      const retry = http.expectOne('/api/import/profiles');
      expect(retry.request.body.name).toBe('Revolut business');
      retry.flush(importProfileDto({ id: 9, name: 'Revolut business' }));
      await t.reload([EXISTING, importProfileDto({ id: 9, name: 'Revolut business' })]);
      expect(t.chosen()).toBe('Revolut business');
    });

    it('shows a name the API refuses (invisible characters) on the name field', async () => {
      const t = await setup();
      await t.open();
      await t.type('​');
      await t.press();
      // The browser-side check lets it through: the API is the one that knows.
      flushError(http.expectOne('/api/import/profiles'), 400, 'validation_error', 'Invalid request', [
        { path: 'name', message: 'Name is required' },
      ]);
      await settle(t.fixture);

      expect(fieldError(t.name())).toBe('Name is required');
      expect(document.activeElement).toBe(t.name());
    });
  });

  describe('another failure', () => {
    it('shows what the API said in an alert, keeps the name and puts focus back on the button', async () => {
      const t = await setup();
      await t.open();
      await t.type('ING');
      await t.press();

      // The button is disabled while the request is out and loses focus, as in a browser.
      (document.activeElement as HTMLElement | null)?.blur();
      flushError(http.expectOne('/api/import/profiles'), 500, 'internal_error', 'The database is locked');
      await settle(t.fixture);

      expect(queryAllByRole(t.form() as HTMLElement, 'alert').map(textOf)).toEqual([
        'The database is locked',
      ]);
      expect((t.name() as HTMLInputElement).value).toBe('ING');
      expect(t.save().disabled).toBe(false);
      expect(document.activeElement).toBe(t.save());
      expect(t.notice()).toBe('');
    });

    it('shows a refusal that names a field the form does not have (the header) in the alert', async () => {
      const t = await setup();
      await t.open();
      await t.type('ING');
      await t.press();

      flushError(http.expectOne('/api/import/profiles'), 400, 'validation_error', 'Invalid request', [
        { path: 'header', message: 'The header must have a cell for every mapped column' },
      ]);
      await settle(t.fixture);

      expect(queryAllByRole(t.form() as HTMLElement, 'alert').map(textOf)).toEqual([
        'The header must have a cell for every mapped column',
      ]);
      expect(t.name().getAttribute('aria-invalid')).toBeNull();
    });

    it('clears the alert on the next try', async () => {
      const t = await setup();
      await t.open();
      await t.type('ING');
      await t.press();
      flushError(http.expectOne('/api/import/profiles'), 500, 'internal_error', 'Down');
      await settle(t.fixture);
      expect(queryByRole(t.form() as HTMLElement, 'alert')).not.toBeNull();

      await t.press();

      expect(queryByRole(t.form() as HTMLElement, 'alert')).toBeNull();
      http.expectOne('/api/import/profiles').flush(importProfileDto({ id: 9, name: 'ING' }));
      await t.reload();
    });
  });

  it('labels every control and has nothing a screen reader cannot use, open, with errors and with an alert', async () => {
    const t = await setup();
    expect(a11yProblems(t.element)).toEqual([]);

    await t.open();
    expect(getByLabel(t.form(), 'Profile name')).toBeTruthy();
    expect(a11yProblems(t.element)).toEqual([]);

    await t.press();
    expect(fieldError(t.name())).toBe('Profile name is required.');
    expect(a11yProblems(t.element)).toEqual([]);

    await t.type('ING');
    await t.press();
    flushError(http.expectOne('/api/import/profiles'), 500, 'internal_error', 'Down');
    await settle(t.fixture);
    expect(queryByRole(t.form() as HTMLElement, 'alert')).not.toBeNull();
    expect(a11yProblems(t.element)).toEqual([]);
  });
});
