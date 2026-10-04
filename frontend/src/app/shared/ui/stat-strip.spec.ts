import { Component, signal } from '@angular/core';
import { a11yProblems } from '../../../testing/a11y';
import { getByRole, queryByRole, textOf } from '../../../testing/dom';
import { render, settle } from '../../../testing/harness';
import { Badge } from './badge';
import { SectionHelp } from './section';
import { Stat } from './stat';
import { StatGrid } from './stat-grid';
import { StatStrip } from './stat-strip';

@Component({
  selector: 'app-stat-strip-host',
  imports: [Badge, SectionHelp, Stat, StatGrid, StatStrip],
  template: `
    <app-stat-strip heading="October 2026 at a glance" [helpTitle]="helpTitle()">
      <app-badge stripStatus tone="accent">Current month</app-badge>
      <dl appStatGrid>
        <div appStat size="lg" label="Income" [cents]="250000"></div>
        <div appStat label="Fixed costs" [cents]="9863"></div>
      </dl>
      <p id="after">A message about the figures.</p>
      @if (help()) {
        <p sectionHelp>This month is still running.</p>
      }
    </app-stat-strip>
    <app-stat-strip heading="Another strip"><p>Nothing.</p></app-stat-strip>
  `,
})
class StatStripHost {
  readonly help = signal(false);
  readonly helpTitle = signal('How this works');
}

describe('StatStrip', () => {
  async function setup() {
    const fixture = await render(StatStripHost);
    const element = fixture.nativeElement as HTMLElement;
    const host = fixture.componentInstance;
    return {
      fixture,
      host,
      element,
      region: () => getByRole(element, 'region', 'October 2026 at a glance'),
      set: async (change: () => void) => {
        change();
        await settle(fixture);
      },
    };
  }

  it('is a region named by its heading, an h2', async () => {
    const { region } = await setup();

    expect(getByRole(region(), 'heading', 'October 2026 at a glance').tagName).toBe('H2');
  });

  it('puts the status in the heading row, and the figures under it', async () => {
    const { region } = await setup();

    const header = region().querySelector('header') as HTMLElement;
    expect(textOf(header)).toBe('October 2026 at a glance Current month');
    expect(textOf(region())).toContain('Income €2,500.00');
    expect(textOf(region())).toContain('Fixed costs €98.63');
    // The figures come after the heading, then what is said about them.
    const order = Array.from(region().querySelectorAll('header, dl, #after')).map(
      (node) => node.tagName,
    );
    expect(order).toEqual(['HEADER', 'DL', 'P']);
  });

  it('is flat: no card around the figures, so the tiles are the only surfaces', async () => {
    const { region } = await setup();

    expect(region().classList).not.toContain('card');
    expect(region().parentElement?.classList).not.toContain('card');
  });

  it('has no help unless it is given some, and then folds it behind "How this works" under the figures', async () => {
    const { element, host, region, set } = await setup();
    expect(region().querySelector('details')).toBeNull();

    await set(() => host.help.set(true));

    const details = region().querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(textOf(details.querySelector('summary') as Element)).toBe('How this works');
    expect(textOf(details)).toContain('This month is still running.');
    expect(
      Boolean(
        region().querySelector('dl')!.compareDocumentPosition(details) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(queryByRole(element, 'region', 'Another strip')?.querySelector('details')).toBeNull();
  });

  it('can name the disclosure of its help otherwise', async () => {
    const { host, region, set } = await setup();

    await set(() => {
      host.help.set(true);
      host.helpTitle.set('What the figures mean');
    });

    expect(textOf(region().querySelector('summary') as Element)).toBe('What the figures mean');
  });

  it('gives every strip a heading of its own to name it', async () => {
    const { element } = await setup();

    const ids = Array.from(element.querySelectorAll('h2')).map((heading) => heading.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id !== '')).toBe(true);
  });

  it('passes the accessibility checks, with and without help', async () => {
    const { element, host, set } = await setup();
    expect(a11yProblems(element)).toEqual([]);

    await set(() => host.help.set(true));
    expect(a11yProblems(element)).toEqual([]);
  });
});
