import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { GoalDto, SavingsDto } from '@wallet/shared';
import {
  fieldError,
  getByLabel,
  getByRole,
  queryAllByRole,
  queryByRole,
  textOf,
} from '../../../testing/dom';
import { goalDto, savingsDto } from '../../../testing/fixtures';
import { flushError, settle } from '../../../testing/harness';
import { menuItemNames } from '../../../testing/menu';
import { openSavingsPage } from '../../../testing/savings-harness';

/** Today in these specs is 2026-10-02, so the deadline 2027-03-15 leaves six months (October to March). */
const HOLIDAY = goalDto({
  id: 1,
  name: 'Holiday',
  targetAmount: 100000,
  balance: 35000,
  deadline: '2027-03-15',
  color: '#2563eb',
});

describe('the goals', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const open = (goals: GoalDto[], extra: Partial<SavingsDto> = {}) =>
    openSavingsPage(http, { savings: savingsDto({ goals, ...extra }) });
  type Page = Awaited<ReturnType<typeof open>>;
  const card = (p: Page, name: string) => getByRole(p.element, 'article', name);
  const cardText = (p: Page, name: string) => textOf(card(p, name));
  const section = (p: Page) => p.region('Goals');
  /** The buttons a card shows: the ones in its menu are not among them. */
  const visibleButtons = (cardElement: HTMLElement) =>
    queryAllByRole(cardElement, 'button')
      .filter((button) => !button.hasAttribute('appMenuItem'))
      .map((button) => button.getAttribute('aria-label') ?? textOf(button));

  describe('the cards', () => {
    it('invites the user to create a first goal', async () => {
      const p = await open([]);

      expect(textOf(section(p))).toContain('No goals yet');
      expect(queryAllByRole(section(p), 'button').map((b) => textOf(b))).toEqual([
        'New goal',
        'New goal',
      ]);
      expect(queryAllByRole(section(p), 'article')).toEqual([]);
    });

    it('shows what a goal holds against its target, how far along it is and what is missing', async () => {
      const p = await open([HOLIDAY]);

      const text = cardText(p, 'Holiday');
      expect(text).toContain('Saved €350.00');
      expect(text).toContain('Target €1,000.00');
      expect(text).toContain('Still to save €650.00');
      expect(text).toContain('35% of the target');
      expect(text).toContain('Active');
      const bar = getByRole(card(p, 'Holiday'), 'progressbar', 'Holiday progress');
      expect(bar.getAttribute('aria-valuenow')).toBe('35');
      expect(bar.getAttribute('aria-valuetext')).toBe('35% of the target saved');
    });

    it('says in words what to put aside each month to reach the deadline', async () => {
      const p = await open([
        goalDto({
          id: 1,
          name: 'Holiday',
          targetAmount: 100000,
          balance: 0,
          deadline: '2027-03-15',
        }),
      ]);

      expect(cardText(p, 'Holiday')).toContain(
        'Put aside €166.67 a month to reach it by March 2027.',
      );
    });

    it('shows the monthly amount the API gives, not one it works out', async () => {
      const p = await open([goalDto({ ...HOLIDAY, monthlyNeeded: 12345 })]);

      expect(cardText(p, 'Holiday')).toContain('Put aside €123.45 a month');
    });

    it('says there is no deadline, and says nothing about a monthly amount', async () => {
      const p = await open([goalDto({ id: 1, name: 'Rainy day', deadline: null })]);

      const text = cardText(p, 'Rainy day');
      expect(text).toContain('No deadline.');
      expect(text).not.toContain('Put aside');
    });

    it('marks a reached goal in words, an icon and its status, and drops what is missing', async () => {
      const p = await open([
        goalDto({ id: 1, name: 'Laptop', targetAmount: 90000, balance: 90000 }),
      ]);

      const text = cardText(p, 'Laptop');
      expect(text).toContain('Reached');
      expect(text).toContain('Target reached.');
      expect(text).toContain('100% of the target');
      expect(text).not.toContain('Still to save');
      expect(text).not.toContain('Put aside');
    });

    it('gives each status a meaning besides its word: active and reached are positive, overdue is a warning, archived is neutral', async () => {
      const p = await open([
        goalDto({ id: 1, name: 'Rainy day', deadline: null }),
        goalDto({ id: 2, name: 'Laptop', targetAmount: 90000, balance: 90000 }),
        goalDto({
          id: 3,
          name: 'Bike',
          targetAmount: 100000,
          balance: 35000,
          deadline: '2026-02-10',
        }),
        goalDto({ id: 4, name: 'Holiday', archived: true }),
      ]);
      const tone = (name: string, label: string) => {
        const badge = Array.from(card(p, name).querySelectorAll<HTMLElement>('app-badge')).find(
          (candidate) => textOf(candidate) === label,
        );
        return [...(badge?.classList ?? [])].find((className) => className.startsWith('bg-'));
      };

      expect(tone('Rainy day', 'Active')).toBe('bg-positive-soft');
      expect(tone('Laptop', 'Reached')).toBe('bg-positive-soft');
      expect(tone('Bike', 'Overdue')).toBe('bg-warning-soft');
      expect(tone('Holiday', 'Archived')).toBe('bg-subtle');
    });

    it('lets the progress pass 100: the bar is full, the words say how far', async () => {
      const p = await open([
        goalDto({ id: 1, name: 'Laptop', targetAmount: 90000, balance: 135000 }),
      ]);

      const bar = getByRole(card(p, 'Laptop'), 'progressbar', 'Laptop progress');
      expect(bar.getAttribute('aria-valuenow')).toBe('100');
      expect(bar.getAttribute('aria-valuetext')).toBe('150% of the target saved');
      expect(cardText(p, 'Laptop')).toContain('150% of the target');
    });

    it('marks an overdue goal and says it needs all of what is missing now', async () => {
      const p = await open([
        goalDto({
          id: 1,
          name: 'Bike',
          targetAmount: 100000,
          balance: 35000,
          deadline: '2026-02-10',
        }),
      ]);

      const text = cardText(p, 'Bike');
      expect(text).toContain('Overdue');
      expect(text).toContain(
        'The deadline, February 2026, has passed. Put aside €650.00 now to reach the target.',
      );
    });

    it('shows a goal that holds less than nothing with its minus sign and an explanation', async () => {
      const p = await open([goalDto({ id: 1, name: 'Car', balance: -5000, targetAmount: 100000 })]);

      const text = cardText(p, 'Car');
      expect(text).toContain('Saved -€50.00');
      expect(text).toContain('Below zero: more was taken out of this goal than it held.');
      expect(text).toContain('0% of the target');
      expect(p.alerts()).toEqual([]);
      // No error color on the figures or the words (the red of Delete in the menu is another matter).
      expect(card(p, 'Car').querySelector('.text-negative:not([appMenuItem])')).toBeNull();
    });

    it('colors the card with the goal color', async () => {
      const p = await open([HOLIDAY]);

      // A dot beside the name, for the eye only: the name says what the card is.
      const dot = card(p, 'Holiday').querySelector('span[appColorDot]') as HTMLElement;
      expect(dot.style.backgroundColor).toBe('rgb(37, 99, 235)');
      expect(dot.getAttribute('aria-hidden')).toBe('true');
    });

    it('folds archived goals away in a section of their own, with the actions that make sense for them', async () => {
      const p = await open([
        HOLIDAY,
        goalDto({
          id: 2,
          name: 'Old laptop',
          archived: true,
          balance: 5000,
          deadline: '2027-01-01',
        }),
      ]);

      const details = section(p).querySelector('details') as HTMLDetailsElement;
      expect(details.open).toBe(false);
      expect(textOf(details.querySelector('summary') as Element)).toBe('Archived goals (1)');
      const archived = cardText(p, 'Old laptop');
      expect(archived).toContain('Archived');
      expect(archived).toContain('Deadline: January 2027');
      expect(archived).not.toContain('Put aside');
      // It takes no new money, but what it holds can be taken out: no Deposit button, and the menu
      // has Withdraw and Reallocate, and what any goal can do.
      expect(visibleButtons(card(p, 'Old laptop'))).toEqual(['More actions for Old laptop']);
      expect(menuItemNames(card(p, 'Old laptop'))).toEqual([
        'Withdraw',
        'Reallocate',
        'Edit',
        'Unarchive',
        'Delete',
      ]);
      expect(archived).toContain('you can still take out what it holds');
      // The goal in use is outside the folded section and can take money.
      expect(details.contains(card(p, 'Holiday'))).toBe(false);
      expect(visibleButtons(card(p, 'Holiday'))).toEqual([
        'Deposit to Holiday',
        'More actions for Holiday',
      ]);
      expect(menuItemNames(card(p, 'Holiday'))).toEqual(['Withdraw', 'Edit', 'Archive', 'Delete']);
    });

    it('says so when every goal is archived', async () => {
      const p = await open([goalDto({ id: 2, name: 'Old laptop', archived: true })]);

      expect(textOf(section(p))).toContain('All your goals are archived');
      expect(textOf(section(p))).not.toContain('No goals yet');
    });
  });

  describe('creating a goal', () => {
    const dialog = (p: Page) => p.dialog('app-goal-form') as HTMLElement;
    const newGoal = async (p: Page) => {
      await p.press('New goal', section(p).querySelector('header, div') as HTMLElement);
      return dialog(p);
    };

    it('does not send an incomplete form, and says what is missing', async () => {
      const p = await open([]);
      const form = await newGoal(p);

      await p.press('Create goal', form);

      expect(fieldError(getByLabel(form, 'Name'))).toBe('Name is required.');
      expect(fieldError(getByLabel(form, 'Target amount'))).toBe('Target amount is required.');
      expect(document.activeElement).toBe(getByLabel(form, 'Name'));
      http.expectNone('/api/goals');
    });

    it('does not accept a target of zero', async () => {
      const p = await open([]);
      const form = await newGoal(p);
      await p.type('Name', 'Holiday', form);
      await p.type('Target amount', '0', form);

      await p.press('Create goal', form);

      expect(fieldError(getByLabel(form, 'Target amount'))).toBe(
        'Enter an amount greater than zero.',
      );
      http.expectNone('/api/goals');
    });

    it('sends the name and the target, then reloads and confirms', async () => {
      const p = await open([]);
      const form = await newGoal(p);
      await p.type('Name', '  Holiday ', form);
      await p.type('Target amount', '1000', form);

      await p.press('Create goal', form);

      const request = http.expectOne('/api/goals');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ name: 'Holiday', targetAmount: 100000 });
      request.flush(HOLIDAY, { status: 201, statusText: 'Created' });
      await p.reload({ savings: savingsDto({ goals: [HOLIDAY] }) });

      expect(p.dialog('app-goal-form')).toBeNull();
      expect(p.toasts()).toEqual(['Holiday created.']);
      expect(cardText(p, 'Holiday')).toContain('Target €1,000.00');
    });

    it('sends the deadline and the color when they are chosen', async () => {
      const p = await open([]);
      const form = await newGoal(p);
      await p.type('Name', 'Holiday', form);
      await p.type('Target amount', '1000,50', form);
      await p.type(/^Deadline/, '2027-03-15', form);
      getByLabel(form, 'Blue').click();
      await settle(p.fixture);

      await p.press('Create goal', form);

      expect(http.expectOne('/api/goals').request.body).toEqual({
        name: 'Holiday',
        targetAmount: 100050,
        deadline: '2027-03-15',
        color: '#2563eb',
      });
    });

    it('shows the message of the API on the field it names, and keeps the dialog open', async () => {
      const p = await open([]);
      const form = await newGoal(p);
      await p.type('Name', 'Holiday', form);
      await p.type('Target amount', '1000', form);
      await p.press('Create goal', form);

      flushError(http.expectOne('/api/goals'), 400, 'validation_error', 'Invalid request body', [
        { path: 'targetAmount', message: 'Amount out of range' },
      ]);
      await settle(p.fixture);

      expect(fieldError(getByLabel(form, 'Target amount'))).toBe('Amount out of range');
      expect(p.dialog('app-goal-form')).not.toBeNull();
      expect(p.value('Name', form)).toBe('Holiday');
    });

    it('closes without a request when cancelled', async () => {
      const p = await open([]);
      const form = await newGoal(p);

      await p.press('Cancel', form);

      expect(p.dialog('app-goal-form')).toBeNull();
      http.expectNone('/api/goals');
    });
  });

  describe('editing a goal', () => {
    const edit = async (p: Page, name = 'Holiday') => {
      await p.menuAction(`More actions for ${name}`, 'Edit');
      return p.dialog('app-goal-form') as HTMLElement;
    };

    it('starts from what the goal is now', async () => {
      const p = await open([HOLIDAY]);
      const form = await edit(p);

      expect(textOf(getByRole(form, 'heading', 'Edit Holiday'))).toBe('Edit Holiday');
      expect(p.value('Name', form)).toBe('Holiday');
      expect(p.value('Target amount', form)).toBe('1000.00');
      expect(p.value(/^Deadline/, form)).toBe('2027-03-15');
      expect((getByLabel(form, 'Blue') as HTMLInputElement).checked).toBe(true);
    });

    it('sends only what changed', async () => {
      const p = await open([HOLIDAY]);
      const form = await edit(p);
      await p.type('Name', 'Summer holiday', form);

      await p.press('Save changes', form);

      const request = http.expectOne('/api/goals/1');
      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({ name: 'Summer holiday' });
      request.flush({ ...HOLIDAY, name: 'Summer holiday' });
      await p.reload({ savings: savingsDto({ goals: [{ ...HOLIDAY, name: 'Summer holiday' }] }) });

      expect(p.toasts()).toEqual(['Summer holiday updated.']);
      expect(p.dialog('app-goal-form')).toBeNull();
    });

    it('clears the deadline and the color with null', async () => {
      const p = await open([HOLIDAY]);
      const form = await edit(p);
      await p.type(/^Deadline/, '', form);
      getByLabel(form, 'None').click();
      await settle(p.fixture);

      await p.press('Save changes', form);

      expect(http.expectOne('/api/goals/1').request.body).toEqual({ deadline: null, color: null });
    });

    it('changes the target', async () => {
      const p = await open([HOLIDAY]);
      const form = await edit(p);
      await p.type('Target amount', '1500', form);

      await p.press('Save changes', form);

      expect(http.expectOne('/api/goals/1').request.body).toEqual({ targetAmount: 150000 });
    });

    it('closes without a request when nothing changed', async () => {
      const p = await open([HOLIDAY]);
      const form = await edit(p);

      await p.press('Save changes', form);

      expect(p.dialog('app-goal-form')).toBeNull();
      http.expectNone('/api/goals/1');
    });

    it('can edit an archived goal too', async () => {
      const p = await open([goalDto({ id: 2, name: 'Old laptop', archived: true })]);
      const form = await edit(p, 'Old laptop');
      await p.type('Name', 'Laptop', form);

      await p.press('Save changes', form);

      expect(http.expectOne('/api/goals/2').request.body).toEqual({ name: 'Laptop' });
    });
  });

  describe('archiving', () => {
    it('archives a goal, says it keeps its balance, and moves its card to the archived section', async () => {
      const p = await open([HOLIDAY]);

      await p.menuAction('More actions for Holiday', 'Archive');
      const request = http.expectOne('/api/goals/1');
      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({ archived: true });
      request.flush({ ...HOLIDAY, archived: true, status: 'archived' });
      await p.reload({
        savings: savingsDto({ goals: [{ ...HOLIDAY, archived: true, status: 'archived' }] }),
      });

      expect(p.toasts()).toEqual([
        'Holiday archived. It keeps its balance, and you can bring it back any time.',
      ]);
      const details = section(p).querySelector('details') as HTMLDetailsElement;
      expect(details.contains(card(p, 'Holiday'))).toBe(true);
      expect(textOf(section(p))).toContain('All your goals are archived');
      expect(document.activeElement).toBe(getByRole(section(p), 'heading', 'Goals'));
    });

    it('brings an archived goal back', async () => {
      const archived = { ...HOLIDAY, archived: true, status: 'archived' as const };
      const p = await open([archived]);

      await p.menuAction('More actions for Holiday', 'Unarchive');
      const request = http.expectOne('/api/goals/1');
      expect(request.request.body).toEqual({ archived: false });
      request.flush(HOLIDAY);
      await p.reload({ savings: savingsDto({ goals: [HOLIDAY] }) });

      expect(p.toasts()).toEqual(['Holiday is active again.']);
      expect(section(p).querySelector('details')).toBeNull();
    });

    it('says what the API said when it fails, and loads the goals again', async () => {
      const p = await open([HOLIDAY]);
      await p.menuAction('More actions for Holiday', 'Archive');

      flushError(http.expectOne('/api/goals/1'), 404, 'not_found', 'Goal 1 not found');
      await p.reload({ savings: savingsDto({ goals: [] }) });

      expect(p.toasts()).toEqual(['Goal 1 not found']);
      expect(textOf(section(p))).toContain('No goals yet');
    });
  });

  describe('deleting', () => {
    it('asks first, and says the balance moves to unassigned savings and nothing is lost', async () => {
      const p = await open([HOLIDAY]);

      await p.menuAction('More actions for Holiday', 'Delete');
      await settle(p.fixture);

      const dialog = p.confirmDialog();
      expect(textOf(getByRole(dialog, 'heading', 'Delete "Holiday"?'))).toBe('Delete "Holiday"?');
      const message = textOf(dialog);
      expect(message).toContain('Its balance of €350.00 moves to your unassigned savings');
      expect(message).toContain('nothing is lost');
      expect(message).toContain('your savings balance stays the same');
      http.expectNone('/api/goals/1');
    });

    it('deletes the goal when confirmed, then loads everything again and confirms', async () => {
      const p = await open([HOLIDAY], { unassigned: 10000 });
      await p.menuAction('More actions for Holiday', 'Delete');

      await p.confirm('Delete goal');
      const request = http.expectOne('/api/goals/1');
      expect(request.request.method).toBe('DELETE');
      request.flush(null, { status: 204, statusText: 'No Content' });
      await p.reload({ savings: savingsDto({ unassigned: 45000 }) });

      expect(p.toasts()).toEqual(['Holiday deleted. €350.00 moved to unassigned savings.']);
      expect(textOf(section(p))).toContain('No goals yet');
      expect(p.regionText('Your savings')).toContain('Unassigned €450.00');
    });

    it('says a goal below zero moves its negative balance too', async () => {
      const p = await open([goalDto({ id: 1, name: 'Car', balance: -5000 })]);

      await p.menuAction('More actions for Car', 'Delete');
      await settle(p.fixture);

      expect(textOf(p.confirmDialog())).toContain('Its balance of -€50.00 moves');
    });

    it('does nothing when the user cancels', async () => {
      const p = await open([HOLIDAY]);
      await p.menuAction('More actions for Holiday', 'Delete');

      await p.confirm('Cancel');

      http.expectNone('/api/goals/1');
      expect(queryByRole(section(p), 'article', 'Holiday')).not.toBeNull();
    });

    it('says what the API said when it fails', async () => {
      const p = await open([HOLIDAY]);
      await p.menuAction('More actions for Holiday', 'Delete');
      await p.confirm('Delete goal');

      flushError(http.expectOne('/api/goals/1'), 500, 'internal_error', 'Something went wrong');
      await p.reload({ savings: savingsDto({ goals: [HOLIDAY] }) });

      expect(p.toasts()).toEqual(['Something went wrong']);
    });
  });
});
