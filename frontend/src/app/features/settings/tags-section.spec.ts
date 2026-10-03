import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { tagUpdateSchema } from '@wallet/shared';
import type { TagDto } from '@wallet/shared';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog';
import { ToastContainer } from '../../shared/ui/toast-container';
import { ToastService } from '../../shared/ui/toast.service';
import {
  fieldError,
  getByLabel,
  getByRole,
  queryAllByRole,
  queryByRole,
  textOf,
  typeInto,
} from '../../../testing/dom';
import { tagDto } from '../../../testing/fixtures';
import { TagsStore } from '../../core/tags.store';
import { flushError, primeStores, settle } from '../../../testing/harness';
import { TagsSection } from './tags-section';

@Component({
  selector: 'app-tags-host',
  imports: [TagsSection, ConfirmDialog, ToastContainer],
  template: '<app-tags-section /><app-confirm-dialog /><app-toast-container />',
})
class Host {}

const GROCERIES = tagDto({ id: 1, name: 'Groceries', color: '#2563eb', usageCount: 12 });
const TRAVEL = tagDto({ id: 2, name: 'Travel', color: null, usageCount: 1 });
const IDEAS = tagDto({ id: 3, name: 'Ideas', color: '#123abc', usageCount: 0 });
const TAGS = [GROCERIES, IDEAS, TRAVEL];

describe('TagsSection', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function setup(tags: TagDto[] | 'loading' | 'error' = TAGS) {
    await primeStores(http);
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await settle(fixture);
    const request = http.expectOne('/api/tags');
    if (tags === 'error') flushError(request, 500, 'internal_error', 'No tag table');
    else if (tags !== 'loading') request.flush(tags);
    await settle(fixture);

    const element = fixture.nativeElement as HTMLElement;
    const section = () => getByRole(element, 'region', 'Tags');
    const formDialog = () => element.querySelector<HTMLDialogElement>('app-tag-form dialog');
    const confirmDialog = () =>
      element.querySelector<HTMLDialogElement>('app-confirm-dialog dialog')!;
    const helpers = {
      fixture,
      element,
      section,
      formDialog,
      confirmDialog,
      rows: () => queryAllByRole(section(), 'listitem').map((row) => textOf(row)),
      press: async (name: string | RegExp, root: ParentNode = element) => {
        getByRole(root, 'button', name).click();
        await settle(fixture);
      },
      type: async (label: string | RegExp, value: string) => {
        typeInto(getByLabel(formDialog()!, label), value);
        await settle(fixture);
      },
      choose: async (label: string) => {
        getByLabel(formDialog()!, label).click();
        await settle(fixture);
      },
      toasts: () =>
        TestBed.inject(ToastService)
          .toasts()
          .map((toast) => toast.message),
      /** After a change the section loads the tags again. */
      reload: async (tags: TagDto[]) => {
        await settle(fixture);
        http.expectOne('/api/tags').flush(tags);
        await settle(fixture);
      },
    };
    return helpers;
  }

  describe('the list', () => {
    it('shows each tag with its color in words and how many spendings carry it', async () => {
      const t = await setup();

      expect(textOf(getByRole(t.element, 'heading', 'Tags'))).toBe('Tags');
      expect(t.rows()).toEqual([
        'Groceries Blue · On 12 spendings Edit Delete',
        'Ideas #123abc · On 0 spendings Edit Delete',
        'Travel No color · On 1 spending Edit Delete',
      ]);
    });

    it('says that a tag never changes a budget or a balance, and where tags are made', async () => {
      const t = await setup();

      expect(textOf(t.section())).toContain('A tag never changes a budget or a balance.');
      expect(textOf(t.section())).toContain('You create tags while you add or edit a spending.');
      expect(queryByRole(t.section(), 'button', /New tag/)).toBeNull();
    });

    it('marks a tag with a dot in its color, or the tag icon when it has none', async () => {
      const t = await setup();

      const rows = queryAllByRole(t.section(), 'listitem');
      expect(
        rows[0].querySelector<HTMLElement>('[aria-hidden="true"].rounded-full')?.style
          .backgroundColor,
      ).not.toBe('');
      expect(rows[2].querySelector('[aria-hidden="true"].rounded-full')).toBeNull();
      expect(rows[2].querySelectorAll('svg').length).toBeGreaterThan(0);
    });

    it('names its buttons after the tag', async () => {
      const t = await setup();

      for (const name of ['Edit tag Groceries', 'Delete tag Groceries', 'Edit tag Travel']) {
        expect(getByRole(t.section(), 'button', name), name).toBeTruthy();
      }
    });

    it('says there are no tags yet', async () => {
      const t = await setup([]);

      expect(textOf(t.section())).toContain('No tags yet');
      expect(textOf(t.section())).toContain('Add a tag to a spending and it will be listed here.');
    });

    it('says it is loading', async () => {
      const t = await setup('loading');
      expect(textOf(t.section())).toContain('Loading tags…');
    });

    it('shows what the API said when the tags cannot be loaded, and can try again', async () => {
      const t = await setup('error');

      const alert = getByRole(t.section(), 'alert');
      expect(textOf(alert)).toContain("Couldn't load the tags");
      expect(textOf(alert)).toContain('No tag table');

      await t.press('Try again', alert);
      http.expectOne('/api/tags').flush(TAGS);
      await settle(t.fixture);
      expect(t.rows()).toHaveLength(3);
    });
  });

  describe('on a later visit', () => {
    it('shows the tags it has, and brings the counts up to date in the background', async () => {
      await primeStores(http);
      const store = TestBed.inject(TagsStore);
      await settle();
      http.expectOne('/api/tags').flush([GROCERIES, IDEAS, TRAVEL]);
      await settle();

      const fixture = TestBed.createComponent(Host);
      fixture.detectChanges();
      await settle(fixture);
      const section = getByRole(fixture.nativeElement as HTMLElement, 'region', 'Tags');
      expect(textOf(section)).toContain('Groceries Blue · On 12 spendings');

      // Spendings were added meanwhile, on another page.
      http.expectOne('/api/tags').flush([{ ...GROCERIES, usageCount: 15 }, IDEAS, TRAVEL]);
      await settle(fixture);

      expect(textOf(section)).toContain('Groceries Blue · On 15 spendings');
      expect(store.state()).toBe('ready');
    });
  });

  describe('editing', () => {
    it('opens a dialog with the name and the color of the tag', async () => {
      const t = await setup();

      await t.press('Edit tag Groceries');

      const dialog = t.formDialog()!;
      expect(dialog.open).toBe(true);
      expect(textOf(getByRole(dialog, 'heading', 'Edit tag Groceries'))).toBe('Edit tag Groceries');
      expect((getByLabel(dialog, 'Name') as HTMLInputElement).value).toBe('Groceries');
      expect(getByLabel(dialog, 'Name').getAttribute('maxlength')).toBe('30');
      expect((getByLabel(dialog, 'Blue') as HTMLInputElement).checked).toBe(true);
    });

    it('renames with PATCH, sending only the name, then loads the tags again and closes', async () => {
      const t = await setup();
      await t.press('Edit tag Groceries');
      await t.type('Name', '  Food ');

      await t.press('Save changes', t.formDialog()!);

      const request = http.expectOne('/api/tags/1');
      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({ name: 'Food' });
      expect(tagUpdateSchema.safeParse(request.request.body).success).toBe(true);
      request.flush({ ...GROCERIES, name: 'Food' });
      await t.reload([{ ...GROCERIES, name: 'Food' }, IDEAS, TRAVEL]);

      expect(t.rows()[0]).toContain('Food');
      expect(t.toasts()).toEqual(['Tag Food updated.']);
      expect(t.formDialog()).toBeNull();
    });

    it('allows changing only the capitalization of its own name', async () => {
      const t = await setup();
      await t.press('Edit tag Groceries');
      await t.type('Name', 'GROCERIES');

      await t.press('Save changes', t.formDialog()!);

      const request = http.expectOne('/api/tags/1');
      expect(request.request.body).toEqual({ name: 'GROCERIES' });
      request.flush({ ...GROCERIES, name: 'GROCERIES' });
      await t.reload([{ ...GROCERIES, name: 'GROCERIES' }, IDEAS, TRAVEL]);
    });

    it('recolors with PATCH, sending only the color', async () => {
      const t = await setup();
      await t.press('Edit tag Travel');
      await t.choose('Red');

      await t.press('Save changes', t.formDialog()!);

      const request = http.expectOne('/api/tags/2');
      expect(request.request.body).toEqual({ color: '#dc2626' });
      request.flush({ ...TRAVEL, color: '#dc2626' });
      await t.reload([GROCERIES, IDEAS, { ...TRAVEL, color: '#dc2626' }]);
      expect(t.rows()[2]).toContain('Red');
    });

    it('clears the color with null', async () => {
      const t = await setup();
      await t.press('Edit tag Groceries');
      await t.choose('None');

      await t.press('Save changes', t.formDialog()!);

      const request = http.expectOne('/api/tags/1');
      expect(request.request.body).toEqual({ color: null });
      expect(tagUpdateSchema.safeParse(request.request.body).success).toBe(true);
      request.flush({ ...GROCERIES, color: null });
      await t.reload([{ ...GROCERIES, color: null }, IDEAS, TRAVEL]);
      expect(t.rows()[0]).toContain('No color');
    });

    it('sends the name and the color together when both changed', async () => {
      const t = await setup();
      await t.press('Edit tag Travel');
      await t.type('Name', 'Trips');
      await t.choose('Green');

      await t.press('Save changes', t.formDialog()!);

      const request = http.expectOne('/api/tags/2');
      expect(request.request.body).toEqual({ name: 'Trips', color: '#15803d' });
      request.flush({ ...TRAVEL, name: 'Trips', color: '#15803d' });
      await t.reload(TAGS);
    });

    it('closes without a request when nothing changed', async () => {
      const t = await setup();
      await t.press('Edit tag Groceries');

      await t.press('Save changes', t.formDialog()!);

      http.expectNone('/api/tags/1');
      expect(t.formDialog()).toBeNull();
    });

    it('needs a name', async () => {
      const t = await setup();
      await t.press('Edit tag Groceries');
      await t.type('Name', '   ');

      await t.press('Save changes', t.formDialog()!);

      expect(fieldError(getByLabel(t.formDialog()!, 'Name'))).toBe('Name is required.');
      http.expectNone('/api/tags/1');
    });

    it('shows a name that another tag has on the name, and keeps the dialog open', async () => {
      const t = await setup();
      await t.press('Edit tag Travel');
      await t.type('Name', 'groceries');
      await t.press('Save changes', t.formDialog()!);

      flushError(
        http.expectOne('/api/tags/2'),
        409,
        'tag_name_taken',
        'A tag named "groceries" already exists',
      );
      await settle(t.fixture);

      const name = getByLabel(t.formDialog()!, 'Name');
      expect(fieldError(name)).toBe('A tag named "groceries" already exists');
      expect(name.getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(name);
      expect(t.toasts()).toEqual([]);
      expect(t.formDialog()).not.toBeNull();

      // Another name goes through.
      await t.type('Name', 'Trips');
      await t.press('Save changes', t.formDialog()!);
      const retry = http.expectOne('/api/tags/2');
      expect(retry.request.body).toEqual({ name: 'Trips' });
      retry.flush({ ...TRAVEL, name: 'Trips' });
      await t.reload([GROCERIES, IDEAS, { ...TRAVEL, name: 'Trips' }]);
    });

    it('shows another failure in the dialog', async () => {
      const t = await setup();
      await t.press('Edit tag Travel');
      await t.type('Name', 'Trips');
      await t.press('Save changes', t.formDialog()!);

      // The button is disabled while the request is out, and loses focus to the page, as in a browser.
      (document.activeElement as HTMLElement | null)?.blur();
      flushError(http.expectOne('/api/tags/2'), 500, 'internal_error', 'Something broke');
      await settle(t.fixture);

      expect(textOf(getByRole(t.formDialog()!, 'alert'))).toBe('Something broke');
      // No field shows the problem: focus goes back to the button that was pressed, inside the dialog.
      expect(document.activeElement).toBe(getByRole(t.formDialog()!, 'button', 'Save changes'));
    });

    it('cancels without a request', async () => {
      const t = await setup();
      await t.press('Edit tag Travel');
      await t.type('Name', 'Trips');

      await t.press('Cancel', t.formDialog()!);

      expect(t.formDialog()).toBeNull();
      http.expectNone('/api/tags/2');
    });
  });

  describe('deleting', () => {
    it('asks first, says how many spendings lose the tag and that they stay, and does nothing when cancelled', async () => {
      const t = await setup();

      await t.press('Delete tag Groceries');

      const text = textOf(t.confirmDialog());
      expect(text).toContain('Delete the tag "Groceries"?');
      expect(text).toContain(
        '"Groceries" is on 12 spendings. They lose the tag and stay exactly as they are: no amount, date or budget changes.',
      );
      await t.press('Cancel', t.confirmDialog());
      http.expectNone('/api/tags/1');
    });

    it('speaks of one spending in the singular', async () => {
      const t = await setup();
      await t.press('Delete tag Travel');

      expect(textOf(t.confirmDialog())).toContain(
        '"Travel" is on 1 spending. It loses the tag and stays exactly as it is: no amount, date or budget changes.',
      );
    });

    it('says a tag on no spending changes nothing else', async () => {
      const t = await setup();
      await t.press('Delete tag Ideas');

      expect(textOf(t.confirmDialog())).toContain(
        '"Ideas" is not on any spending, so nothing else changes.',
      );
    });

    it('deletes once confirmed, loads the tags again and puts focus on the heading', async () => {
      const t = await setup();
      await t.press('Delete tag Travel');
      await t.press('Delete tag', t.confirmDialog());

      const request = http.expectOne('/api/tags/2');
      expect(request.request.method).toBe('DELETE');
      request.flush(null, { status: 204, statusText: 'No Content' });
      await t.reload([GROCERIES, IDEAS]);

      expect(t.rows()).toHaveLength(2);
      expect(t.toasts()).toEqual(['Tag Travel deleted.']);
      expect(document.activeElement).toBe(getByRole(t.element, 'heading', 'Tags'));
    });

    it('says a tag that was already gone is gone, and loads the tags again', async () => {
      const t = await setup();
      await t.press('Delete tag Travel');
      await t.press('Delete tag', t.confirmDialog());

      flushError(http.expectOne('/api/tags/2'), 404, 'not_found', 'Tag not found');
      await t.reload([GROCERIES, IDEAS]);

      expect(t.toasts()).toEqual(['That tag was already gone.']);
      expect(t.rows()).toHaveLength(2);
    });

    it("reports another failure with the API's words", async () => {
      const t = await setup();
      await t.press('Delete tag Travel');
      await t.press('Delete tag', t.confirmDialog());

      flushError(http.expectOne('/api/tags/2'), 500, 'internal_error', 'Something broke');
      await settle(t.fixture);

      expect(t.toasts()).toEqual(["Couldn't delete the tag. Something broke"]);
      expect(t.rows()).toHaveLength(3);
      // The tag is still there, so focus goes back to its button and not to the heading.
      expect(document.activeElement).toBe(getByRole(t.section(), 'button', 'Delete tag Travel'));
    });
  });
});
