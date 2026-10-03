import { planSwap } from './budget-order';

const budgets = (...pairs: [id: number, sortOrder: number][]) =>
  pairs.map(([id, sortOrder]) => ({ id, sortOrder }));

describe('planSwap', () => {
  it('trades the sort orders of the two budgets, and changes nothing else', () => {
    const list = budgets([1, 0], [2, 10], [3, 20], [4, 30]);

    expect(planSwap(list, 3, 2)).toEqual([
      { id: 3, sortOrder: 10 },
      { id: 2, sortOrder: 20 },
    ]);
    expect(planSwap(list, 2, 3)).toEqual([
      { id: 2, sortOrder: 20 },
      { id: 3, sortOrder: 10 },
    ]);
  });

  it('keeps the gaps: budgets hidden from the page keep their numbers', () => {
    // Budget 9 is archived and not on the page. Moving 3 above 1 trades only their numbers.
    const list = budgets([1, 0], [9, 5], [3, 10]);

    expect(planSwap(list, 3, 1)).toEqual([
      { id: 3, sortOrder: 0 },
      { id: 1, sortOrder: 10 },
    ]);
  });

  it('numbers the list again when the two have the same sort order, because a swap would change nothing', () => {
    const list = budgets([1, 0], [2, 10], [3, 10], [4, 20]);

    // 3 goes above 2: the new order is 1, 3, 2, 4 and only the changed numbers are sent.
    expect(planSwap(list, 3, 2)).toEqual([
      { id: 2, sortOrder: 20 },
      { id: 4, sortOrder: 30 },
    ]);
  });

  it('breaks a tie between all of them with the first move', () => {
    const list = budgets([1, 0], [2, 0], [3, 0]);

    expect(planSwap(list, 2, 1)).toEqual([
      { id: 1, sortOrder: 10 },
      // 2 takes the first place; 3 keeps the third, which is where the numbers put it anyway.
      { id: 3, sortOrder: 20 },
    ]);
  });

  it('does nothing for an unknown budget, or a budget traded with itself', () => {
    const list = budgets([1, 0], [2, 10]);

    expect(planSwap(list, 7, 1)).toEqual([]);
    expect(planSwap(list, 1, 7)).toEqual([]);
    expect(planSwap(list, 1, 1)).toEqual([]);
  });
});
