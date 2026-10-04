import { Component, signal, viewChild } from '@angular/core';
import { a11yProblems } from '../../../testing/a11y';
import { getByRole, queryByRole, textOf } from '../../../testing/dom';
import { render, settle } from '../../../testing/harness';
import { AppSection, SectionHelp, type SectionVariant } from './section';

@Component({
  selector: 'app-section-host',
  imports: [AppSection, SectionHelp],
  template: `
    <app-section
      #main
      heading="Goals"
      [description]="description()"
      [level]="level()"
      [variant]="variant()"
      [focusable]="focusable()"
      [landmark]="landmark()"
    >
      <button sectionAction type="button">New goal</button>
      @if (help()) {
        <p sectionHelp>A goal has a target amount.</p>
      }
      <p>The goals.</p>
    </app-section>
    <app-section heading="Archived goals"><p>None.</p></app-section>
  `,
})
class SectionHost {
  readonly description = signal<string | undefined>('Things you are saving for.');
  readonly level = signal<2 | 3>(2);
  readonly variant = signal<SectionVariant | undefined>(undefined);
  readonly focusable = signal(false);
  readonly landmark = signal<boolean | undefined>(undefined);
  readonly help = signal(false);
  readonly main = viewChild.required<AppSection>('main');
}

describe('AppSection', () => {
  async function setup() {
    const fixture = await render(SectionHost);
    const element = fixture.nativeElement as HTMLElement;
    const host = fixture.componentInstance;
    return {
      fixture,
      host,
      element,
      section: () => element.querySelector('section') as HTMLElement,
      set: async (change: () => void) => {
        change();
        await settle(fixture);
      },
    };
  }

  it('is a region named by its heading, a level 2 heading by default', async () => {
    const { element } = await setup();

    const region = getByRole(element, 'region', 'Goals');
    expect(getByRole(region, 'heading', 'Goals').tagName).toBe('H2');
    expect(textOf(region)).toContain('The goals.');
  });

  it('gives every section a heading of its own to name it', async () => {
    const { element } = await setup();

    expect(getByRole(element, 'region', 'Archived goals')).toBeTruthy();
    const ids = Array.from(element.querySelectorAll('h2')).map((heading) => heading.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('says in one line what it shows, under the heading', async () => {
    const { element, host, set } = await setup();
    expect(textOf(getByRole(element, 'region', 'Goals'))).toContain('Things you are saving for.');

    await set(() => host.description.set(undefined));
    expect(textOf(getByRole(element, 'region', 'Goals'))).not.toContain('saving for');
  });

  it('has room in its corner for an action, which works', async () => {
    const { element } = await setup();

    const header = getByRole(element, 'region', 'Goals').querySelector('header') as HTMLElement;
    expect(getByRole(header, 'button', 'New goal')).toBeTruthy();
    expect(header.querySelector('h2')).not.toBeNull();
  });

  it('is a card, or only spacing; a block inside a card is only spacing', async () => {
    const { host, set, section } = await setup();
    expect(section().classList).toContain('card');

    await set(() => host.variant.set('plain'));
    expect(section().classList).not.toContain('card');

    await set(() => {
      host.variant.set(undefined);
      host.level.set(3);
    });
    expect(section().classList).not.toContain('card');
  });

  it('is a heading of level 3 inside another block, and then not a region of its own', async () => {
    const { element, host, set } = await setup();
    await set(() => host.level.set(3));

    expect(getByRole(element, 'heading', 'Goals').tagName).toBe('H3');
    expect(queryByRole(element, 'region', 'Goals')).toBeNull();
  });

  it('can be a region at level 3 when it is asked to', async () => {
    const { element, host, set } = await setup();
    await set(() => {
      host.level.set(3);
      host.landmark.set(true);
    });

    expect(getByRole(element, 'region', 'Goals')).toBeTruthy();
  });

  it('has no help unless it is given some, and then folds it behind "How this works"', async () => {
    const { element, host, set } = await setup();
    expect(queryByRole(getByRole(element, 'region', 'Goals'), 'group')).toBeNull();
    expect(element.querySelector('details')).toBeNull();

    await set(() => host.help.set(true));

    const details = element.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(textOf(details.querySelector('summary') as Element)).toBe('How this works');
    expect(textOf(details)).toContain('A goal has a target amount.');
  });

  it('lets code move the keyboard to the heading, only when it is focusable', async () => {
    const { element, host, set } = await setup();
    const heading = getByRole(element, 'heading', 'Goals');
    expect(heading.hasAttribute('tabindex')).toBe(false);

    await set(() => host.focusable.set(true));
    expect(heading.getAttribute('tabindex')).toBe('-1');

    host.main().focusHeading();
    expect(document.activeElement).toBe(heading);
  });

  it('has nothing for a screen reader to complain about', async () => {
    const { element, host, set } = await setup();
    await set(() => host.help.set(true));
    expect(a11yProblems(element)).toEqual([]);

    await set(() => host.level.set(3));
    expect(a11yProblems(element)).toEqual([]);
  });
});
