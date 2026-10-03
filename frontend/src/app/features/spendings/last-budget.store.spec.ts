import { TestBed } from '@angular/core/testing';
import { LAST_BUDGET_KEY, LastBudgetStore } from './last-budget.store';

describe('LastBudgetStore', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  const store = () => TestBed.inject(LastBudgetStore);

  it('remembers the budget between visits', () => {
    expect(store().get()).toBeNull();

    store().set(7);

    expect(localStorage.getItem(LAST_BUDGET_KEY)).toBe('7');
    expect(store().get()).toBe(7);
  });

  it('ignores a stored value that is not a budget id', () => {
    for (const junk of ['', 'abc', '0', '-3', '2.5', 'null']) {
      localStorage.setItem(LAST_BUDGET_KEY, junk);
      expect(store().get(), junk).toBeNull();
    }
  });

  it('works without storage: reading gives nothing and writing is not an error', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });

    expect(store().get()).toBeNull();
    expect(() => store().set(3)).not.toThrow();
  });
});
