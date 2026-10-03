import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { MonthBudgetLine } from '@wallet/shared';
import { getByRole, queryByRole, textOf } from '../../../testing/dom';
import { budgetLine } from '../../../testing/fixtures';
import { primeStores, render, settle } from '../../../testing/harness';
import { BudgetUsage } from './budget-usage';

@Component({
  selector: 'app-budget-usage-host',
  imports: [BudgetUsage],
  template: `<app-budget-usage [line]="line()" />`,
})
class Host {
  readonly line = signal<MonthBudgetLine>(budgetLine());
}

describe('BudgetUsage', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open(line: Partial<MonthBudgetLine>) {
    await primeStores(http);
    const fixture = await render(Host);
    fixture.componentInstance.line.set(budgetLine(line));
    await settle(fixture);
    const element = fixture.nativeElement as HTMLElement;
    return {
      element,
      text: () => textOf(element),
      bar: () => getByRole(element, 'progressbar', 'Groceries usage'),
      fill: () => getByRole(element, 'progressbar', 'Groceries usage').querySelector('div'),
      icon: () => element.querySelector('app-icon svg path')?.getAttribute('d'),
      words: () => element.querySelector('p span') as HTMLElement,
    };
  }

  // The state is the API's `alert`: each one is a bar color, a word, an icon and a text color.
  it.each([
    {
      name: 'on track',
      line: { alert: 'ok', usagePercent: 25 },
      says: 'On track 25% used, warns at 80%',
      valueText: '25% used, on track',
      fill: 'bg-accent',
      color: 'text-positive',
    },
    {
      name: 'in warning',
      line: { alert: 'warning', usagePercent: 85, spent: 34000, remaining: 6000 },
      says: 'Warning 85% used, warns at 80%',
      valueText: '85% used, warning',
      fill: 'bg-warning',
      color: 'text-warning',
    },
    {
      name: 'over budget',
      line: { alert: 'over', usagePercent: 175, spent: 70000, remaining: -30000 },
      says: 'Over budget by €300.00 · 175% used',
      valueText: '175% used, over budget',
      fill: 'bg-negative',
      color: 'text-negative',
    },
  ] as const)('shows a budget that is $name in words, color and icon', async (c) => {
    const u = await open(c.line);

    expect(u.text()).toContain(c.says);
    expect(u.bar().getAttribute('aria-valuetext')).toBe(c.valueText);
    expect(u.fill()?.className).toContain(c.fill);
    expect(u.words().className).toContain(c.color);
    expect(u.icon()).toBeTruthy();
  });

  it('uses another icon for a state that needs attention than for one that is fine', async () => {
    await primeStores(http);
    const fixture = await render(Host);
    const icon = () =>
      (fixture.nativeElement as HTMLElement).querySelector('app-icon svg path')?.getAttribute('d');

    fixture.componentInstance.line.set(budgetLine({ alert: 'ok' }));
    await settle(fixture);
    const fine = icon();
    fixture.componentInstance.line.set(budgetLine({ alert: 'over', remaining: -100 }));
    await settle(fixture);

    expect(fine).toBeTruthy();
    expect(icon()).toBeTruthy();
    expect(icon()).not.toBe(fine);
  });

  it('draws the bar full, and no more, for a budget that is more than used up', async () => {
    const u = await open({ alert: 'over', usagePercent: 175, remaining: -30000 });
    expect(u.bar().getAttribute('aria-valuenow')).toBe('100');
  });

  it('has no bar, only words, when no percentage can be given', async () => {
    const u = await open({ usagePercent: null, available: 0, spent: 0, remaining: 0 });

    expect(u.text()).toBe('On track Nothing available this month.');
    expect(queryByRole(u.element, 'progressbar')).toBeNull();
  });

  it('says how far over a budget is even when there is no percentage', async () => {
    const u = await open({ usagePercent: null, alert: 'over', spent: 500, remaining: -500 });
    expect(u.text()).toBe('Over budget by €5.00');
  });

  it('says the threshold of the budget, as the API reports it', async () => {
    const u = await open({ warnPercent: 90 });
    expect(u.text()).toContain('25% used, warns at 90%');
  });
});
