import { Component, signal } from '@angular/core';
import { a11yProblems } from '../../../testing/a11y';
import { textOf } from '../../../testing/dom';
import { render, settle } from '../../../testing/harness';
import { Disclosure, type DisclosureSize } from './disclosure';

@Component({
  selector: 'app-disclosure-host',
  imports: [Disclosure],
  template: `
    <app-disclosure [size]="size()" summary="Amount history (3)" [(open)]="open">
      <span class="sr-only" disclosureSummary> for Groceries</span>
      <p>From June 2026: €300.00</p>
    </app-disclosure>
  `,
})
class DisclosureHost {
  readonly size = signal<DisclosureSize>('inline');
  readonly open = signal(false);
}

describe('Disclosure', () => {
  async function setup() {
    const fixture = await render(DisclosureHost);
    const element = fixture.nativeElement as HTMLElement;
    const details = () => element.querySelector('details') as HTMLDetailsElement;
    const summary = () => element.querySelector('summary') as HTMLElement;
    return { fixture, host: fixture.componentInstance, element, details, summary };
  }

  it('is a native details: folded until it is asked for, with its summary in words', async () => {
    const { details, summary } = await setup();

    expect(details().open).toBe(false);
    expect(textOf(summary())).toBe('Amount history (3) for Groceries');
  });

  it('keeps what is inside it in the page for find-in-page and for the keyboard of the browser', async () => {
    const { details } = await setup();
    expect(textOf(details())).toContain('From June 2026: €300.00');
  });

  it('tells its owner when it is opened and closed by the person', async () => {
    const { fixture, host, details } = await setup();

    details().open = true;
    details().dispatchEvent(new Event('toggle'));
    await settle(fixture);
    expect(host.open()).toBe(true);

    details().open = false;
    details().dispatchEvent(new Event('toggle'));
    await settle(fixture);
    expect(host.open()).toBe(false);
  });

  it('opens and folds when its owner says so', async () => {
    const { fixture, host, details } = await setup();

    host.open.set(true);
    await settle(fixture);
    expect(details().open).toBe(true);

    host.open.set(false);
    await settle(fixture);
    expect(details().open).toBe(false);
  });

  it('replaces the triangle of the browser with a chevron that is only decoration', async () => {
    const { summary } = await setup();

    expect(summary().classList).toContain('list-none');
    const chevron = summary().querySelector('svg');
    expect(chevron).not.toBeNull();
    expect(chevron?.getAttribute('aria-hidden')).toBe('true');
  });

  it('turns the chevron when it opens, and only animates that for people who accept motion', async () => {
    const { summary } = await setup();

    const chevron = summary().querySelector('app-icon') as HTMLElement;
    expect(chevron.classList).toContain('group-open:rotate-180');
    expect(chevron.classList).toContain('motion-safe:transition-transform');
  });

  it('is a link-sized summary inline, and a 44 px one as a section', async () => {
    const { fixture, host, summary } = await setup();
    expect(summary().classList).not.toContain('min-h-11');
    expect(summary().classList).toContain('text-accent-text');

    host.size.set('section');
    await settle(fixture);

    expect(summary().classList).toContain('min-h-11');
    expect(summary().classList).toContain('text-section-title');
  });

  it('can be reached and operated with the keyboard: the summary is what takes focus', async () => {
    const { summary } = await setup();

    summary().focus();
    expect(document.activeElement).toBe(summary());
  });

  it('has nothing for a screen reader to complain about', async () => {
    const { element, host, fixture } = await setup();
    expect(a11yProblems(element)).toEqual([]);

    host.size.set('section');
    host.open.set(true);
    await settle(fixture);
    expect(a11yProblems(element)).toEqual([]);
  });
});
