import { Component, signal } from '@angular/core';
import { a11yProblems } from '../../../testing/a11y';
import { getByRole, textOf } from '../../../testing/dom';
import { render, settle } from '../../../testing/harness';
import { PeriodSwitcher } from './period-switcher';

@Component({
  selector: 'app-period-switcher-host',
  imports: [PeriodSwitcher],
  template: `
    <app-period-switcher
      label="Month"
      text="Oct 2026"
      [spokenText]="spoken()"
      previousLabel="Previous month, September 2026"
      nextLabel="Next month, November 2026"
      currentLabel="Go to this month, October 2026"
      currentText="This month"
      [canGoPrevious]="canGoPrevious()"
      [canGoNext]="canGoNext()"
      [isCurrent]="isCurrent()"
      (goPrevious)="events.push('previous')"
      (goNext)="events.push('next')"
      (goCurrent)="events.push('current')"
    />
  `,
})
class PeriodSwitcherHost {
  readonly spoken = signal<string | undefined>('October 2026');
  readonly canGoPrevious = signal(true);
  readonly canGoNext = signal(true);
  readonly isCurrent = signal(false);
  readonly events: string[] = [];
}

describe('PeriodSwitcher', () => {
  async function setup() {
    const fixture = await render(PeriodSwitcherHost);
    const element = fixture.nativeElement as HTMLElement;
    const host = fixture.componentInstance;
    const button = (name: string | RegExp) => getByRole(element, 'button', name);
    return { fixture, host, element, button };
  }

  it('is a group named for what it switches, with the period in view', async () => {
    const { element } = await setup();

    const group = getByRole(element, 'group', 'Month');
    expect(textOf(group)).toContain('October 2026');
  });

  it('reads the period aloud in full when the text on screen is shortened', async () => {
    const { fixture, host, element } = await setup();
    const live = element.querySelector('[aria-live="polite"]') as HTMLElement;

    expect(live.querySelector('[aria-hidden="true"]')?.textContent).toBe('Oct 2026');
    expect(live.querySelector('.sr-only')?.textContent).toBe('October 2026');

    host.spoken.set(undefined);
    await settle(fixture);
    expect(textOf(live)).toBe('Oct 2026');
    expect(live.querySelector('.sr-only')).toBeNull();
  });

  it('announces a change of period politely', async () => {
    const { element } = await setup();

    expect(element.querySelector('p')?.getAttribute('aria-live')).toBe('polite');
  });

  it('names each button for where it goes', async () => {
    const { button } = await setup();

    expect(button('Previous month, September 2026')).toBeTruthy();
    expect(button('Next month, November 2026')).toBeTruthy();
    expect(button('Go to this month, October 2026')).toBeTruthy();
    expect(textOf(button('Go to this month, October 2026'))).toBe('This month');
  });

  it('shows the jump back as a calendar icon on a phone, still named in full', async () => {
    const { button } = await setup();

    const current = button('Go to this month, October 2026');
    expect(current.querySelector('app-icon.sm\\:hidden svg')).not.toBeNull();
    expect(current.querySelector('span.max-sm\\:hidden')?.textContent).toBe('This month');
    expect(current.getAttribute('aria-label')).toBe('Go to this month, October 2026');
  });

  it('asks for the previous, the next and the current period', async () => {
    const { host, button } = await setup();

    button(/Previous month/).click();
    button(/Next month/).click();
    button(/Go to this month/).click();

    expect(host.events).toEqual(['previous', 'next', 'current']);
  });

  it('does nothing at the edge of the range, but stays a focusable button so the keyboard keeps its place', async () => {
    const { fixture, host, button } = await setup();
    host.canGoPrevious.set(false);
    host.canGoNext.set(false);
    host.isCurrent.set(true);
    await settle(fixture);

    for (const name of [/Previous month/, /Next month/, /Go to this month/]) {
      expect(button(name).getAttribute('aria-disabled')).toBe('true');
      expect((button(name) as HTMLButtonElement).disabled).toBe(false);
      button(name).click();
    }

    expect(host.events).toEqual([]);
  });

  it('is marked available, not disabled, while there is somewhere to go', async () => {
    const { button } = await setup();

    expect(button(/Previous month/).getAttribute('aria-disabled')).toBe('false');
    expect(button(/Go to this month/).getAttribute('aria-disabled')).toBe('false');
  });

  describe('the buttons', () => {
    it('are the small secondary button of the app', async () => {
      const { button } = await setup();

      for (const name of [/Previous month/, /Next month/, /Go to this month/]) {
        expect(button(name).classList).toContain('min-h-9');
        expect(button(name).classList).toContain('border-line-strong');
        expect(button(name).classList).toContain('bg-surface');
      }
    });

    it('are 44 px targets on a phone, though the small size is 36 px', async () => {
      const { button } = await setup();

      for (const name of [/Previous month/, /Next month/, /Go to this month/]) {
        expect(button(name).classList).toContain('max-sm:min-h-11');
        expect(button(name).classList).toContain('max-sm:min-w-11');
      }
    });

    it('look unavailable at the edge of the range without hiding behind the disabled opacity of a disabled button', async () => {
      const { button } = await setup();

      expect(button(/Previous month/).classList).toContain('aria-disabled:opacity-60');
      expect(button(/Previous month/).classList).toContain('aria-disabled:cursor-not-allowed');
    });

    it('show an icon for previous and next that is only decoration', async () => {
      const { button } = await setup();

      for (const name of [/Previous month/, /Next month/]) {
        expect(button(name).querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      }
    });
  });

  it('has nothing for a screen reader to complain about', async () => {
    const { element } = await setup();
    expect(a11yProblems(element)).toEqual([]);
  });
});
