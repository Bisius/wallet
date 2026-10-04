import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { a11yProblems } from '../../../testing/a11y';
import { getByRole, textOf } from '../../../testing/dom';
import { render, StubPage } from '../../../testing/harness';
import { SeeAllLink } from './see-all-link';

@Component({
  selector: 'app-see-all-link-host',
  imports: [SeeAllLink],
  template: `
    <app-see-all-link route="/budgets" what="budgets" [queryParams]="{ month: '2026-08' }" />
    <app-see-all-link route="/savings" what="savings" />
  `,
})
class SeeAllLinkHost {}

describe('SeeAllLink', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'budgets', component: StubPage },
          { path: 'savings', component: StubPage },
        ]),
      ],
    });
  });

  async function setup() {
    const fixture = await render(SeeAllLinkHost);
    return fixture.nativeElement as HTMLElement;
  }

  it('says "See all" and is named for where it goes', async () => {
    const element = await setup();

    const link = getByRole(element, 'link', 'See all budgets');
    // Only "See all" is on screen: the rest of the name is for a screen reader.
    expect(textOf(link)).toBe('See all budgets');
    expect(link.querySelector('.sr-only')?.textContent?.trim()).toBe('budgets');
    expect(getByRole(element, 'link', 'See all savings')).toBeTruthy();
  });

  it('is a link to the page, with the query it is given', async () => {
    const element = await setup();

    expect(getByRole(element, 'link', 'See all budgets').getAttribute('href')).toBe(
      '/budgets?month=2026-08',
    );
    expect(getByRole(element, 'link', 'See all savings').getAttribute('href')).toBe('/savings');
  });

  it('looks like a small ghost button, with the arrow hidden from a screen reader', async () => {
    const element = await setup();

    const link = getByRole(element, 'link', 'See all budgets');
    expect(link.classList).toContain('text-accent');
    expect(link.classList).toContain('min-h-9');
    expect(link.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('passes the accessibility checks', async () => {
    expect(a11yProblems(await setup())).toEqual([]);
  });
});
