import { Component, signal } from '@angular/core';
import { a11yProblems } from '../../../testing/a11y';
import { getByRole, textOf } from '../../../testing/dom';
import { render, settle } from '../../../testing/harness';
import { AppPage, type PageWidth } from './page';
import { PageHeader } from './page-header';

@Component({
  selector: 'app-page-host',
  imports: [AppPage, PageHeader],
  template: `
    <app-page [width]="width()">
      <app-page-header title="Budgets" [subtitle]="subtitle()">
        <button type="button">New budget</button>
      </app-page-header>
      <p>First block</p>
      <p>Second block</p>
    </app-page>
  `,
})
class PageHost {
  readonly width = signal<PageWidth>('wide');
  readonly subtitle = signal<string | undefined>('Monthly allocations.');
}

describe('AppPage and PageHeader', () => {
  async function setup() {
    const fixture = await render(PageHost);
    const element = fixture.nativeElement as HTMLElement;
    return {
      fixture,
      host: fixture.componentInstance,
      element,
      page: () => element.querySelector('app-page') as HTMLElement,
    };
  }

  it('holds what is put in it, in order, and nothing else', async () => {
    const { page } = await setup();

    const children = Array.from(page().children).map((child) => textOf(child));
    expect(children).toEqual([
      'Budgets Monthly allocations. New budget',
      'First block',
      'Second block',
    ]);
  });

  it('is centered, and spaces its blocks by one rhythm', async () => {
    const { page } = await setup();

    expect(page().classList).toContain('mx-auto');
    expect(page().classList).toContain('flex-col');
    expect(page().classList).toContain('gap-6');
  });

  it('is wide (72rem) or narrow (48rem), and follows when the width changes', async () => {
    const { fixture, host, page } = await setup();
    expect(page().classList).toContain('max-w-6xl');
    expect(page().classList).not.toContain('max-w-3xl');

    host.width.set('narrow');
    await settle(fixture);

    expect(page().classList).toContain('max-w-3xl');
    expect(page().classList).not.toContain('max-w-6xl');
  });

  it('has a title that code can focus after a navigation, a subtitle and actions', async () => {
    const { element } = await setup();

    const title = getByRole(element, 'heading', 'Budgets');
    expect(title.tagName).toBe('H1');
    expect(title.getAttribute('tabindex')).toBe('-1');
    title.focus();
    expect(document.activeElement).toBe(title);
    expect(textOf(element.querySelector('header') as Element)).toContain('Monthly allocations.');
    expect(
      getByRole(element.querySelector('header') as HTMLElement, 'button', 'New budget'),
    ).toBeTruthy();
  });

  it('leaves out the subtitle and the room for actions when there are none', async () => {
    const { fixture, host, element } = await setup();
    host.subtitle.set(undefined);
    await settle(fixture);

    expect(element.querySelector('header p')).toBeNull();
  });

  it('has nothing for a screen reader to complain about', async () => {
    const { element } = await setup();
    expect(a11yProblems(element)).toEqual([]);
  });
});
