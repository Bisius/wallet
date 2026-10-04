import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { spendingCreateSchema, spendingUpdateSchema } from '@wallet/shared';
import {
  fieldError,
  getAllByLabel,
  getByLabel,
  getByRole,
  queryAllByRole,
  queryByRole,
  textOf,
  typeInto,
} from '../../../testing/dom';
import { spendingDto, spendingsPage, tagDto } from '../../../testing/fixtures';
import { flushError, settle, StubPage } from '../../../testing/harness';
import {
  OCTOBER,
  openSpendingsPage,
  PAGE,
  type SpendingsPageHelpers,
  spendingsUrl,
} from '../../../testing/spendings-harness';
import { LAST_BUDGET_KEY } from './last-budget.store';

const GROCERIES = tagDto({ id: 1, name: 'Groceries', color: '#15803d' });
const TRAVEL = tagDto({ id: 2, name: 'Travel' });
const HOLIDAY = tagDto({ id: 3, name: 'Holiday', color: '#2563eb' });
const TAGS = [GROCERIES, HOLIDAY, TRAVEL];

const CREATED = { status: 201, statusText: 'Created' };

describe('SpendingsPage: tags on a spending', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'spendings', component: StubPage }]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  const tagBox = (root: ParentNode) =>
    getByRole(root, 'combobox', 'Tags (optional)') as HTMLInputElement;

  /**
   * Types a name in a tag box and presses Enter, which takes the highlighted tag (or makes a new one).
   * Resolves to the Enter, to see whether it was kept from sending the form.
   */
  async function chooseTag(p: SpendingsPageHelpers, root: ParentNode, name: string) {
    const box = tagBox(root);
    box.focus();
    typeInto(box, name);
    await settle(p.fixture);
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    box.dispatchEvent(enter);
    await settle(p.fixture);
    return enter;
  }

  /** What follows an add: the page loads the list and the month view again (the tags are not asked again). */
  async function reloadAfterChange(p: SpendingsPageHelpers) {
    await settle(p.fixture);
    http.expectOne('/api/months/2026-10').flush(OCTOBER);
    http.expectOne(spendingsUrl({ month: '2026-10' })).flush(PAGE);
    await settle(p.fixture);
  }

  describe('adding', () => {
    it('keeps the tags out of the way: under "More", folded, until they are asked for', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });

      // The quick add is compact: the tags (and the description and Refund) are behind "More", and
      // no button of their own asks for them.
      const more = p.form().querySelector('details') as HTMLDetailsElement;
      expect(textOf(more.querySelector('summary') as Element)).toContain('More');
      expect(more.open).toBe(false);
      expect(more.contains(tagBox(p.form()))).toBe(true);
      expect(queryByRole(p.form(), 'button', 'Add tags')).toBeNull();
      // The fields of the quick entry are the ones they always were.
      for (const label of ['Amount', 'Budget', 'Date', 'Description (optional)', 'Refund']) {
        expect(getByLabel(p.form(), label), label).toBeTruthy();
      }
    });

    it('shows the tag field, with what it is for, once "More" is opened', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });

      await p.openMore();

      expect((p.form().querySelector('details') as HTMLDetailsElement).open).toBe(true);
      expect(tagBox(p.form())).toBeTruthy();
      expect(textOf(p.form())).toContain('They change no budget or balance.');
    });

    it('opens "More" by itself when a tag is chosen, so a chosen tag is never out of sight', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });
      const more = p.form().querySelector('details') as HTMLDetailsElement;
      expect(more.open).toBe(false);

      await chooseTag(p, p.form(), 'groc');

      expect(more.open).toBe(true);
    });

    it('sends the tags with the spending, by id', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });
      await p.type('Amount', '12,50', p.form());
      await p.openMore();
      await chooseTag(p, p.form(), 'groc');
      await chooseTag(p, p.form(), 'trav');
      expect(getByRole(p.form(), 'list', 'Selected tags')).toBeTruthy();

      await p.press('Add spending', p.form());

      const request = http.expectOne('/api/spendings');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({
        date: '2026-10-02',
        amount: 1250,
        budgetId: 1,
        tagIds: [1, 2],
      });
      expect(spendingCreateSchema.safeParse(request.request.body).success).toBe(true);
      request.flush(spendingDto({ id: 4, amount: 1250, tagIds: [1, 2] }), CREATED);
      await reloadAfterChange(p);
    });

    it('does not send tags when none were chosen, even with the field up', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });
      await p.openMore();
      await p.type('Amount', '3', p.form());

      await p.press('Add spending', p.form());

      const request = http.expectOne('/api/spendings');
      expect(request.request.body).toEqual({ date: '2026-10-02', amount: 300, budgetId: 1 });
      request.flush(spendingDto({ id: 4, amount: 300 }), CREATED);
      await reloadAfterChange(p);
    });

    it('takes Enter in the tag box for the tag, and does not add the spending', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });
      await p.type('Amount', '3', p.form());
      await p.openMore();

      const enter = await chooseTag(p, p.form(), 'trav');

      // In a browser, Enter in a field sends its form unless the key's default is prevented: that
      // is what keeps the spending from being added with the tag.
      expect(enter.defaultPrevented).toBe(true);
      expect(tagBox(p.form()).value).toBe('');
      expect(getByRole(p.form(), 'list', 'Selected tags')).toBeTruthy();
      http.expectNone('/api/spendings');
    });

    it('does not drop text left in the tag box without a word: the form says to add it or clear it', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });
      await p.type('Amount', '9', p.form());
      await p.openMore();
      tagBox(p.form()).focus();
      typeInto(tagBox(p.form()), 'Holi');
      await settle(p.fixture);

      await p.press('Add spending', p.form());

      expect(fieldError(tagBox(p.form()))).toBe(
        "The text in the box isn't added yet. Press Enter to add it, or clear the box.",
      );
      expect(document.activeElement).toBe(tagBox(p.form()));
      http.expectNone('/api/spendings');

      // Taking the tag, the spending goes.
      tagBox(p.form()).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await settle(p.fixture);
      await p.press('Add spending', p.form());
      const request = http.expectOne('/api/spendings');
      expect(request.request.body).toMatchObject({ tagIds: [3] });
      request.flush(spendingDto({ id: 4, amount: 900, tagIds: [3] }), CREATED);
      await reloadAfterChange(p);
    });

    it('is ready for the next entry: the tags are cleared, the budget and the date stay', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });
      await p.type('Amount', '5', p.form());
      await p.type('Budget', '2', p.form());
      await p.openMore();
      await chooseTag(p, p.form(), 'groc');

      await p.press('Add spending', p.form());
      http
        .expectOne('/api/spendings')
        .flush(spendingDto({ id: 4, budgetId: 2, amount: 500, tagIds: [1] }), CREATED);
      await reloadAfterChange(p);

      // No chips are left, but the field itself stays up: whoever tags one entry tags the next.
      expect((p.form().querySelector('details') as HTMLDetailsElement).open).toBe(true);
      expect(queryByRole(p.form(), 'list', 'Selected tags')).toBeNull();
      expect(tagBox(p.form()).value).toBe('');
      expect(p.value('Budget', p.form())).toBe('2');
      expect(localStorage.getItem(LAST_BUDGET_KEY)).toBe('2');
      expect(document.activeElement).toBe(getByLabel(p.form(), 'Amount'));

      await p.type('Amount', '7', p.form());
      await p.press('Add spending', p.form());
      const next = http.expectOne('/api/spendings');
      expect(next.request.body).toEqual({ date: '2026-10-02', amount: 700, budgetId: 2 });
      next.flush(spendingDto({ id: 5, budgetId: 2, amount: 700 }), CREATED);
      await reloadAfterChange(p);
    });

    it('makes a tag that does not exist yet, and sends the spending with it', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });
      await p.type('Amount', '40', p.form());
      await p.openMore();

      await chooseTag(p, p.form(), 'Gift');
      const post = http.expectOne('/api/tags');
      expect(post.request.method).toBe('POST');
      expect(post.request.body).toEqual({ name: 'Gift' });
      post.flush(tagDto({ id: 9, name: 'Gift' }), CREATED);
      await settle(p.fixture);
      http.expectOne('/api/tags').flush([...TAGS, tagDto({ id: 9, name: 'Gift' })]);
      await settle(p.fixture);

      await p.press('Add spending', p.form());
      const request = http.expectOne('/api/spendings');
      expect(request.request.body).toEqual({
        date: '2026-10-02',
        amount: 4000,
        budgetId: 1,
        tagIds: [9],
      });
      request.flush(spendingDto({ id: 4, amount: 4000, tagIds: [9] }), CREATED);
      await reloadAfterChange(p);
    });

    it('says that a spending can have ten tags at most, when they are all taken', async () => {
      const many = Array.from({ length: 11 }, (_unused, index) =>
        tagDto({ id: index + 1, name: `Tag ${String.fromCharCode(65 + index)}` }),
      );
      const p = await openSpendingsPage(http, { tags: many });
      await p.openMore();

      for (let index = 0; index < 10; index++) {
        await chooseTag(p, p.form(), `Tag ${String.fromCharCode(65 + index)}`);
      }

      expect(textOf(p.form())).toContain(
        'A spending can have up to 10 tags. Remove one to add another.',
      );
      expect(queryAllByRole(getByRole(p.form(), 'list', 'Selected tags'), 'listitem')).toHaveLength(
        10,
      );
    });

    it('takes a tag off the spending when the API says the tag no longer exists', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });
      await p.type('Amount', '9', p.form());
      await p.openMore();
      await chooseTag(p, p.form(), 'groc');
      await chooseTag(p, p.form(), 'trav');
      await p.press('Add spending', p.form());
      // The button is disabled while the request is out, and loses focus to the page, as in a browser.
      (document.activeElement as HTMLElement | null)?.blur();

      flushError(http.expectOne('/api/spendings'), 422, 'rule_violation', 'Tag 2 does not exist', {
        rule: 'unknown_tag',
        field: 'tagIds.1',
      });
      await settle(p.fixture);
      // The tags are loaded again, and Travel is not among them any more.
      http.expectOne('/api/tags').flush([GROCERIES, HOLIDAY]);
      await settle(p.fixture);

      // No field shows the problem (the alert at the top does): focus goes back to the button.
      expect(document.activeElement).toBe(getByRole(p.form(), 'button', 'Add spending'));

      expect(textOf(getByRole(p.form(), 'alert'))).toBe(
        'A tag you chose no longer exists, so it was taken off. Check the tags, then save again.',
      );
      const chips = getByRole(p.form(), 'list', 'Selected tags');
      expect(queryAllByRole(chips, 'listitem').map((item) => textOf(item))).toEqual(['Groceries']);
      expect(p.value('Amount', p.form())).toBe('9.00');

      // Saving again sends what is left.
      await p.press('Add spending', p.form());
      const again = http.expectOne('/api/spendings');
      expect(again.request.body).toMatchObject({ tagIds: [1] });
      again.flush(spendingDto({ id: 4, amount: 900, tagIds: [1] }), CREATED);
      await reloadAfterChange(p);
    });
  });

  describe('editing', () => {
    const TAGGED = spendingDto({ id: 7, description: 'Weekly shop', amount: 4200, tagIds: [1, 2] });

    async function openEdit() {
      const p = await openSpendingsPage(http, { tags: TAGS, page: spendingsPage([TAGGED]) });
      await p.press('Edit Weekly shop, €42.00');
      const dialog = p.dialog() as HTMLElement;
      return { p, dialog };
    }

    it("always has the tag field, with the spending's tags as chips", async () => {
      const { dialog } = await openEdit();

      expect(queryByRole(dialog, 'button', 'Add tags')).toBeNull();
      const chips = getByRole(dialog, 'list', 'Selected tags');
      expect(queryAllByRole(chips, 'listitem').map((item) => textOf(item))).toEqual([
        'Groceries',
        'Travel',
      ]);
      expect(getByRole(dialog, 'button', 'Remove tag Groceries')).toBeTruthy();
    });

    it('sends nothing about the tags when they did not change', async () => {
      const { p, dialog } = await openEdit();
      await p.type('Amount', '43', dialog);

      await p.press('Save changes', dialog);

      const request = http.expectOne('/api/spendings/7');
      expect(request.request.body).toEqual({ amount: 4300 });
      request.flush({ ...TAGGED, amount: 4300 });
      await reloadAfterChange(p);
    });

    it('replaces the whole set when a tag is added', async () => {
      const { p, dialog } = await openEdit();
      await chooseTag(p, dialog, 'holi');

      await p.press('Save changes', dialog);

      const request = http.expectOne('/api/spendings/7');
      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({ tagIds: [1, 2, 3] });
      expect(spendingUpdateSchema.safeParse(request.request.body).success).toBe(true);
      request.flush({ ...TAGGED, tagIds: [1, 2, 3] });
      await reloadAfterChange(p);
      expect(p.toasts()).toEqual(['Spending updated.']);
    });

    it('sends an empty set to take every tag off', async () => {
      const { p, dialog } = await openEdit();
      await p.press('Remove tag Groceries', dialog);
      await p.press('Remove tag Travel', dialog);

      await p.press('Save changes', dialog);

      const request = http.expectOne('/api/spendings/7');
      expect(request.request.body).toEqual({ tagIds: [] });
      expect(spendingUpdateSchema.safeParse(request.request.body).success).toBe(true);
      request.flush({ ...TAGGED, tagIds: [] });
      await reloadAfterChange(p);
    });

    it('sends nothing when the same tags are put back in another order', async () => {
      const { p, dialog } = await openEdit();
      await p.press('Remove tag Groceries', dialog);
      await chooseTag(p, dialog, 'groc');

      await p.press('Save changes', dialog);

      http.expectNone('/api/spendings/7');
      expect(p.dialog()).toBeNull();
    });

    it('closes the list on Escape and keeps the dialog; the next Escape closes the dialog', async () => {
      const { p, dialog } = await openEdit();
      const box = tagBox(dialog);
      box.focus();
      box.click();
      await settle(p.fixture);
      expect(box.getAttribute('aria-expanded')).toBe('true');

      box.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      await settle(p.fixture);
      expect(box.getAttribute('aria-expanded')).toBe('false');
      expect(p.dialog()).not.toBeNull();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(p.fixture);
      expect(p.dialog()).toBeNull();
    });

    it('shows a refused tag on the field when the API names it', async () => {
      const { p, dialog } = await openEdit();
      await chooseTag(p, dialog, 'holi');
      await p.press('Save changes', dialog);

      flushError(http.expectOne('/api/spendings/7'), 400, 'validation_error', 'Invalid request', [
        { path: 'tagIds', message: 'Too many tags' },
      ]);
      await settle(p.fixture);

      expect(textOf(dialog)).toContain('Too many tags');
      expect(p.dialog()).not.toBeNull();
    });
  });
});
