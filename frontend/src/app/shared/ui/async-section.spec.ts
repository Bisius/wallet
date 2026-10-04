import { HttpErrorResponse } from '@angular/common/http';
import { Component, signal, viewChild } from '@angular/core';
import { a11yProblems } from '../../../testing/a11y';
import { getByRole, queryByRole, textOf } from '../../../testing/dom';
import { apiError, render, settle } from '../../../testing/harness';
import type { LoadState } from '../../core/resource-state';
import { AsyncSection } from './async-section';
import { SectionHelp } from './section';

@Component({
  selector: 'app-async-section-host',
  imports: [AsyncSection, SectionHelp],
  template: `
    <app-async-section
      #section
      heading="Budget progress"
      description="What each budget has left."
      focusable
      [state]="state()"
      [error]="error()"
      loadingLabel="Loading budget progress…"
      errorTitle="Couldn't load budget progress"
      (retry)="retries.set(retries() + 1)"
    >
      <a sectionAction href="/budgets">Open budgets</a>
      <p sectionHelp>Budgets over their limit come first.</p>
      <div sectionToolbar role="group" aria-label="Filter the budgets">
        <button type="button">Only over limit</button>
      </div>
      <p>Groceries: €40.00 left</p>
    </app-async-section>
    <p id="retries">{{ retries() }}</p>
  `,
})
class AsyncSectionHost {
  readonly state = signal<LoadState>('loading');
  readonly error = signal<unknown>(
    new HttpErrorResponse({
      status: 500,
      error: apiError('internal_error', 'The server ran into a problem.'),
    }),
  );
  readonly retries = signal(0);
  readonly section = viewChild.required<AsyncSection>('section');
}

describe('AsyncSection', () => {
  async function setup(state: LoadState = 'ready') {
    const fixture = await render(AsyncSectionHost);
    const element = fixture.nativeElement as HTMLElement;
    const host = fixture.componentInstance;
    const set = async (next: LoadState) => {
      host.state.set(next);
      await settle(fixture);
    };
    await set(state);
    return {
      fixture,
      host,
      element,
      set,
      region: () => getByRole(element, 'region', 'Budget progress'),
    };
  }

  it('says that it is loading, politely and in words, and shows nothing of its content', async () => {
    const { region } = await setup('loading');

    expect(textOf(getByRole(region(), 'status'))).toBe('Loading budget progress…');
    expect(textOf(region())).not.toContain('Groceries');
  });

  it('shows what the API said when loading failed, announced as an alert, and tries again on request', async () => {
    const { fixture, element, region, host } = await setup('error');

    const alert = getByRole(region(), 'alert');
    expect(textOf(alert)).toContain("Couldn't load budget progress");
    expect(textOf(alert)).toContain('The server ran into a problem.');
    expect(textOf(region())).not.toContain('Groceries');

    getByRole(alert, 'button', 'Try again').click();
    await settle(fixture);
    expect(host.retries()).toBe(1);
    expect((element.querySelector('#retries') as HTMLElement).textContent).toBe('1');
  });

  it('shows its content when it is ready', async () => {
    const { region } = await setup('ready');

    expect(textOf(region())).toContain('Groceries: €40.00 left');
    expect(queryByRole(region(), 'status')).toBeNull();
    expect(queryByRole(region(), 'alert')).toBeNull();
  });

  it('keeps its heading, its line and its corner whatever the state', async () => {
    const { region, set } = await setup('loading');

    for (const state of ['loading', 'error', 'ready'] as const) {
      await set(state);
      expect(getByRole(region(), 'heading', 'Budget progress').tagName).toBe('H2');
      expect(textOf(region())).toContain('What each budget has left.');
      expect(getByRole(region(), 'link', 'Open budgets')).toBeTruthy();
    }
  });

  it('keeps its toolbar whatever the state, so a control that was just used does not vanish with the list', async () => {
    const { region, set } = await setup('ready');
    const filter = getByRole(region(), 'button', 'Only over limit');

    for (const state of ['loading', 'error', 'ready'] as const) {
      await set(state);
      expect(getByRole(region(), 'group', 'Filter the budgets')).toBeTruthy();
      // The very same element: it was never taken out of the page.
      expect(getByRole(region(), 'button', 'Only over limit')).toBe(filter);
    }
  });

  it('folds its help behind "How this works" in every state', async () => {
    const { region, set } = await setup('ready');

    const details = region().querySelector('details') as HTMLDetailsElement;
    expect(textOf(details.querySelector('summary') as Element)).toBe('How this works');
    expect(textOf(details)).toContain('Budgets over their limit come first.');

    await set('loading');
    expect(region().querySelectorAll('details').length).toBe(1);
  });

  it('lets code move the keyboard to its heading', async () => {
    const { host, region } = await setup('ready');
    const heading = getByRole(region(), 'heading', 'Budget progress');
    expect(heading.getAttribute('tabindex')).toBe('-1');

    host.section().focusHeading();

    expect(document.activeElement).toBe(heading);
    expect(host.section().headingElement()).toBe(heading);
  });

  it('has nothing for a screen reader to complain about in any state', async () => {
    const { element, set } = await setup('loading');

    for (const state of ['loading', 'error', 'ready'] as const) {
      await set(state);
      expect(a11yProblems(element), state).toEqual([]);
    }
  });
});
