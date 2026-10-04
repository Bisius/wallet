import { Component, signal } from '@angular/core';
import { a11yProblems } from '../../../testing/a11y';
import { getByRole, queryAllByRole, textOf } from '../../../testing/dom';
import { render, settle } from '../../../testing/harness';
import { Stepper, type StepperStep } from './stepper';

const STEPS: StepperStep[] = [
  { id: 'basics', label: 'Basics' },
  { id: 'salary', label: 'Salary' },
  { id: 'savings', label: 'Savings' },
];

@Component({
  selector: 'app-stepper-host',
  imports: [Stepper],
  template: `<app-stepper label="Setup progress" [steps]="steps" [current]="current()" />`,
})
class StepperHost {
  readonly steps = STEPS;
  readonly current = signal(0);
}

describe('Stepper', () => {
  async function setup() {
    const fixture = await render(StepperHost);
    const element = fixture.nativeElement as HTMLElement;
    const items = () =>
      queryAllByRole(getByRole(element, 'navigation', 'Setup progress'), 'listitem');
    const go = async (index: number) => {
      fixture.componentInstance.current.set(index);
      await settle(fixture);
    };
    return { fixture, element, items, go };
  }

  it('is a list of the steps in a navigation named for what it shows', async () => {
    const { element, items } = await setup();

    expect(getByRole(element, 'navigation', 'Setup progress').querySelector('ol')).not.toBeNull();
    expect(items()).toHaveLength(3);
  });

  it('marks the current step with aria-current, and only that one', async () => {
    const { items, go } = await setup();
    expect(items().map((item) => item.getAttribute('aria-current'))).toEqual(['step', null, null]);

    await go(1);
    expect(items().map((item) => item.getAttribute('aria-current'))).toEqual([null, 'step', null]);
  });

  it('says in words where the person is: "Step 2 of 3"', async () => {
    const { element, go } = await setup();
    expect(textOf(element)).toContain('Step 1 of 3');

    await go(1);
    expect(textOf(element)).toContain('Step 2 of 3');
  });

  it('shows the number of a step that is not done, and a check for one that is', async () => {
    const { items, go } = await setup();
    await go(1);

    const [done, current, next] = items();
    expect(done.querySelector('svg')).not.toBeNull();
    expect(done.querySelector('[aria-hidden="true"]')?.textContent).not.toContain('1');
    expect(current.querySelector('svg')).toBeNull();
    expect(current.querySelector('[aria-hidden="true"]')?.textContent?.trim()).toBe('2');
    expect(next.querySelector('[aria-hidden="true"]')?.textContent?.trim()).toBe('3');
  });

  it('never draws the check as a text glyph', async () => {
    const { element, go } = await setup();
    await go(2);

    expect(element.textContent).not.toContain('✓');
  });

  it('tells a screen reader which steps are done and which are to come', async () => {
    const { items, go } = await setup();
    await go(1);

    // The circle is decoration: a reader hears the name and the state.
    expect(items().map((item) => textOf(item))).toEqual([
      'Basics (done)',
      'Salary',
      'Savings (upcoming)',
    ]);
  });

  it('keeps the name of the current step on screen, and shows the others from sm up', async () => {
    const { items } = await setup();

    const names = items().map((item) => item.querySelectorAll('span')[1]);
    expect(names[0].classList).not.toContain('sr-only');
    expect(names[0].classList).toContain('font-semibold');
    expect(names[1].classList).toContain('sr-only');
    expect(names[1].classList).toContain('sm:not-sr-only');
  });

  it('has nothing for a screen reader to complain about', async () => {
    const { element, go } = await setup();
    expect(a11yProblems(element)).toEqual([]);

    await go(2);
    expect(a11yProblems(element)).toEqual([]);
  });
});
