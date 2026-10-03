import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { importProfileSchema, type ImportProfileDto } from '@wallet/shared';
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
import { importMapping, importProfileDto, parseResponse } from '../../../testing/fixtures';
import { flushError, primeStores, settle } from '../../../testing/harness';
import { IMPORT_STORES } from '../../../testing/import-harness';
import { type MountOptions, mountStep } from '../../../testing/import-steps-helpers';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog';
import { ToastContainer } from '../../shared/ui/toast-container';
import { ToastService } from '../../shared/ui/toast.service';
import { ImportProfilesDialog } from './import-profiles-dialog';

/** The dialog as the picker shows it, with the shell's confirm dialog and toasts. */
@Component({
  selector: 'app-profiles-dialog-host',
  imports: [ImportProfilesDialog, ConfirmDialog, ToastContainer],
  template: `
    <app-import-profiles-dialog (closed)="closes = closes + 1" />
    <app-confirm-dialog />
    <app-toast-container />
  `,
})
class Host {
  closes = 0;
}

const COMMA_BANK = importProfileDto({
  id: 6,
  name: 'Comma bank',
  mapping: importMapping({ delimiter: ',' }),
  header: ['booked', 'sum', 'memo'],
});
const ING = importProfileDto({
  id: 4,
  name: 'ING',
  mapping: importMapping({
    dateColumn: 2,
    amountColumn: 0,
    descriptionColumn: 1,
    dateFormat: 'DD/MM/YYYY',
    decimalSeparator: ',',
  }),
  header: ['amount', 'text', 'date'],
});
const REVOLUT = importProfileDto({
  id: 5,
  name: 'Revolut',
  mapping: importMapping({ hasHeader: false }),
  header: null,
});
const PROFILES = [COMMA_BANK, ING, REVOLUT];

describe('ImportProfilesDialog', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), ...IMPORT_STORES],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function setup(options: MountOptions = {}) {
    const { fixture, element, wizard } = await mountStep(http, Host, {
      profiles: PROFILES,
      ...options,
    });
    const t = {
      fixture,
      element,
      wizard,
      dialog: () => getByRole(element, 'dialog', 'Import profiles') as HTMLDialogElement,
      confirm: () => getByRole(element, 'dialog', /^Delete the profile/) as HTMLDialogElement,
      closes: () => fixture.componentInstance.closes,
      rows: () => queryAllByRole(t.dialog(), 'listitem').map(textOf),
      toasts: () =>
        TestBed.inject(ToastService)
          .toasts()
          .map((toast) => toast.message),
      press: async (name: string | RegExp, root: ParentNode = t.dialog()) => {
        getByRole(root, 'button', name).click();
        await settle(fixture);
      },
      /** Starts renaming and types the new name. */
      rename: async (profile: string, value: string) => {
        await t.press(`Rename profile ${profile}`);
        typeInto(getByLabel(t.dialog(), `New name for ${profile}`), value);
        await settle(fixture);
      },
      nameField: (profile: string) => getByLabel<HTMLInputElement>(t.dialog(), `New name for ${profile}`),
      /** After a change the store loads the profiles again. */
      reload: async (profiles: ImportProfileDto[]) => {
        await settle(fixture);
        http.expectOne('/api/import/profiles').flush(profiles);
        await settle(fixture);
      },
      escape: async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle(fixture);
      },
    };
    return t;
  }

  describe('the list', () => {
    it('is a modal dialog named "Import profiles", with what a profile is and that renaming or deleting never changes what was imported', async () => {
      const t = await setup();

      expect(t.dialog().open).toBe(true);
      expect(textOf(getByRole(t.dialog(), 'heading', 'Import profiles'))).toBe('Import profiles');
      expect(textOf(t.dialog())).toContain(
        'A profile remembers the columns and formats of one bank. Renaming or deleting one never changes what you imported.',
      );
    });

    it('lists each profile with a button to rename it and one to delete it, named after the profile', async () => {
      const t = await setup();

      expect(t.rows()).toEqual(['Comma bank Rename Delete', 'ING Rename Delete', 'Revolut Rename Delete']);
      for (const name of ['Comma bank', 'ING', 'Revolut']) {
        expect(getByRole(t.dialog(), 'button', `Rename profile ${name}`), name).toBeTruthy();
        expect(getByRole(t.dialog(), 'button', `Delete profile ${name}`), name).toBeTruthy();
      }
    });

    it('starts with focus on the first button in it', async () => {
      const t = await setup();

      expect(document.activeElement).toBe(getByRole(t.dialog(), 'button', 'Rename profile Comma bank'));
    });

    it('says there are no profiles yet and how to make one', async () => {
      const t = await setup({ profiles: [] });

      expect(textOf(t.dialog())).toContain('No profiles yet');
      expect(textOf(t.dialog())).toContain(
        'Set the columns of a file and use Save these settings as a profile.',
      );
      expect(queryByRole(t.dialog(), 'list')).toBeNull();
      expect(document.activeElement).toBe(getByRole(t.dialog(), 'button', 'Close'));
    });

    it('says the profiles are loading', async () => {
      await primeStores(http);
      const fixture = TestBed.createComponent(Host);
      fixture.detectChanges();
      await settle(fixture);
      const dialog = getByRole(fixture.nativeElement as HTMLElement, 'dialog', 'Import profiles');

      expect(textOf(getByRole(dialog, 'status'))).toBe('Loading profiles…');

      http.expectOne('/api/import/profiles').flush(PROFILES);
      await settle(fixture);
      expect(queryAllByRole(dialog, 'listitem')).toHaveLength(3);
    });

    it('says what went wrong when the profiles cannot be loaded, and tries again', async () => {
      const t = await setup({ profiles: 'error' });

      const alert = getByRole(t.dialog(), 'alert');
      expect(textOf(alert)).toContain("Couldn't load the profiles");
      expect(textOf(alert)).toContain('The server ran into a problem. Try again in a moment.');

      await t.press('Try again');
      http.expectOne('/api/import/profiles').flush(PROFILES);
      await settle(t.fixture);

      expect(queryByRole(t.dialog(), 'alert')).toBeNull();
      expect(t.rows()).toHaveLength(3);
    });
  });

  describe('closing', () => {
    it('closes with the Close button', async () => {
      const t = await setup();

      await t.press('Close');

      expect(t.closes()).toBe(1);
    });

    it('closes with Escape', async () => {
      const t = await setup();

      await t.escape();

      expect(t.closes()).toBe(1);
    });
  });

  describe('renaming', () => {
    it('opens a field with the current name, all of it selected, and offers to save or cancel', async () => {
      const t = await setup();

      await t.press('Rename profile ING');

      const field = t.nameField('ING');
      expect(field.value).toBe('ING');
      expect(field.selectionStart).toBe(0);
      expect(field.selectionEnd).toBe(3);
      expect(field.getAttribute('maxlength')).toBe('60');
      expect(getByRole(t.dialog(), 'button', 'Save name')).toBeTruthy();
      expect(getByRole(t.dialog(), 'button', 'Cancel')).toBeTruthy();
      // The row being renamed gives up its buttons, the others keep theirs.
      expect(queryByRole(t.dialog(), 'button', 'Rename profile ING')).toBeNull();
      expect(queryByRole(t.dialog(), 'button', 'Rename profile Revolut')).not.toBeNull();
    });

    it('sends the whole profile again with the new name: the mapping and the header stay as they were', async () => {
      const t = await setup();
      await t.rename('ING', '  ING Direct  ');

      await t.press('Save name');

      const request = http.expectOne('/api/import/profiles/4');
      expect(request.request.method).toBe('PUT');
      expect(request.request.body).toEqual({
        name: 'ING Direct',
        mapping: ING.mapping,
        header: ['amount', 'text', 'date'],
      });
      expect(importProfileSchema.safeParse(request.request.body).success).toBe(true);
      request.flush({ ...ING, name: 'ING Direct' });
      await t.reload([COMMA_BANK, { ...ING, name: 'ING Direct' }, REVOLUT]);

      expect(t.rows()).toEqual(['Comma bank Rename Delete', 'ING Direct Rename Delete', 'Revolut Rename Delete']);
      expect(t.toasts()).toEqual(['Profile renamed to ING Direct.']);
      expect(queryByRole(t.dialog(), 'button', 'Save name')).toBeNull();
    });

    it('sends a profile that has no header with a null one', async () => {
      const t = await setup();
      await t.rename('Revolut', 'Revolut card');

      await t.press('Save name');

      const request = http.expectOne('/api/import/profiles/5');
      expect(request.request.body).toEqual({
        name: 'Revolut card',
        mapping: REVOLUT.mapping,
        header: null,
      });
      expect(importProfileSchema.safeParse(request.request.body).success).toBe(true);
      request.flush({ ...REVOLUT, name: 'Revolut card' });
      await t.reload([COMMA_BANK, ING, { ...REVOLUT, name: 'Revolut card' }]);
    });

    it('allows changing only the capitalization of its own name', async () => {
      const t = await setup();
      await t.rename('ING', 'ing');

      await t.press('Save name');

      const request = http.expectOne('/api/import/profiles/4');
      expect(request.request.body.name).toBe('ing');
      request.flush({ ...ING, name: 'ing' });
      await t.reload([COMMA_BANK, { ...ING, name: 'ing' }, REVOLUT]);
    });

    it('is busy, and nothing else can be done or closed, while the new name is on its way', async () => {
      const t = await setup();
      await t.rename('ING', 'ING Direct');
      await t.press('Save name');

      const save = getByRole(t.dialog(), 'button', 'Save name') as HTMLButtonElement;
      expect(save.disabled).toBe(true);
      expect(save.getAttribute('aria-busy')).toBe('true');
      for (const name of ['Cancel', 'Close', 'Rename profile Revolut', 'Delete profile Revolut', 'Delete profile Comma bank']) {
        expect((getByRole(t.dialog(), 'button', name) as HTMLButtonElement).disabled, name).toBe(true);
      }
      // Escape would lose the outcome of the save: it does nothing meanwhile.
      await t.escape();
      expect(t.dialog().open).toBe(true);
      expect(t.closes()).toBe(0);

      http.expectOne('/api/import/profiles/4').flush({ ...ING, name: 'ING Direct' });
      await t.reload([COMMA_BANK, { ...ING, name: 'ING Direct' }, REVOLUT]);
      expect((getByRole(t.dialog(), 'button', 'Close') as HTMLButtonElement).disabled).toBe(false);
      await t.escape();
      expect(t.closes()).toBe(1);
    });

    it('closes the field without a request when the name did not change', async () => {
      const t = await setup();
      await t.rename('ING', ' ING ');

      await t.press('Save name');

      http.expectNone('/api/import/profiles/4');
      expect(queryByRole(t.dialog(), 'button', 'Save name')).toBeNull();
      expect(t.toasts()).toEqual([]);
    });

    it('cancels without a request', async () => {
      const t = await setup();
      await t.rename('ING', 'Something else');

      await t.press('Cancel');

      http.expectNone('/api/import/profiles/4');
      expect(queryByRole(t.dialog(), 'button', 'Save name')).toBeNull();
      expect(t.rows()[1]).toBe('ING Rename Delete');
    });

    it('moves the field to another profile when its Rename is pressed, dropping the first edit', async () => {
      const t = await setup();
      await t.rename('ING', 'Edited but not saved');

      await t.press('Rename profile Revolut');

      expect(t.nameField('Revolut').value).toBe('Revolut');
      expect(queryByRole(t.dialog(), 'textbox', 'New name for ING')).toBeNull();
      expect(t.rows()[1]).toBe('ING Rename Delete');
    });

    it('needs a name', async () => {
      const t = await setup();
      await t.rename('ING', '   ');

      await t.press('Save name');

      http.expectNone('/api/import/profiles/4');
      expect(fieldError(t.nameField('ING'))).toBe('Name is required.');
      expect(t.nameField('ING').getAttribute('aria-invalid')).toBe('true');
    });

    it('shows a name another profile has on the field, and keeps the field open', async () => {
      const t = await setup();
      await t.rename('ING', 'revolut');
      await t.press('Save name');

      flushError(
        http.expectOne('/api/import/profiles/4'),
        409,
        'import_profile_name_taken',
        'Another import profile is already called "Revolut"',
      );
      await settle(t.fixture);

      expect(fieldError(t.nameField('ING'))).toBe('Another import profile is already called "Revolut"');
      expect(t.nameField('ING').getAttribute('aria-invalid')).toBe('true');
      expect(t.nameField('ING').value).toBe('revolut');
      expect(t.toasts()).toEqual([]);
      expect((getByRole(t.dialog(), 'button', 'Save name') as HTMLButtonElement).disabled).toBe(false);

      // Another name goes through, and the error is over.
      typeInto(t.nameField('ING'), 'ING Direct');
      await settle(t.fixture);
      await t.press('Save name');
      expect(fieldError(t.nameField('ING'))).toBe('');
      const retry = http.expectOne('/api/import/profiles/4');
      expect(retry.request.body.name).toBe('ING Direct');
      retry.flush({ ...ING, name: 'ING Direct' });
      await t.reload([COMMA_BANK, { ...ING, name: 'ING Direct' }, REVOLUT]);
    });

    it('shows a name the API refuses on the field, in the words of the API', async () => {
      const t = await setup();
      await t.rename('ING', '​');
      await t.press('Save name');

      flushError(http.expectOne('/api/import/profiles/4'), 400, 'validation_error', 'Invalid request', [
        { path: 'name', message: 'Name is required' },
      ]);
      await settle(t.fixture);

      expect(fieldError(t.nameField('ING'))).toBe('Name is required');
    });

    it('says a profile that was already gone is gone, closes the field and loads the list again', async () => {
      const t = await setup();
      await t.rename('ING', 'ING Direct');
      await t.press('Save name');

      flushError(http.expectOne('/api/import/profiles/4'), 404, 'not_found', 'Profile not found');
      await t.reload([COMMA_BANK, REVOLUT]);

      expect(t.toasts()).toEqual(['That profile was already gone.']);
      expect(t.rows()).toEqual(['Comma bank Rename Delete', 'Revolut Rename Delete']);
      expect(queryByRole(t.dialog(), 'button', 'Save name')).toBeNull();
    });

    it('shows another failure on the field and keeps what was typed', async () => {
      const t = await setup();
      await t.rename('ING', 'ING Direct');
      await t.press('Save name');

      flushError(http.expectOne('/api/import/profiles/4'), 500, 'internal_error', 'The database is locked');
      await settle(t.fixture);

      expect(fieldError(t.nameField('ING'))).toBe('The database is locked');
      expect(t.nameField('ING').value).toBe('ING Direct');
      expect(t.toasts()).toEqual([]);
    });

    it('starts the next rename without the error of the last', async () => {
      const t = await setup();
      await t.rename('ING', 'ING Direct');
      await t.press('Save name');
      flushError(http.expectOne('/api/import/profiles/4'), 500, 'internal_error', 'The database is locked');
      await settle(t.fixture);
      await t.press('Cancel');

      await t.press('Rename profile ING');

      expect(fieldError(t.nameField('ING'))).toBe('');
      expect(t.nameField('ING').value).toBe('ING');
    });
  });

  describe('deleting', () => {
    it('asks first, says files of that bank need their columns by hand and that nothing imported changes, and does nothing when cancelled', async () => {
      const t = await setup();

      await t.press('Delete profile ING');

      const text = textOf(t.confirm());
      expect(text).toContain('Delete the profile "ING"?');
      expect(text).toContain(
        'Files of this bank will need their columns chosen by hand again. Nothing you imported changes.',
      );
      expect(document.activeElement).toBe(getByRole(t.confirm(), 'button', 'Cancel'));
      await t.press('Cancel', t.confirm());
      http.expectNone('/api/import/profiles/4');
      expect(t.rows()).toHaveLength(3);
    });

    it('deletes once confirmed, loads the list again and says so', async () => {
      const t = await setup();
      await t.press('Delete profile ING');
      await t.press('Delete profile', t.confirm());

      const request = http.expectOne('/api/import/profiles/4');
      expect(request.request.method).toBe('DELETE');
      // Busy while it is on its way.
      expect((getByRole(t.dialog(), 'button', 'Close') as HTMLButtonElement).disabled).toBe(true);
      request.flush(null, { status: 204, statusText: 'No Content' });
      await t.reload([COMMA_BANK, REVOLUT]);

      expect(t.rows()).toEqual(['Comma bank Rename Delete', 'Revolut Rename Delete']);
      expect(t.toasts()).toEqual(['Profile ING deleted.']);
      expect((getByRole(t.dialog(), 'button', 'Close') as HTMLButtonElement).disabled).toBe(false);
    });

    it('shows the empty list once the last profile is gone', async () => {
      const t = await setup({ profiles: [REVOLUT] });
      await t.press('Delete profile Revolut');
      await t.press('Delete profile', t.confirm());

      http.expectOne('/api/import/profiles/5').flush(null, { status: 204, statusText: 'No Content' });
      await t.reload([]);

      expect(textOf(t.dialog())).toContain('No profiles yet');
    });

    it('stops using the profile that was in use, but keeps the mapping it filled in', async () => {
      const t = await setup({ file: { parse: parseResponse({ suggestedProfileId: 4 }) } });
      expect(t.wizard.selectedProfileId()).toBe(4);
      expect(t.wizard.profileNotice()).not.toBeNull();
      await t.press('Delete profile ING');
      await t.press('Delete profile', t.confirm());

      http.expectOne('/api/import/profiles/4').flush(null, { status: 204, statusText: 'No Content' });
      await t.reload([COMMA_BANK, REVOLUT]);

      expect(t.wizard.selectedProfileId()).toBeNull();
      expect(t.wizard.profileNotice()).toBeNull();
      expect(t.wizard.draft()).toEqual(ING.mapping);
    });

    it('leaves the profile in use alone when another one is deleted', async () => {
      const t = await setup({ file: { parse: parseResponse({ suggestedProfileId: 4 }) } });
      await t.press('Delete profile Revolut');
      await t.press('Delete profile', t.confirm());

      http.expectOne('/api/import/profiles/5').flush(null, { status: 204, statusText: 'No Content' });
      await t.reload([COMMA_BANK, ING]);

      expect(t.wizard.selectedProfileId()).toBe(4);
    });

    it('says a profile that was already gone is gone, and loads the list again', async () => {
      const t = await setup();
      await t.press('Delete profile ING');
      await t.press('Delete profile', t.confirm());

      flushError(http.expectOne('/api/import/profiles/4'), 404, 'not_found', 'Profile not found');
      await t.reload([COMMA_BANK, REVOLUT]);

      expect(t.toasts()).toEqual(['That profile was already gone.']);
      expect(t.rows()).toHaveLength(2);
    });

    it("reports another failure with the API's words and keeps the profile", async () => {
      const t = await setup({ file: { parse: parseResponse({ suggestedProfileId: 4 }) } });
      await t.press('Delete profile ING');
      await t.press('Delete profile', t.confirm());

      flushError(http.expectOne('/api/import/profiles/4'), 500, 'internal_error', 'Something broke');
      await settle(t.fixture);

      expect(t.toasts()).toEqual(["Couldn't delete the profile. Something broke"]);
      expect(t.rows()).toHaveLength(3);
      expect(t.wizard.selectedProfileId()).toBe(4);
      expect((getByRole(t.dialog(), 'button', 'Delete profile ING') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('labels every control and has nothing a screen reader cannot use, in every state of it', async () => {
    const t = await setup();
    expect(a11yProblems(t.element)).toEqual([]);

    await t.press('Rename profile ING');
    expect(getByLabel(t.dialog(), 'New name for ING')).toBeTruthy();
    expect(a11yProblems(t.element)).toEqual([]);

    typeInto(t.nameField('ING'), '');
    await settle(t.fixture);
    await t.press('Save name');
    expect(fieldError(t.nameField('ING'))).toBe('Name is required.');
    expect(a11yProblems(t.element)).toEqual([]);

    await t.press('Cancel');
    await t.press('Delete profile ING');
    expect(a11yProblems(t.element)).toEqual([]);
  });

  it('has nothing a screen reader cannot use when the profiles cannot be loaded', async () => {
    const t = await setup({ profiles: 'error' });

    expect(getByRole(t.dialog(), 'alert')).toBeTruthy();
    expect(a11yProblems(t.element)).toEqual([]);
  });

  it('has nothing a screen reader cannot use when there are no profiles', async () => {
    const t = await setup({ profiles: [] });

    expect(textOf(t.dialog())).toContain('No profiles yet');
    expect(a11yProblems(t.element)).toEqual([]);
  });
});
