import type { BudgetAlert } from '@wallet/shared';
import { sortByAlert } from './alert-order';

const line = (name: string, alert: BudgetAlert) => ({ name, alert });
const names = (lines: { name: string }[]) => lines.map((l) => l.name);

describe('sortByAlert', () => {
  it('puts budgets over budget first, then in warning, then the rest', () => {
    const sorted = sortByAlert([
      line('a', 'ok'),
      line('b', 'warning'),
      line('c', 'over'),
      line('d', 'ok'),
    ]);
    expect(names(sorted)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('keeps the order the API gave within each state', () => {
    const sorted = sortByAlert([
      line('rent', 'ok'),
      line('fun', 'over'),
      line('food', 'warning'),
      line('gifts', 'over'),
      line('pets', 'warning'),
      line('travel', 'ok'),
    ]);
    expect(names(sorted)).toEqual(['fun', 'gifts', 'food', 'pets', 'rent', 'travel']);
  });

  it('leaves a list whose budgets are all in one state as it was', () => {
    const lines = [line('a', 'ok'), line('b', 'ok'), line('c', 'ok')];
    expect(names(sortByAlert(lines))).toEqual(['a', 'b', 'c']);
  });

  it('handles no budgets, and one', () => {
    expect(sortByAlert([])).toEqual([]);
    expect(names(sortByAlert([line('only', 'warning')]))).toEqual(['only']);
  });

  it('returns a new list and leaves its input alone', () => {
    const input = [line('a', 'ok'), line('b', 'over')];
    const sorted = sortByAlert(input);
    expect(sorted).not.toBe(input);
    expect(names(input)).toEqual(['a', 'b']);
  });
});
