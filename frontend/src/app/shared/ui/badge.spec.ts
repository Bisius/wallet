import { Component } from '@angular/core';
import { a11yProblems } from '../../../testing/a11y';
import { textOf } from '../../../testing/dom';
import { render } from '../../../testing/harness';
import { Badge } from './badge';

@Component({
  selector: 'app-badge-host',
  imports: [Badge],
  template: `
    <app-badge>Monthly</app-badge>
    <app-badge tone="accent">Upcoming</app-badge>
    <app-badge tone="positive">Active</app-badge>
    <app-badge tone="warning" icon="alert">Overdue</app-badge>
    <app-badge tone="negative" icon="ban">Refused by the server: the date is missing</app-badge>
  `,
})
class BadgeHost {}

describe('Badge', () => {
  async function setup() {
    const fixture = await render(BadgeHost);
    const element = fixture.nativeElement as HTMLElement;
    return { element, badges: Array.from(element.querySelectorAll<HTMLElement>('app-badge')) };
  }

  it('says its state in words, whatever its tone', async () => {
    const { badges } = await setup();
    expect(badges.map((badge) => textOf(badge))).toEqual([
      'Monthly',
      'Upcoming',
      'Active',
      'Overdue',
      'Refused by the server: the date is missing',
    ]);
  });

  it('has a tone that says how to take the words: neutral unless told otherwise', async () => {
    const { badges } = await setup();
    const tone = (badge: HTMLElement) =>
      [...badge.classList].find((name) => name.startsWith('bg-'));

    expect(badges.map(tone)).toEqual([
      'bg-subtle',
      'bg-accent-soft',
      'bg-positive-soft',
      'bg-warning-soft',
      'bg-negative-soft',
    ]);
  });

  it('puts the text on its own soft background in the color of the tone, in both themes', async () => {
    const { badges } = await setup();
    expect(badges[1].classList).toContain('text-accent-text');
    expect(badges[2].classList).toContain('text-positive');
    expect(badges[3].classList).toContain('text-warning');
    expect(badges[4].classList).toContain('text-negative');
  });

  it('shows an icon beside the words only when asked, and hides it from assistive technology', async () => {
    const { badges } = await setup();

    expect(badges[0].querySelector('svg')).toBeNull();
    const icon = badges[3].querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(textOf(badges[3])).toBe('Overdue');
  });

  it('wraps long text inside the pill instead of widening the page', async () => {
    const { badges } = await setup();
    expect(badges[4].classList).toContain('max-w-full');
    expect(badges[4].querySelector('span')?.classList).toContain('min-w-0');
  });

  it('has nothing for a screen reader to complain about', async () => {
    const { element } = await setup();
    expect(a11yProblems(element)).toEqual([]);
  });
});
