import { Component, signal } from '@angular/core';
import { a11yProblems } from '../../../testing/a11y';
import { getByRole, queryAllByRole, textOf } from '../../../testing/dom';
import { render, settle } from '../../../testing/harness';
import { menuItemNames, rowAction } from '../../../testing/menu';
import { ActionMenu, MenuItem } from './action-menu';
import { Badge } from './badge';
import { Button } from './button';
import { EntityCard } from './entity-card';
import { Icon } from './icon';
import { ProgressBar } from './progress-bar';
import { Stat } from './stat';

const LONG_NAME = 'Holiday-fund-for-the-whole-family-in-the-summer-of-twenty-twenty-seven';

@Component({
  selector: 'app-entity-card-host',
  imports: [ActionMenu, Badge, Button, EntityCard, Icon, MenuItem, ProgressBar, Stat],
  template: `
    <article id="groceries" appEntityCard heading="Groceries" color="#3b82f6" icon="🛒">
      <ng-container entityBadges>
        @if (incremental()) {
          <app-badge>Incremental</app-badge>
        }
        <app-badge tone="accent">Starts Nov 2026</app-badge>
      </ng-container>

      <div appStat label="Available" [cents]="30000"></div>
      <div appStat label="Spent" [cents]="12050"></div>
      @if (showRemaining()) {
        <div appStat label="Remaining" [cents]="-500"></div>
      }

      <app-progress-bar label="Groceries usage" [percent]="40" />
      <p class="text-muted">Carried in from September.</p>

      <ng-container entityActions>
        @if (editable()) {
          <button appButton variant="secondary" size="sm" aria-label="Edit Groceries">Edit</button>
          <button appButton variant="secondary" size="sm">Move money</button>
        }
        <app-action-menu label="More actions for Groceries">
          <button appMenuItem (click)="pressed.push('archive')">
            <app-icon name="archive" />
            Archive
          </button>
          <button appMenuItem destructive (click)="pressed.push('delete')">
            <app-icon name="trash" />
            Delete
          </button>
        </app-action-menu>
      </ng-container>
    </article>

    <article id="rent" appEntityCard heading="Rent" [color]="null">
      <p>Nothing to do here.</p>
    </article>

    <article id="plain" appEntityCard heading="Savings" [statColumns]="2"></article>

    <article id="long" appEntityCard [heading]="longName" color="#10b981"></article>
  `,
})
class EntityCardHost {
  readonly incremental = signal(true);
  readonly showRemaining = signal(true);
  readonly editable = signal(true);
  readonly longName = LONG_NAME;
  readonly pressed: string[] = [];
}

describe('EntityCard', () => {
  async function setup() {
    const fixture = await render(EntityCardHost);
    const element = fixture.nativeElement as HTMLElement;
    const card = (id: string) => element.querySelector<HTMLElement>(`#${id}`)!;
    return {
      fixture,
      host: fixture.componentInstance,
      element,
      card,
      groceries: card('groceries'),
    };
  }

  describe('the title', () => {
    it('is an h3 that names the card', async () => {
      const { element, groceries } = await setup();
      const heading = getByRole(groceries, 'heading', 'Groceries');
      expect(heading.tagName).toBe('H3');
      expect(getByRole(element, 'article', 'Groceries')).toBe(groceries);
      expect(getByRole(element, 'article', 'Rent').tagName).toBe('ARTICLE');
    });

    it('wraps a long name, even one with nothing to break at, instead of widening the page', async () => {
      const { card } = await setup();
      const heading = getByRole(card('long'), 'heading', LONG_NAME);
      expect(heading.classList).toContain('break-words');
      expect(heading.parentElement?.classList).toContain('min-w-0');
    });
  });

  describe('the colour marker', () => {
    it('is a dot of the colour beside the title, for the eye only', async () => {
      const { card } = await setup();
      const dot = card('long').querySelector<HTMLElement>('span[appColorDot]')!;
      expect(dot.style.backgroundColor).toBe('rgb(16, 185, 129)');
      expect(dot.getAttribute('aria-hidden')).toBe('true');
      expect(dot.classList).toContain('rounded-full');
      // The name beside it says what the card is: the colour is not read out.
      expect(textOf(card('long'))).toBe(LONG_NAME);
    });

    it('is a neutral dot for a thing with no colour, and nothing when it is not asked for', async () => {
      const { card } = await setup();
      const neutral = card('rent').querySelector<HTMLElement>('span[appColorDot]')!;
      expect(neutral.style.backgroundColor).toBe('');
      expect(card('plain').querySelector('span[appColorDot]')).toBeNull();
    });

    it('is an avatar with the emoji, ringed in the colour, in place of the dot', async () => {
      const { groceries } = await setup();
      expect(groceries.querySelector('span[appColorDot]')).toBeNull();
      const avatar = groceries.querySelector<HTMLElement>('header > span')!;
      expect(avatar.textContent?.trim()).toBe('🛒');
      expect(avatar.getAttribute('aria-hidden')).toBe('true');
      expect(avatar.classList).toContain('font-emoji');
      expect(avatar.style.borderColor).toBe('rgb(59, 130, 246)');
      expect(textOf(groceries)).not.toContain('🛒');
    });
  });

  describe('the badges', () => {
    it('are the state in words, beside each other', async () => {
      const { groceries } = await setup();
      expect(
        Array.from(groceries.querySelectorAll('app-badge')).map((badge) => textOf(badge)),
      ).toEqual(['Incremental', 'Starts Nov 2026']);
    });

    it('leave no empty row behind when there are none', async () => {
      const { card, host, fixture } = await setup();
      const row = card('rent').querySelector('header .flex-wrap') as HTMLElement;
      expect(row.matches(':empty')).toBe(true);
      expect(row.classList).toContain('empty:hidden');

      host.incremental.set(false);
      await settle(fixture);
      expect(
        Array.from(card('groceries').querySelectorAll('app-badge')).map((badge) => textOf(badge)),
      ).toEqual(['Starts Nov 2026']);
    });
  });

  describe('the stats', () => {
    it('are the figures of a description list, each with its label', async () => {
      const { groceries } = await setup();
      const list = groceries.querySelector('dl')!;
      expect(Array.from(list.children).map((stat) => textOf(stat))).toEqual([
        'Available €300.00',
        'Spent €120.50',
        'Remaining -€5.00',
      ]);
      expect(Array.from(list.children).every((stat) => stat.tagName === 'DIV')).toBe(true);
    });

    it('sit flat on the card: no tile inside a card', async () => {
      const { groceries } = await setup();
      for (const stat of Array.from(groceries.querySelectorAll('[appStat]'))) {
        expect(stat.classList).not.toContain('bg-subtle');
        expect(stat.classList).not.toContain('rounded-control');
      }
    });

    it('follow a figure that comes and goes', async () => {
      const { groceries, host, fixture } = await setup();
      host.showRemaining.set(false);
      await settle(fixture);
      expect(groceries.querySelectorAll('dl > div')).toHaveLength(2);
    });

    it('are left out, with their list, when there are none', async () => {
      const { card } = await setup();
      const list = card('rent').querySelector('dl')!;
      expect(list.matches(':empty')).toBe(true);
      expect(list.classList).toContain('empty:hidden');
    });
  });

  describe('the body', () => {
    it('is what else goes inside, in small type', async () => {
      const { groceries } = await setup();
      const body = groceries.querySelector('[role="progressbar"]')!.closest('div.space-y-3')!;
      expect(body.classList).toContain('text-sm');
      expect(textOf(body)).toContain('Carried in from September.');
    });
  });

  describe('the footer', () => {
    it('has the two visible actions and, after them, the menu', async () => {
      const { groceries } = await setup();
      const footer = groceries.querySelector('footer')!;
      expect(
        // The items of the menu are in the footer too, hidden until it opens.
        queryAllByRole(footer, 'button')
          .filter((button) => !button.hasAttribute('appMenuItem'))
          .map((button) => button.getAttribute('aria-label') ?? textOf(button)),
      ).toEqual(['Edit Groceries', 'Move money', 'More actions for Groceries']);
      expect(footer.lastElementChild?.tagName).toBe('APP-ACTION-MENU');
      expect(footer.classList).toContain('mt-auto');
    });

    it('follows actions that come and go, with several controls in one condition', async () => {
      const { groceries, host, fixture } = await setup();
      host.editable.set(false);
      await settle(fixture);
      const footer = groceries.querySelector('footer')!;
      expect(Array.from(footer.children).map((child) => child.tagName)).toEqual([
        'APP-ACTION-MENU',
      ]);
      // They are not left in the body, where an unmatched block of several roots would end up.
      expect(textOf(groceries)).not.toContain('Move money');
    });

    it('is not a box of its own: no rule between it and the body', async () => {
      const { groceries } = await setup();
      const footer = groceries.querySelector('footer')!;
      expect(footer.className).not.toMatch(/border/);
    });

    it('keeps the destructive action in the menu, last, and the others before it', async () => {
      const { groceries } = await setup();
      expect(menuItemNames(groceries)).toEqual(['Archive', 'Delete']);
      const items = groceries.querySelectorAll<HTMLElement>('[appMenuItem]');
      expect(items[items.length - 1].classList).toContain('text-negative');
    });

    it('does what a menu item says', async () => {
      const { groceries, host } = await setup();
      await rowAction(groceries, 'Delete');
      expect(host.pressed).toEqual(['delete']);
    });

    it('is left out when a card has no actions', async () => {
      const { card } = await setup();
      const footer = card('rent').querySelector('footer')!;
      expect(footer.matches(':empty')).toBe(true);
      expect(footer.classList).toContain('empty:hidden');
    });
  });

  it('is a card with a soft surface, and the cards of a row are as tall as the tallest', async () => {
    const { groceries } = await setup();
    expect(groceries.classList).toContain('card');
    expect(groceries.classList).toContain('h-full');
    expect(groceries.classList).toContain('flex-col');
  });

  it('has nothing for a screen reader to complain about', async () => {
    const { element } = await setup();
    expect(a11yProblems(element)).toEqual([]);
  });
});
