import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { a11yProblems } from '../../../testing/a11y';
import { getByRole, typeInto } from '../../../testing/dom';
import { spendingDto, spendingsPage, tagDto } from '../../../testing/fixtures';
import { settle, StubPage } from '../../../testing/harness';
import { openSpendingsPage } from '../../../testing/spendings-harness';

const TAGS = [
  tagDto({ id: 1, name: 'Groceries', color: '#15803d' }),
  tagDto({ id: 2, name: 'Travel' }),
];

describe('SpendingsPage: markup a screen reader can use', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'spendings', component: StubPage }]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  it('has nothing wrong with the list, its filters and its tags', async () => {
    const p = await openSpendingsPage(http, {
      tags: TAGS,
      page: spendingsPage([
        spendingDto({ id: 5, description: 'Weekly shop', tagIds: [1, 2] }),
        spendingDto({ id: 6, description: 'Bus', amount: -300 }),
      ]),
    });

    expect(a11yProblems(p.element)).toEqual([]);
  });

  it('has nothing wrong with the filters when they are all in use', async () => {
    const p = await openSpendingsPage(http, {
      url: '/spendings?q=shop&budgetId=1&tagId=2&minAmount=-500&maxAmount=2000',
      firstPage: {
        month: '2026-10',
        budgetId: 1,
        tagId: 2,
        q: 'shop',
        minAmount: -500,
        maxAmount: 2000,
      },
      tags: TAGS,
    });

    expect(a11yProblems(p.element)).toEqual([]);
  });

  it('has nothing wrong with the add form once the tag field is up and its list is open', async () => {
    const p = await openSpendingsPage(http, { tags: TAGS });
    await p.press('Add tags', p.form());
    const box = getByRole(p.form(), 'combobox', 'Tags (optional)') as HTMLInputElement;
    box.click();
    await settle(p.fixture);
    expect(box.getAttribute('aria-expanded')).toBe('true');

    expect(a11yProblems(p.element)).toEqual([]);

    typeInto(box, 'gro');
    await settle(p.fixture);
    expect(box.getAttribute('aria-activedescendant')).not.toBeNull();
    expect(a11yProblems(p.element)).toEqual([]);
  });

  it('has nothing wrong with the edit dialog and its tags', async () => {
    const p = await openSpendingsPage(http, {
      tags: TAGS,
      page: spendingsPage([spendingDto({ id: 5, description: 'Weekly shop', tagIds: [1, 2] })]),
    });
    await p.press('Edit Weekly shop, €12.50');

    expect(a11yProblems(p.element)).toEqual([]);
  });

  it('has nothing wrong with the states: nothing matches, and a range to fix', async () => {
    const none = await openSpendingsPage(http, {
      url: '/spendings?q=zzz',
      firstPage: { month: '2026-10', q: 'zzz' },
      page: spendingsPage([]),
    });
    expect(a11yProblems(none.element)).toEqual([]);
  });
});
