import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ImportProfileDto } from '@wallet/shared';
import { a11yProblems } from '../../../testing/a11y';
import { getByLabel, getByRole, queryByRole, textOf, typeInto } from '../../../testing/dom';
import {
  importMapping,
  importProfileDto,
  parseResponse,
} from '../../../testing/fixtures';
import { flushError, primeStores, settle } from '../../../testing/harness';
import { IMPORT_STORES } from '../../../testing/import-harness';
import {
  type MountOptions,
  mountStep,
  optionTexts,
  SAMPLE_CSV,
  selectedText,
} from '../../../testing/import-steps-helpers';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog';
import { ToastContainer } from '../../shared/ui/toast-container';
import { ToastService } from '../../shared/ui/toast.service';
import { ImportProfilePicker } from './import-profile-picker';

/** The picker with the shell's confirm dialog and toasts, which the dialog it opens uses. */
@Component({
  selector: 'app-picker-host',
  imports: [ImportProfilePicker, ConfirmDialog, ToastContainer],
  template: '<app-import-profile-picker /><app-confirm-dialog /><app-toast-container />',
})
class Host {}

const ING = importProfileDto({
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
const REVOLUT = importProfileDto({
  id: 5,
  name: 'Revolut',
  mapping: importMapping({ hasHeader: false, dateFormat: 'YYYY/MM/DD' }),
});
const COMMA_BANK = importProfileDto({
  id: 6,
  name: 'Comma bank',
  mapping: importMapping({ delimiter: ',' }),
});
const PROFILES = [COMMA_BANK, ING, REVOLUT];

describe('ImportProfilePicker', () => {
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
    // The toasts have a status region too: the notice is the one in the picker.
    const picker = element.querySelector<HTMLElement>('app-import-profile-picker')!;
    const t = {
      fixture,
      element,
      wizard,
      picker,
      select: () => getByLabel<HTMLSelectElement>(element, 'Saved profile'),
      notice: () => textOf(getByRole(picker, 'status')),
      manage: () => getByRole(element, 'button', 'Manage profiles'),
      toasts: () =>
        TestBed.inject(ToastService)
          .toasts()
          .map((toast) => toast.message),
      pick: async (value: string) => {
        typeInto(t.select(), value);
        await settle(fixture);
      },
      press: async (name: string | RegExp, root: ParentNode = element) => {
        getByRole(root, 'button', name).click();
        await settle(fixture);
      },
      /** The profiles dialog, once opened. */
      dialog: () => getByRole(element, 'dialog', 'Import profiles'),
      /** After a change in the dialog the store loads the profiles again. */
      reload: async (profiles: ImportProfileDto[]) => {
        await settle(fixture);
        http.expectOne('/api/import/profiles').flush(profiles);
        await settle(fixture);
      },
    };
    return t;
  }

  describe('the choice', () => {
    it('offers "none" and then the saved profiles, in the order the API lists them', async () => {
      const t = await setup();

      expect(optionTexts(t.select())).toEqual([
        'None: set the columns below',
        'Comma bank',
        'ING',
        'Revolut',
      ]);
      expect(selectedText(t.select())).toBe('None: set the columns below');
      expect(t.select().disabled).toBe(false);
    });

    it('says what a profile is for, and has no notice until one is used', async () => {
      const t = await setup();

      expect(textOf(t.element)).toContain('A profile remembers the columns and formats of one bank.');
      expect(t.notice()).toBe('');
    });

    it('offers only "none" when there are no profiles', async () => {
      const t = await setup({ profiles: [] });

      expect(optionTexts(t.select())).toEqual(['None: set the columns below']);
    });

    it('says the profiles are loading, and cannot be used, until the list is in', async () => {
      await primeStores(http);
      const fixture = TestBed.createComponent(Host);
      fixture.detectChanges();
      await settle(fixture);
      const element = fixture.nativeElement as HTMLElement;
      const select = getByLabel<HTMLSelectElement>(element, 'Saved profile');

      expect(select.disabled).toBe(true);
      expect(optionTexts(select)).toEqual(['Loading profiles…']);

      http.expectOne('/api/import/profiles').flush(PROFILES);
      await settle(fixture);

      expect(select.disabled).toBe(false);
      expect(optionTexts(select)).toEqual([
        'None: set the columns below',
        'Comma bank',
        'ING',
        'Revolut',
      ]);
    });
  });

  describe('using a profile', () => {
    it('fills in the mapping from the profile picked and says so', async () => {
      const t = await setup();

      await t.pick('4');

      expect(selectedText(t.select())).toBe('ING');
      expect(t.wizard.draft()).toEqual(ING.mapping);
      expect(t.notice()).toBe('Profile "ING" applied. Check the columns against the first rows below.');
      expect(t.wizard.selectedProfileId()).toBe(4);
      http.expectNone('/api/import/parse');
    });

    it('swaps one profile for another, with a notice about the new one', async () => {
      const t = await setup();
      await t.pick('4');

      await t.pick('5');

      expect(selectedText(t.select())).toBe('Revolut');
      expect(t.wizard.draft()).toEqual(REVOLUT.mapping);
      expect(t.notice()).toBe(
        'Profile "Revolut" applied. Check the columns against the first rows below.',
      );
    });

    it('reads the file again when the profile has another delimiter than the one it was read with', async () => {
      const t = await setup();

      await t.pick('6');

      const request = http.expectOne('/api/import/parse');
      expect(request.request.body).toEqual({ csv: SAMPLE_CSV, delimiter: ',' });
      request.flush(parseResponse({ delimiter: ',' }));
      await settle(t.fixture);
      // The review store asks for the budgets again whenever the answer of parse changes.
      for (const budgets of http.match('/api/budgets')) budgets.flush([]);
      await settle(t.fixture);
      expect(t.wizard.draft().delimiter).toBe(',');
      expect(t.notice()).toBe(
        'Profile "Comma bank" applied. Check the columns against the first rows below.',
      );
    });

    it('stops using the profile when "none" is chosen again, and keeps the mapping it filled in', async () => {
      const t = await setup();
      await t.pick('4');

      await t.pick('');

      expect(selectedText(t.select())).toBe('None: set the columns below');
      expect(t.notice()).toBe('');
      expect(t.wizard.selectedProfileId()).toBeNull();
      expect(t.wizard.draft()).toEqual(ING.mapping);
    });

    it('shows the profile the server recognised in the file as already chosen, and says why', async () => {
      const t = await setup({ file: { parse: parseResponse({ suggestedProfileId: 4 }) } });

      expect(selectedText(t.select())).toBe('ING');
      expect(t.notice()).toBe(
        'This file looks like your "ING" profile, so its columns and formats are filled in. Check them against the first rows below.',
      );
    });

    it('leaves the choice on "none" when the server recognises a profile that is not in the list', async () => {
      const t = await setup({ file: { parse: parseResponse({ suggestedProfileId: 99 }) } });

      expect(selectedText(t.select())).toBe('None: set the columns below');
      expect(t.notice()).toBe('');
    });
  });

  describe('when the profiles cannot be loaded', () => {
    it('says so, that none was applied and that the columns can be set by hand, with no hint about profiles', async () => {
      const t = await setup({ profiles: 'error', file: { parse: parseResponse({ suggestedProfileId: 4 }) } });

      expect(textOf(t.element)).toContain(
        'The saved profiles could not be loaded, so none was applied. You can still set the columns by hand.',
      );
      expect(textOf(t.element)).not.toContain('A profile remembers the columns');
      expect(optionTexts(t.select())).toEqual(['None: set the columns below']);
      expect(t.select().disabled).toBe(false);
      expect(t.wizard.selectedProfileId()).toBeNull();
    });

    it('tries again, and offers the profiles once they come', async () => {
      const t = await setup({ profiles: 'error' });

      await t.press('Try again');
      http.expectOne('/api/import/profiles').flush(PROFILES);
      await settle(t.fixture);

      expect(textOf(t.element)).not.toContain('could not be loaded');
      expect(optionTexts(t.select())).toEqual([
        'None: set the columns below',
        'Comma bank',
        'ING',
        'Revolut',
      ]);
      expect(textOf(t.element)).toContain('A profile remembers the columns and formats of one bank.');
    });

    it('keeps saying so when it fails again', async () => {
      const t = await setup({ profiles: 'error' });

      await t.press('Try again');
      flushError(http.expectOne('/api/import/profiles'), 500, 'internal_error', 'Still broken');
      await settle(t.fixture);

      expect(textOf(t.element)).toContain('The saved profiles could not be loaded');
      expect(queryByRole(t.element, 'button', 'Try again')).not.toBeNull();
    });
  });

  describe('managing the profiles', () => {
    it('opens the dialog of the profiles, and closing it gives focus back to the button', async () => {
      const t = await setup();
      expect(queryByRole(t.element, 'dialog', 'Import profiles')).toBeNull();
      t.manage().focus();

      await t.press('Manage profiles');
      expect(t.dialog()).toBeTruthy();
      expect((t.dialog() as HTMLDialogElement).open).toBe(true);

      await t.press('Close', t.dialog());

      expect(queryByRole(t.element, 'dialog', 'Import profiles')).toBeNull();
      expect(document.activeElement).toBe(t.manage());
    });

    it('closes the dialog with Escape', async () => {
      const t = await setup();
      await t.press('Manage profiles');

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(t.fixture);

      expect(queryByRole(t.element, 'dialog', 'Import profiles')).toBeNull();
    });

    it('shows a profile renamed in the dialog under its new name, and keeps it chosen', async () => {
      const t = await setup();
      await t.pick('4');
      await t.press('Manage profiles');
      await t.press('Rename profile ING', t.dialog());
      typeInto(getByLabel(t.dialog(), 'New name for ING'), 'ING Direct');
      await settle(t.fixture);

      await t.press('Save name', t.dialog());
      http.expectOne('/api/import/profiles/4').flush({ ...ING, name: 'ING Direct' });
      await t.reload([COMMA_BANK, { ...ING, name: 'ING Direct' }, REVOLUT]);

      expect(optionTexts(t.select())).toEqual([
        'None: set the columns below',
        'Comma bank',
        'ING Direct',
        'Revolut',
      ]);
      expect(selectedText(t.select())).toBe('ING Direct');
    });

    it('goes back to "none" when the profile in use is deleted in the dialog, and keeps the mapping', async () => {
      const t = await setup();
      await t.pick('4');
      await t.press('Manage profiles');
      await t.press('Delete profile ING', t.dialog());

      const confirm = getByRole(t.element, 'dialog', /^Delete the profile "ING"\?/);
      await t.press('Delete profile', confirm);
      const request = http.expectOne('/api/import/profiles/4');
      expect(request.request.method).toBe('DELETE');
      request.flush(null, { status: 204, statusText: 'No Content' });
      await t.reload([COMMA_BANK, REVOLUT]);

      expect(optionTexts(t.select())).toEqual(['None: set the columns below', 'Comma bank', 'Revolut']);
      expect(selectedText(t.select())).toBe('None: set the columns below');
      expect(t.notice()).toBe('');
      expect(t.wizard.draft()).toEqual(ING.mapping);
      expect(t.toasts()).toEqual(['Profile ING deleted.']);
    });
  });

  it('labels every control and has nothing a screen reader cannot use, also with the dialog open', async () => {
    const t = await setup({ file: { parse: parseResponse({ suggestedProfileId: 4 }) } });
    expect(getByLabel(t.element, 'Saved profile')).toBeTruthy();
    expect(a11yProblems(t.element)).toEqual([]);

    await t.press('Manage profiles');
    expect(a11yProblems(t.element)).toEqual([]);
  });

  it('announces a profile notice in a status region that is in the page before the notice', async () => {
    const t = await setup();
    const region = getByRole(t.picker, 'status');
    expect(textOf(region)).toBe('');

    await t.pick('4');

    expect(getByRole(t.picker, 'status')).toBe(region);
    expect(textOf(region)).toContain('Profile "ING" applied.');
  });
});
