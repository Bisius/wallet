import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { By } from '@angular/platform-browser';
import type { TagDto } from '@wallet/shared';
import { MAX_TAGS_PER_SPENDING } from '@wallet/shared/limits';
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
import { flushError, primeStores, render, settle } from '../../../testing/harness';
import { Field } from './field';
import { TagInput } from './tag-input';

@Component({
  selector: 'app-tag-input-host',
  imports: [ReactiveFormsModule, Field, TagInput],
  template: `
    <div (keydown)="leaked.push($event.key)">
      <app-field label="Tags" [optional]="true">
        <app-tag-input [formControl]="control" />
      </app-field>
    </div>
    <button type="button">After the field</button>
  `,
})
class Host {
  readonly control = new FormControl<number[]>([], { nonNullable: true });
  /** Keys that reached an ancestor of the field. */
  readonly leaked: string[] = [];
}

const GROCERIES = tagDto({ id: 1, name: 'Groceries', color: '#15803d' });
const TRAVEL = tagDto({ id: 2, name: 'Travel' });
const CAFE = tagDto({ id: 3, name: 'Café', color: '#b45309' });
const GROUP = tagDto({ id: 4, name: 'Group lunch' });
const TAGS = [CAFE, GROCERIES, GROUP, TRAVEL];

describe('TagInput', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function setup(options: { tags?: TagDto[]; value?: number[] } = {}) {
    await primeStores(http);
    const fixture = await render(Host);
    http.expectOne('/api/tags').flush(options.tags ?? TAGS);
    const host = fixture.componentInstance;
    if (options.value) host.control.setValue(options.value);
    await settle(fixture);

    const element = fixture.nativeElement as HTMLElement;
    const input = () => getByRole(element, 'combobox', 'Tags (optional)') as HTMLInputElement;
    const listbox = () => getByRole(element, 'listbox') as HTMLElement;
    const optionEls = () => queryAllByRole(listbox(), 'option');
    const helpers = {
      fixture,
      host,
      element,
      input,
      listbox,
      options: () => optionEls().map((option) => textOf(option)),
      chips: () =>
        queryAllByRole(element, 'listitem').map((item) => textOf(item).replace(/\s+/g, ' ')),
      announcement: () => textOf(element.querySelector('p.sr-only') as HTMLElement),
      type: async (text: string) => {
        input().focus();
        typeInto(input(), text);
        await settle(fixture);
      },
      /** Presses a key in the box. Resolves to the event, to see whether it was prevented. */
      press: async (key: string) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        input().dispatchEvent(event);
        await settle(fixture);
        return event;
      },
      click: async (element: HTMLElement) => {
        element.click();
        await settle(fixture);
      },
      option: (name: string) => getByRole(listbox(), 'option', name),
    };
    return helpers;
  }

  describe('the box', () => {
    it('is a labelled combobox that controls a listbox, closed until it is used', async () => {
      const t = await setup();

      const input = t.input();
      expect(input.getAttribute('aria-autocomplete')).toBe('list');
      expect(input.getAttribute('aria-expanded')).toBe('false');
      expect(input.getAttribute('aria-controls')).toBe(t.listbox().id);
      expect(input.hasAttribute('aria-activedescendant')).toBe(false);
      expect(t.listbox().hidden).toBe(true);
      expect(getByLabel(t.element, 'Tags (optional)')).toBe(input);
    });

    it('keeps the list out of the tab order, so Tab from the box goes on to the next control', async () => {
      const t = await setup();

      // A list that scrolls is a tab stop of its own in Chromium unless it says otherwise. It is hidden
      // as soon as the box loses focus, so landing on it would drop focus to the page: Tab would need
      // pressing twice, and a screen reader would hear nothing in between. The options are reached with
      // the arrow keys, which move `aria-activedescendant` and never focus.
      expect(t.listbox().getAttribute('tabindex')).toBe('-1');
    });

    it('takes no more characters than a tag name can have', async () => {
      const t = await setup();
      expect(t.input().getAttribute('maxlength')).toBe('30');
    });

    it('shows the tags there are when it is clicked, so one can be taken without typing', async () => {
      const t = await setup();

      await t.click(t.input());

      expect(t.input().getAttribute('aria-expanded')).toBe('true');
      expect(t.listbox().hidden).toBe(false);
      expect(t.options()).toEqual(['Café', 'Groceries', 'Group lunch', 'Travel']);
      // Nothing is highlighted until the person moves to an entry, so Enter does not choose by surprise.
      expect(t.input().hasAttribute('aria-activedescendant')).toBe(false);
    });
  });

  describe('finding a tag', () => {
    it('narrows the list as the person types, ignoring case', async () => {
      const t = await setup();

      await t.type('gro');

      expect(t.options()).toEqual(['Groceries', 'Group lunch', "Create tag 'gro'"]);
    });

    it('also finds a tag whatever the accents, but still offers the exact name as new', async () => {
      const t = await setup();

      await t.type('cafe');

      // "Cafe" is not "Café" for the API, so it is a name that can be created.
      expect(t.options()).toEqual(['Café', "Create tag 'cafe'"]);
    });

    it('puts the tag that is exactly the text first, then the ones that start with it', async () => {
      const t = await setup({
        tags: [
          tagDto({ id: 5, name: 'Big Travel' }),
          tagDto({ id: 6, name: 'Travel agency' }),
          TRAVEL,
        ],
      });

      await t.type('travel');

      expect(t.options()).toEqual(['Travel', 'Travel agency', 'Big Travel']);
    });

    it('highlights the first entry as the person types, and names it for assistive technology', async () => {
      const t = await setup();

      await t.type('gro');

      const first = t.option('Groceries');
      expect(first.getAttribute('aria-selected')).toBe('true');
      expect(t.input().getAttribute('aria-activedescendant')).toBe(first.id);
      expect(t.option('Group lunch').getAttribute('aria-selected')).toBe('false');
    });

    it('does not offer a tag that is already chosen', async () => {
      const t = await setup({ value: [2] });

      await t.click(t.input());

      expect(t.options()).toEqual(['Café', 'Groceries', 'Group lunch']);
    });

    it('trims the spaces around what is typed', async () => {
      const t = await setup();

      await t.type('  travel  ');

      expect(t.options()).toEqual(['Travel']);
    });

    it('says nothing is offered when the text matches nothing and the name is taken by a chosen tag', async () => {
      const t = await setup({ value: [1] });

      await t.type('GROCERIES');

      expect(t.options()).toEqual([]);
      expect(t.input().getAttribute('aria-expanded')).toBe('false');
      expect(textOf(t.element)).toContain('Groceries is already added.');
      expect(t.input().getAttribute('aria-describedby')).toContain('message');
    });
  });

  describe('keyboard', () => {
    it('moves through the entries with the arrow keys and wraps around', async () => {
      const t = await setup();
      await t.type('gro');
      expect(t.input().getAttribute('aria-activedescendant')).toBe(t.option('Groceries').id);

      const down = await t.press('ArrowDown');
      expect(down.defaultPrevented).toBe(true);
      expect(t.input().getAttribute('aria-activedescendant')).toBe(t.option('Group lunch').id);

      await t.press('ArrowDown');
      expect(t.input().getAttribute('aria-activedescendant')).toBe(t.option("Create tag 'gro'").id);

      await t.press('ArrowDown');
      expect(t.input().getAttribute('aria-activedescendant')).toBe(t.option('Groceries').id);

      await t.press('ArrowUp');
      expect(t.input().getAttribute('aria-activedescendant')).toBe(t.option("Create tag 'gro'").id);
      expect(t.option("Create tag 'gro'").getAttribute('aria-selected')).toBe('true');
      expect(t.option('Groceries').getAttribute('aria-selected')).toBe('false');
    });

    it('opens the list with ArrowDown, on the first entry, and with ArrowUp, on the last', async () => {
      const t = await setup();

      await t.press('ArrowDown');
      expect(t.input().getAttribute('aria-expanded')).toBe('true');
      expect(t.input().getAttribute('aria-activedescendant')).toBe(t.option('Café').id);

      await t.press('Escape');
      expect(t.input().getAttribute('aria-expanded')).toBe('false');

      await t.press('ArrowUp');
      expect(t.input().getAttribute('aria-expanded')).toBe('true');
      expect(t.input().getAttribute('aria-activedescendant')).toBe(t.option('Travel').id);
    });

    it('chooses the highlighted entry with Enter, clears the box and closes the list', async () => {
      const t = await setup();
      await t.type('trav');

      const enter = await t.press('Enter');

      // Enter in the box does not send the form it sits in.
      expect(enter.defaultPrevented).toBe(true);
      expect(t.host.control.value).toEqual([2]);
      expect(t.chips()).toEqual(['Travel']);
      expect(t.input().value).toBe('');
      expect(t.input().getAttribute('aria-expanded')).toBe('false');
      expect(t.announcement()).toBe('Tag Travel added. 1 tag chosen.');
    });

    it('chooses another entry after the arrow keys', async () => {
      const t = await setup();
      await t.type('gro');
      await t.press('ArrowDown');

      await t.press('Enter');

      expect(t.host.control.value).toEqual([4]);
    });

    it('closes only the list on Escape, so a dialog around the field stays open', async () => {
      const t = await setup();
      await t.click(t.input());

      const escape = await t.press('Escape');

      expect(escape.defaultPrevented).toBe(true);
      expect(t.input().getAttribute('aria-expanded')).toBe('false');
      expect(t.host.leaked).not.toContain('Escape');
    });

    it('lets Escape through when there is no list to close, so the dialog can close', async () => {
      const t = await setup();

      const escape = await t.press('Escape');

      expect(escape.defaultPrevented).toBe(false);
      expect(t.host.leaked).toContain('Escape');
    });

    it('takes the last chip off with Backspace in an empty box', async () => {
      const t = await setup({ value: [1, 2] });

      const backspace = await t.press('Backspace');

      expect(backspace.defaultPrevented).toBe(true);
      expect(t.host.control.value).toEqual([1]);
      expect(t.announcement()).toBe('Tag Travel removed.');
    });

    it('leaves Backspace alone while there is text to delete', async () => {
      const t = await setup({ value: [1, 2] });
      await t.type('x');

      const backspace = await t.press('Backspace');

      expect(backspace.defaultPrevented).toBe(false);
      expect(t.host.control.value).toEqual([1, 2]);
    });

    it('lets Enter send the form when the box is empty, and holds it back when there is text', async () => {
      const t = await setup({ value: [1] });

      const empty = await t.press('Enter');
      expect(empty.defaultPrevented).toBe(false);

      // A tag that is chosen already: there is nothing to add, and the form is not sent with the text.
      await t.type('groceries');
      const withText = await t.press('Enter');
      expect(withText.defaultPrevented).toBe(true);
      expect(t.host.control.value).toEqual([1]);
      expect(t.announcement()).toBe('Groceries is already added.');
    });

    it('also takes the highlighted entry when the list was closed with Escape, as the message says', async () => {
      const t = await setup();
      await t.type('trav');
      await t.press('Escape');
      expect(t.input().getAttribute('aria-expanded')).toBe('false');

      const enter = await t.press('Enter');

      expect(enter.defaultPrevented).toBe(true);
      expect(t.host.control.value).toEqual([2]);
      expect(t.chips()).toEqual(['Travel']);
      expect(t.input().value).toBe('');
    });

    it('does what the message under the box says, "Press Enter to add it", when the box was left with text in it', async () => {
      const t = await setup();
      await t.type('Holiday');
      // The person goes on to the button of the form: the box loses focus, the list closes, the control is
      // touched and says what to do. Focus comes back to the box (the form puts it there) with the list closed.
      t.input().blur();
      await settle(t.fixture);
      expect(fieldError(t.input())).toBe(
        "The text in the box isn't added yet. Press Enter to add it, or clear the box.",
      );
      t.input().focus();
      await settle(t.fixture);
      expect(t.input().getAttribute('aria-expanded')).toBe('false');

      await t.press('Enter');

      const post = http.expectOne('/api/tags');
      expect(post.request.body).toEqual({ name: 'Holiday' });
      post.flush(tagDto({ id: 7, name: 'Holiday' }), { status: 201, statusText: 'Created' });
      await settle(t.fixture);
      http.expectOne('/api/tags').flush([...TAGS, tagDto({ id: 7, name: 'Holiday' })]);
      await settle(t.fixture);
      expect(t.host.control.value).toEqual([7]);
      expect(t.host.control.valid).toBe(true);
    });

    it('ignores keys that belong to an input method that is composing text', async () => {
      const t = await setup();
      await t.type('gro');

      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      t.input().dispatchEvent(event);
      await settle(t.fixture);

      expect(event.defaultPrevented).toBe(false);
      expect(t.host.control.value).toEqual([]);
    });
  });

  describe('a list longer than the space it has', () => {
    const MANY = Array.from({ length: 12 }, (_unused, index) =>
      tagDto({ id: index + 1, name: `Tag ${String.fromCharCode(65 + index)}` }),
    );

    it('keeps the highlighted entry in view, since the highlight alone does not scroll the list', async () => {
      const t = await setup({ tags: MANY });
      const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
      try {
        await t.click(t.input());
        await t.press('ArrowDown');
        await t.press('ArrowDown');
        const second = t.option('Tag B');
        expect(t.input().getAttribute('aria-activedescendant')).toBe(second.id);
        expect(scroll.mock.contexts.at(-1)).toBe(second);
        expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' });

        // ArrowUp from the top goes round to the last entry, which is out of sight.
        await t.press('ArrowUp');
        await t.press('ArrowUp');
        const last = t.option('Tag L');
        expect(t.input().getAttribute('aria-activedescendant')).toBe(last.id);
        expect(scroll.mock.contexts.at(-1)).toBe(last);
      } finally {
        scroll.mockRestore();
      }
    });

    it('brings the first entry back into view when the text changes the list', async () => {
      const t = await setup({ tags: MANY });
      const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
      try {
        await t.type('tag');
        expect(scroll.mock.contexts.at(-1)).toBe(t.option('Tag A'));
      } finally {
        scroll.mockRestore();
      }
    });
  });

  describe('pointer', () => {
    it('chooses an entry that is clicked, and does not take focus off the box', async () => {
      const t = await setup();
      await t.click(t.input());
      t.input().focus();

      const option = t.option('Groceries');
      const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      option.dispatchEvent(mouseDown);
      expect(mouseDown.defaultPrevented).toBe(true);
      await t.click(option);

      expect(t.host.control.value).toEqual([1]);
      expect(document.activeElement).toBe(t.input());
    });

    it('closes the list when the box loses focus, and marks the control touched', async () => {
      const t = await setup();
      await t.click(t.input());
      t.input().focus();
      expect(t.host.control.touched).toBe(false);

      t.input().blur();
      await settle(t.fixture);

      expect(t.input().getAttribute('aria-expanded')).toBe('false');
      expect(t.host.control.touched).toBe(true);
    });
  });

  describe('the chips', () => {
    it('show the name and the color of each chosen tag, with a button named after the tag', async () => {
      const t = await setup({ value: [1, 2] });

      expect(t.chips()).toEqual(['Groceries', 'Travel']);
      expect(getByRole(t.element, 'button', 'Remove tag Groceries')).toBeTruthy();
      // The color is a decoration: the name is what tells tags apart.
      const dot = t.element.querySelector<HTMLElement>('[aria-hidden="true"].rounded-full');
      expect(dot?.style.backgroundColor).not.toBe('');
    });

    it('are a list named "Selected tags"', async () => {
      const t = await setup({ value: [1] });
      expect(getByRole(t.element, 'list', 'Selected tags')).toBeTruthy();
    });

    it('take a tag off with its button, say so, and put the cursor back in the box', async () => {
      const t = await setup({ value: [1, 2] });

      await t.click(getByRole(t.element, 'button', 'Remove tag Groceries'));

      expect(t.host.control.value).toEqual([2]);
      expect(t.announcement()).toBe('Tag Groceries removed.');
      expect(document.activeElement).toBe(t.input());
    });

    it('call a tag the list does not know by its number, so it can still be taken off', async () => {
      const t = await setup({ value: [99] });

      expect(t.chips()).toEqual(['Tag 99']);
    });

    it('keep the order they were chosen in', async () => {
      const t = await setup();
      await t.type('trav');
      await t.press('Enter');
      await t.type('caf');
      await t.press('Enter');

      expect(t.host.control.value).toEqual([2, 3]);
      expect(t.chips()).toEqual(['Travel', 'Café']);
    });
  });

  describe('creating a tag', () => {
    it('offers "Create tag \'X\'" when no tag has the name, ignoring case', async () => {
      const t = await setup();

      await t.type('Holiday');
      expect(t.options()).toEqual(["Create tag 'Holiday'"]);

      await t.type('TRAVEL');
      // "TRAVEL" is the tag "Travel": it is offered, and creating it is not.
      expect(t.options()).toEqual(['Travel']);
    });

    it('sends POST /api/tags, then chooses the tag it made', async () => {
      const t = await setup();
      await t.type('  Holiday ');

      await t.press('Enter');

      const post = http.expectOne('/api/tags');
      expect(post.request.method).toBe('POST');
      expect(post.request.body).toEqual({ name: 'Holiday' });
      post.flush(tagDto({ id: 7, name: 'Holiday' }), { status: 201, statusText: 'Created' });
      await settle(t.fixture);
      http.expectOne('/api/tags').flush([...TAGS, tagDto({ id: 7, name: 'Holiday' })]);
      await settle(t.fixture);

      expect(t.host.control.value).toEqual([7]);
      expect(t.chips()).toEqual(['Holiday']);
      expect(t.input().value).toBe('');
      expect(t.announcement()).toBe('Tag Holiday added. 1 tag chosen.');
    });

    it('takes the existing tag when the name was taken meanwhile (409 tag_name_taken)', async () => {
      const t = await setup();
      await t.type('holiday');
      await t.press('Enter');

      flushError(
        http.expectOne('/api/tags'),
        409,
        'tag_name_taken',
        'A tag named "holiday" already exists',
      );
      await settle(t.fixture);
      // The list is loaded again, and the tag that appeared meanwhile is in it, with another capitalization.
      http.expectOne('/api/tags').flush([...TAGS, tagDto({ id: 8, name: 'Holiday' })]);
      await settle(t.fixture);

      expect(t.host.control.value).toEqual([8]);
      expect(t.chips()).toEqual(['Holiday']);
      expect(t.announcement()).toBe('Holiday already existed. Tag Holiday added. 1 tag chosen.');
      expect(queryByRole(t.element, 'alert')).toBeNull();
    });

    it('says what went wrong when the tag could not be made, and chooses nothing', async () => {
      const t = await setup();
      await t.type('Holiday');
      await t.press('Enter');

      flushError(http.expectOne('/api/tags'), 500, 'internal_error', 'The table is locked');
      await settle(t.fixture);

      expect(textOf(getByRole(t.element, 'alert'))).toBe(
        "Couldn't create the tag. The table is locked",
      );
      expect(t.host.control.value).toEqual([]);
      // What was typed stays, to try again.
      expect(t.input().value).toBe('Holiday');
    });

    it('makes the tag once when Enter is pressed twice', async () => {
      const t = await setup();
      await t.type('Holiday');
      await t.press('Enter');
      await t.press('Enter');

      http
        .expectOne('/api/tags')
        .flush(tagDto({ id: 7, name: 'Holiday' }), { status: 201, statusText: 'Created' });
      await settle(t.fixture);
      http.expectOne('/api/tags').flush([...TAGS, tagDto({ id: 7, name: 'Holiday' })]);
      await settle(t.fixture);

      expect(t.host.control.value).toEqual([7]);
    });

    it('can be done by clicking the entry', async () => {
      const t = await setup();
      await t.type('Holiday');

      await t.click(t.option("Create tag 'Holiday'"));

      const post = http.expectOne('/api/tags');
      expect(post.request.body).toEqual({ name: 'Holiday' });
      post.flush(tagDto({ id: 7, name: 'Holiday' }), { status: 201, statusText: 'Created' });
      await settle(t.fixture);
      http.expectOne('/api/tags').flush([...TAGS, tagDto({ id: 7, name: 'Holiday' })]);
      await settle(t.fixture);
    });
  });

  describe('the limit', () => {
    const MANY = Array.from({ length: 12 }, (_unused, index) =>
      tagDto({ id: index + 1, name: `Tag ${String.fromCharCode(65 + index)}` }),
    );

    it('says so when a tag is the last that fits', async () => {
      const t = await setup({
        tags: MANY,
        value: MANY.slice(0, MAX_TAGS_PER_SPENDING - 1).map((tag) => tag.id),
      });
      await t.type('Tag K');

      await t.press('Enter');

      expect(t.host.control.value).toHaveLength(MAX_TAGS_PER_SPENDING);
      expect(t.announcement()).toContain(
        'A spending can have up to 10 tags. Remove one to add another.',
      );
      expect(textOf(t.element)).toContain(
        'A spending can have up to 10 tags. Remove one to add another.',
      );
    });

    it('offers nothing more once it is reached, and explains why', async () => {
      const t = await setup({
        tags: MANY,
        value: MANY.slice(0, MAX_TAGS_PER_SPENDING).map((tag) => tag.id),
      });

      await t.type('Tag K');

      expect(t.options()).toEqual([]);
      expect(t.input().getAttribute('aria-expanded')).toBe('false');
      expect(textOf(t.element)).toContain(
        'A spending can have up to 10 tags. Remove one to add another.',
      );
      await t.press('Enter');
      expect(t.host.control.value).toHaveLength(MAX_TAGS_PER_SPENDING);
      http.expectNone('/api/tags');
    });

    it('lets one go and then take another', async () => {
      const t = await setup({
        tags: MANY,
        value: MANY.slice(0, MAX_TAGS_PER_SPENDING).map((tag) => tag.id),
      });

      await t.click(getByRole(t.element, 'button', 'Remove tag Tag A'));
      await t.type('Tag K');
      expect(t.options()).toEqual(['Tag K']);
      await t.press('Enter');

      expect(t.host.control.value).toHaveLength(MAX_TAGS_PER_SPENDING);
      expect(t.host.control.value).toContain(11);
    });
  });

  describe('text that was never taken as a tag', () => {
    it('makes the control invalid, and says to press Enter or to clear the box', async () => {
      const t = await setup();
      expect(t.host.control.valid).toBe(true);

      await t.type('Holi');

      expect(t.host.control.errors).toEqual({
        pendingTag: {
          message: "The text in the box isn't added yet. Press Enter to add it, or clear the box.",
        },
      });
      t.input().blur();
      await settle(t.fixture);
      expect(fieldError(t.input())).toBe(
        "The text in the box isn't added yet. Press Enter to add it, or clear the box.",
      );
      expect(t.input().getAttribute('aria-invalid')).toBe('true');
    });

    it('does not change with every character typed, since the field reads its error out each time it changes', async () => {
      const t = await setup();
      await t.type('H');
      const first = t.host.control.errors;

      await t.type('Ho');
      await t.type('Hol');
      await t.type('Holi');

      expect(t.host.control.errors).toEqual(first);
      expect(JSON.stringify(first)).not.toContain('Holi');
    });

    it('is valid again once the tag is taken or the box is cleared', async () => {
      const t = await setup();
      await t.type('trav');
      expect(t.host.control.invalid).toBe(true);

      await t.press('Enter');
      expect(t.host.control.valid).toBe(true);

      await t.type('xyz');
      expect(t.host.control.invalid).toBe(true);
      await t.type('');
      expect(t.host.control.valid).toBe(true);
    });

    it('does not count the spaces around it', async () => {
      const t = await setup();
      await t.type('   ');
      expect(t.host.control.valid).toBe(true);
    });

    it('says a tag that is chosen already is, instead of asking to add it', async () => {
      const t = await setup({ value: [1] });
      await t.type('groceries');

      expect(t.host.control.errors).toEqual({
        pendingTag: { message: 'That tag is already added. Clear the box.' },
      });
    });

    it('says to clear the box when no more tags fit', async () => {
      const many = Array.from({ length: 11 }, (_unused, index) =>
        tagDto({ id: index + 1, name: `Tag ${String.fromCharCode(65 + index)}` }),
      );
      const t = await setup({ tags: many, value: many.slice(0, 10).map((tag) => tag.id) });
      await t.type('Tag K');

      expect(t.host.control.errors).toEqual({
        pendingTag: { message: 'Clear the box: a spending can have up to 10 tags.' },
      });
    });
  });

  describe('as a form control', () => {
    it('shows the ids it is given as chips, and holds a copy', async () => {
      const t = await setup();
      const given = [2, 1];

      t.host.control.setValue(given);
      await settle(t.fixture);
      await t.type('caf');
      await t.press('Enter');

      expect(given).toEqual([2, 1]);
      expect(t.host.control.value).toEqual([2, 1, 3]);
    });

    it('empties when the form resets it', async () => {
      const t = await setup({ value: [1] });

      t.host.control.reset([]);
      await settle(t.fixture);

      expect(t.chips()).toEqual([]);
    });

    it('can be disabled: the box and the buttons stop working', async () => {
      const t = await setup({ value: [1] });

      t.host.control.disable();
      await settle(t.fixture);

      expect(t.input().disabled).toBe(true);
      expect(
        (getByRole(t.element, 'button', 'Remove tag Groceries') as HTMLButtonElement).disabled,
      ).toBe(true);
    });

    it('can be focused from outside, for the form that brings it up', async () => {
      const t = await setup();
      const tagInput = t.fixture.debugElement.query(By.directive(TagInput))
        .componentInstance as TagInput;
      getByRole(t.element, 'button', 'After the field').focus();

      tagInput.focus();

      expect(document.activeElement).toBe(t.input());
    });
  });
});
