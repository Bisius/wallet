import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { getByRole, textOf } from '../../../testing/dom';
import { render } from '../../../testing/harness';
import { YearSwitcher } from './year-switcher';

@Component({
  selector: 'app-switcher-host',
  imports: [YearSwitcher],
  template: `<app-year-switcher
    [year]="year()"
    [min]="min()"
    [max]="max()"
    [current]="2026"
    (yearChange)="changes.push($event)"
  />`,
})
class Host {
  readonly year = signal(2026);
  readonly min = signal(2025);
  readonly max = signal(2036);
  readonly changes: number[] = [];
}

describe('YearSwitcher', () => {
  async function setup(year = 2026) {
    const fixture = await render(Host);
    fixture.componentInstance.year.set(year);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const button = (name: string | RegExp) => getByRole(element, 'button', name);
    return { fixture, element, button, changes: fixture.componentInstance.changes };
  }

  it('is a labelled group showing the year, with buttons that say where they go', async () => {
    const { element, button } = await setup();

    expect(textOf(getByRole(element, 'group', 'Year'))).toContain('2026');
    expect(element.querySelector('[aria-live="polite"]')?.textContent).toContain('2026');
    expect(button('Previous year, 2025')).toBeTruthy();
    expect(button('Next year, 2027')).toBeTruthy();
    expect(button('Go to this year, 2026')).toBeTruthy();
  });

  it('asks for the previous and the next year', async () => {
    const { button, changes } = await setup();

    button('Previous year, 2025').click();
    button('Next year, 2027').click();

    expect(changes).toEqual([2025, 2027]);
  });

  it('goes back to this year from another one, and does nothing on this year', async () => {
    const { button, changes } = await setup(2030);
    button('Go to this year, 2026').click();
    expect(changes).toEqual([2026]);

    TestBed.resetTestingModule();
    const again = await setup(2026);
    again.button('Go to this year, 2026').click();
    expect(again.changes).toEqual([]);
    expect(again.button('Go to this year, 2026').getAttribute('aria-disabled')).toBe('true');
  });

  it('says a button is not available at the edge of the range, keeps it focusable and ignores it', async () => {
    const first = await setup(2025);
    const previous = first.button('Previous year, not available');
    expect(previous.getAttribute('aria-disabled')).toBe('true');
    expect(previous.hasAttribute('disabled')).toBe(false);
    previous.click();
    expect(first.changes).toEqual([]);

    TestBed.resetTestingModule();
    const last = await setup(2036);
    last.button('Next year, not available').click();
    expect(last.changes).toEqual([]);
  });
});
