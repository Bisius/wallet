import { spendingDto } from '../../../testing/fixtures';
import { groupByDay } from './group-by-day';

describe('groupByDay', () => {
  it('puts the spendings of one day together, keeping the order of the list', () => {
    const groups = groupByDay([
      spendingDto({ id: 5, date: '2026-10-09' }),
      spendingDto({ id: 4, date: '2026-10-09' }),
      spendingDto({ id: 3, date: '2026-10-02' }),
      spendingDto({ id: 2, date: '2026-10-01' }),
      spendingDto({ id: 1, date: '2026-10-01' }),
    ]);

    expect(groups.map((group) => [group.date, group.items.map((item) => item.id)])).toEqual([
      ['2026-10-09', [5, 4]],
      ['2026-10-02', [3]],
      ['2026-10-01', [2, 1]],
    ]);
  });

  it('only merges neighbours, so it never reorders the list', () => {
    const groups = groupByDay([
      spendingDto({ id: 3, date: '2026-10-02' }),
      spendingDto({ id: 2, date: '2026-10-01' }),
      spendingDto({ id: 1, date: '2026-10-02' }),
    ]);

    expect(groups.map((group) => group.date)).toEqual(['2026-10-02', '2026-10-01', '2026-10-02']);
  });

  it('gives no groups for no spendings', () => {
    expect(groupByDay([])).toEqual([]);
  });
});
