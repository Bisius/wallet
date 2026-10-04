import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { a11yProblems } from '../../../testing/a11y';
import { getByRole, queryAllByRole, queryByRole, textOf } from '../../../testing/dom';
import { primeStores, render, settle } from '../../../testing/harness';
import { ActionMenu, MenuItem } from './action-menu';
import { Amount } from './amount';
import { Button } from './button';
import { AppList, ListRow, type ListDensity } from './list';

@Component({
  selector: 'app-list-host',
  imports: [AppList, ListRow, Amount, ActionMenu, MenuItem, Button],
  template: `
    <ul appList aria-label="Spendings" [density]="density()">
      <li appListRow id="coffee" color="#2563eb">
        <span rowTitle>Coffee</span>
        <p rowMeta>Oct 2, 2026</p>
        <p rowMeta>
          <span>Groceries</span>
          <span>Refund</span>
        </p>
        <app-amount rowAmount [cents]="-350" outflow />
        <app-action-menu rowActions label="More actions for Coffee">
          <button appMenuItem (click)="pressed.push('edit')">Edit</button>
          <button appMenuItem destructive (click)="pressed.push('delete')">Delete</button>
        </app-action-menu>
      </li>
      <li
        appListRow
        id="lunch"
        [color]="null"
        titleLabel="Edit Lunch, €12.50"
        amountNote="a month"
        (titleClick)="pressed.push('title')"
      >
        <span rowTitle>Lunch</span>
        <app-amount rowAmount [cents]="1250" />
        <button rowActions appButton variant="ghost" size="sm" (click)="pressed.push('undo')">
          Undo
        </button>
        <p>Under the line: a bar, a notice.</p>
      </li>
      <li appListRow id="plain">
        <span rowTitle>Plain</span>
      </li>
      <li appListRow id="form" bare>
        <label>New name <input /></label>
      </li>
    </ul>
  `,
})
class ListHost {
  readonly density = signal<ListDensity>('comfortable');
  readonly pressed: string[] = [];
}

@Component({
  selector: 'app-list-below-host',
  imports: [AppList, ListRow, Button],
  template: `
    <ul appList aria-label="Files">
      <li appListRow id="below" actionsBelow>
        <span rowTitle>Export</span>
        <p rowMeta>A line of text that needs the room.</p>
        <button rowActions appButton size="sm">Download</button>
      </li>
      <li appListRow id="beside">
        <span rowTitle>Plain</span>
        <button rowActions appButton size="sm">Undo</button>
      </li>
    </ul>
  `,
})
class BelowHost {}

describe('List', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function setup() {
    const fixture = await render(ListHost);
    await primeStores(http);
    await settle(fixture);
    const element = fixture.nativeElement as HTMLElement;
    const row = (id: string) => element.querySelector(`#${id}`) as HTMLElement;
    return { fixture, host: fixture.componentInstance, element, row };
  }

  describe('as a list', () => {
    it('is a list of items, so a screen reader says how many there are', async () => {
      const { element } = await setup();

      const list = getByRole(element, 'list', 'Spendings');
      expect(list.tagName).toBe('UL');
      expect(list.getAttribute('role')).toBe('list');
      expect(queryAllByRole(list, 'listitem')).toHaveLength(4);
      expect(Array.from(list.children).map((child) => child.tagName)).toEqual([
        'LI',
        'LI',
        'LI',
        'LI',
      ]);
    });

    it('divides the rows with a hairline, with no box around the list or its rows', async () => {
      const { element, row } = await setup();

      const list = getByRole(element, 'list', 'Spendings');
      expect(list.classList).toContain('divide-y');
      expect(list.classList).not.toContain('border');
      expect(list.classList).not.toContain('rounded-card');
      expect(row('coffee').classList).not.toContain('border');
      expect(row('coffee').classList).not.toContain('rounded-card');
    });
  });

  describe('a row', () => {
    it('has a title, lines of detail, an amount and the actions', async () => {
      const { row } = await setup();

      const coffee = row('coffee');
      expect(textOf(coffee.querySelector('p') as Element)).toBe('Coffee');
      expect(textOf(coffee)).toContain('Oct 2, 2026');
      expect(textOf(coffee)).toContain('Groceries Refund');
      expect(textOf(coffee)).toContain('-€3.50');
      expect(getByRole(coffee, 'button', 'More actions for Coffee')).toBeTruthy();
    });

    it('puts each line of detail on a row of its own that wraps', async () => {
      const { row } = await setup();

      const details = row('coffee').querySelectorAll('[class*="empty:hidden"] > p');
      expect(details).toHaveLength(2);
      const wrapper = details[0].parentElement as HTMLElement;
      expect(wrapper.classList).toContain('text-muted');
      expect(wrapper.className).toContain('*:flex-wrap');
    });

    it('shows an amount of money that went out in plain, and a refund of it in green', async () => {
      const { row } = await setup();

      const refund = row('coffee').querySelector('app-amount span') as HTMLElement;
      expect(refund.textContent).toBe('-€3.50');
      expect(refund.className).toContain('text-positive');
      expect(refund.className).toContain('tabular-nums');
      const lunch = row('lunch').querySelector('app-amount span') as HTMLElement;
      expect(lunch.className).not.toContain('text-positive');
      expect(lunch.className).not.toContain('text-negative');
    });

    it('sets the amount at the end of the row, in semibold, with a small word under it', async () => {
      const { row } = await setup();

      const amount = row('lunch').querySelector('app-amount')?.parentElement as HTMLElement;
      expect(amount.classList).toContain('text-right');
      expect(amount.classList).toContain('font-semibold');
      expect(amount.classList).toContain('ml-auto');
      expect(textOf(amount)).toBe('€12.50 a month');
      expect(amount.querySelector('span.block')?.classList).toContain('text-muted');
    });

    it('wraps a long title and keeps the amount whole, so it fits a 320 px screen', async () => {
      const { row } = await setup();

      const title = row('coffee').querySelector('p') as HTMLElement;
      expect(title.classList).toContain('break-words');
      expect(title.parentElement?.classList).toContain('min-w-0');
      const line = row('coffee').firstElementChild as HTMLElement;
      expect(line.classList).toContain('flex-wrap');
      const amount = row('coffee').querySelector('app-amount')?.parentElement as HTMLElement;
      expect(amount.classList).toContain('shrink-0');
    });

    it('has no space for what it is not given, and says nothing for it', async () => {
      const { row } = await setup();

      const plain = row('plain');
      const parts = Array.from((plain.firstElementChild as HTMLElement).children) as HTMLElement[];
      const [leading, body, amount, actions] = parts;
      expect(leading.className).toContain('empty:hidden');
      expect(leading.childElementCount).toBe(0);
      expect(amount.childElementCount).toBe(0);
      expect(actions.childElementCount).toBe(0);
      expect(textOf(body)).toBe('Plain');
      expect(queryByRole(plain, 'button')).toBeNull();
    });

    it('is padded like every row, at least 44 px tall, and lights up under the pointer and the keyboard', async () => {
      const { row } = await setup();

      expect(row('coffee').classList).toContain('px-4');
      expect(row('coffee').classList).toContain('py-3');
      expect(row('coffee').classList).toContain('min-h-11');
      expect(row('coffee').classList).toContain('hover:bg-subtle');
      // Only keyboard focus, not a click that left focus on a button.
      expect(row('coffee').className).toContain('has-[:focus-visible]:bg-subtle');
    });
  });

  describe('the colour dot', () => {
    it('is a dot of the colour, for the eye only', async () => {
      const { row } = await setup();

      const dot = row('coffee').querySelector('span[aria-hidden="true"]') as HTMLElement;
      expect(dot.style.backgroundColor).not.toBe('');
      expect(dot.classList).toContain('rounded-full');
      expect(textOf(row('coffee'))).not.toContain('2563eb');
    });

    it('is a neutral dot for no colour at all, and no dot when none is asked for', async () => {
      const { row } = await setup();

      expect(row('lunch').querySelector('span[aria-hidden="true"]')).not.toBeNull();
      expect(
        (row('lunch').querySelector('span[aria-hidden="true"]') as HTMLElement).style
          .backgroundColor,
      ).toBe('');
      expect(row('plain').querySelector('span[aria-hidden="true"]')).toBeNull();
    });
  });

  describe('the title as a button', () => {
    it('is plain text unless the row says what the title does', async () => {
      const { row } = await setup();

      expect(queryByRole(row('coffee'), 'button', 'Coffee')).toBeNull();
      expect(row('coffee').querySelector('p')?.textContent?.trim()).toBe('Coffee');
    });

    it('is a button named for what it does, which does it', async () => {
      const { host, row, fixture } = await setup();

      const title = getByRole(row('lunch'), 'button', 'Edit Lunch, €12.50');
      expect(title.getAttribute('type')).toBe('button');
      expect(textOf(title)).toBe('Lunch');

      title.click();
      await settle(fixture);
      expect(host.pressed).toEqual(['title']);
    });
  });

  describe('the actions', () => {
    it('keep a single visible action a button, and a menu holds the rest', async () => {
      const { row, host, fixture } = await setup();

      getByRole(row('lunch'), 'button', 'Undo').click();
      await settle(fixture);
      expect(host.pressed).toEqual(['undo']);
      expect(queryByRole(row('lunch'), 'button', /^More actions/)).toBeNull();
      expect(queryAllByRole(row('coffee'), 'button', /^More actions/)).toHaveLength(1);
    });
  });

  describe('actions below the text', () => {
    it('go on a line of their own on a phone, and only for a row that asks for it', async () => {
      const fixture = await render(BelowHost);
      await primeStores(http);
      await settle(fixture);
      const element = fixture.nativeElement as HTMLElement;

      const around = (id: string, name: string) =>
        getByRole(element.querySelector(`#${id}`) as HTMLElement, 'button', name)
          .parentElement as Element;
      expect(around('below', 'Download').classList).toContain('max-sm:basis-full');
      expect(around('beside', 'Undo').classList).not.toContain('max-sm:basis-full');
    });
  });

  describe('the content that is not a part of the row', () => {
    it('goes under the row, the whole width of it', async () => {
      const { row } = await setup();

      const under = Array.from(row('lunch').children).at(-1) as HTMLElement;
      expect(textOf(under)).toBe('Under the line: a bar, a notice.');
      expect(under.classList).toContain('mt-2');
    });

    it('is all there is of a bare row, with no hover', async () => {
      const { row } = await setup();

      const form = row('form');
      expect(getByRole(form, 'textbox', 'New name')).toBeTruthy();
      expect(form.querySelector(':scope > div.flex')).toBeNull();
      expect(form.classList).not.toContain('hover:bg-subtle');
      expect(form.querySelector(':scope > div')?.classList).toContain('first:mt-0');
    });
  });

  describe('compact', () => {
    it('is tighter, with smaller type, for a list among other content', async () => {
      const { fixture, host, row } = await setup();
      expect(row('coffee').classList).toContain('py-3');

      host.density.set('compact');
      await settle(fixture);

      expect(row('coffee').classList).toContain('py-2');
      expect(row('coffee').classList).not.toContain('py-3');
      expect(row('coffee').classList).toContain('min-h-11');
      expect(row('coffee').querySelector('p')?.classList).toContain('text-sm');
    });
  });

  it('has nothing for a screen reader to complain about', async () => {
    const { fixture, host, element } = await setup();
    expect(a11yProblems(element)).toEqual([]);

    host.density.set('compact');
    await settle(fixture);
    expect(a11yProblems(element)).toEqual([]);
  });
});
