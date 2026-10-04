import { Component, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { a11yProblems } from '../../../testing/a11y';
import { getByLabel, getByRole, queryAllByRole, textOf } from '../../../testing/dom';
import { render, settle } from '../../../testing/harness';
import { Segmented, type SegmentedOption } from './segmented';

const OPTIONS: SegmentedOption[] = [
  { value: 'month', label: 'October 2026' },
  { value: 'all', label: 'All months' },
];

@Component({
  selector: 'app-segmented-host',
  imports: [ReactiveFormsModule, Segmented],
  template: `
    <app-segmented
      id="form"
      legend="Show spendings from"
      [options]="options"
      [formControl]="scope"
    />
    <app-segmented id="plain" legend="View" [options]="options" legendHidden [(value)]="view" />
  `,
})
class SegmentedHost {
  readonly options = OPTIONS;
  readonly scope = new FormControl<string | null>('month');
  readonly view = signal<string | null>(null);
}

describe('Segmented', () => {
  async function setup() {
    const fixture = await render(SegmentedHost);
    const element = fixture.nativeElement as HTMLElement;
    const form = element.querySelector('#form') as HTMLElement;
    const plain = element.querySelector('#plain') as HTMLElement;
    const radio = (root: HTMLElement, label: string) => getByLabel<HTMLInputElement>(root, label);
    return { fixture, host: fixture.componentInstance, element, form, plain, radio };
  }

  describe('as a group of radio buttons', () => {
    it('is a fieldset named by its legend, with one native radio for each option', async () => {
      const { form } = await setup();

      expect(getByRole(form, 'group', 'Show spendings from').tagName).toBe('FIELDSET');
      const radios = queryAllByRole(form, 'radio') as HTMLInputElement[];
      expect(radios.map((input) => input.type)).toEqual(['radio', 'radio']);
      expect(radios.map((input) => input.value)).toEqual(['month', 'all']);
    });

    it('names each radio by its label, and the options share one name so the arrow keys move the choice', async () => {
      const { form, radio } = await setup();

      const names = new Set(
        (queryAllByRole(form, 'radio') as HTMLInputElement[]).map((input) => input.name),
      );
      expect(names.size).toBe(1);
      expect([...names][0]).not.toBe('');
      expect(radio(form, 'October 2026')).toBeTruthy();
      expect(radio(form, 'All months')).toBeTruthy();
    });

    it('gives each group its own name', async () => {
      const { form, plain } = await setup();

      const nameOf = (root: HTMLElement) =>
        (queryAllByRole(root, 'radio')[0] as HTMLInputElement).name;
      expect(nameOf(form)).not.toBe(nameOf(plain));
    });

    it('keeps the legend on screen, or for screen readers only', async () => {
      const { form, plain } = await setup();

      expect(form.querySelector('legend')?.classList).not.toContain('sr-only');
      expect(textOf(form.querySelector('legend') as Element)).toBe('Show spendings from');
      expect(plain.querySelector('legend')?.classList).toContain('sr-only');
      expect(getByRole(plain, 'group', 'View')).toBeTruthy();
    });
  });

  describe('the choice', () => {
    it('shows the value of the form control, and follows a change made in code', async () => {
      const { fixture, host, form, radio } = await setup();
      expect(radio(form, 'October 2026').checked).toBe(true);
      expect(radio(form, 'All months').checked).toBe(false);

      host.scope.setValue('all');
      await settle(fixture);

      expect(radio(form, 'October 2026').checked).toBe(false);
      expect(radio(form, 'All months').checked).toBe(true);
    });

    it('writes to the form control when an option is chosen', async () => {
      const { fixture, host, form, radio } = await setup();

      radio(form, 'All months').click();
      await settle(fixture);

      expect(host.scope.value).toBe('all');
      expect(radio(form, 'All months').checked).toBe(true);
    });

    it('works without a form: two-way, from nothing chosen', async () => {
      const { fixture, host, plain, radio } = await setup();
      expect(radio(plain, 'October 2026').checked).toBe(false);
      expect(radio(plain, 'All months').checked).toBe(false);

      radio(plain, 'All months').click();
      await settle(fixture);
      expect(host.view()).toBe('all');

      host.view.set('month');
      await settle(fixture);
      expect(radio(plain, 'October 2026').checked).toBe(true);
    });

    it('can be disabled', async () => {
      const { fixture, host, form } = await setup();

      host.scope.disable();
      await settle(fixture);

      expect(
        (queryAllByRole(form, 'radio') as HTMLInputElement[]).map((input) => input.disabled),
      ).toEqual([true, true]);
    });
  });

  describe('the look', () => {
    it('says which option is chosen by more than color: a check mark beside its label', async () => {
      const { fixture, host, form } = await setup();
      const checks = () =>
        Array.from(form.querySelectorAll('label')).map(
          (label) => label.querySelector('svg') !== null,
        );

      expect(checks()).toEqual([true, false]);
      host.scope.setValue('all');
      await settle(fixture);
      expect(checks()).toEqual([false, true]);
    });

    it('fills the chosen option with the accent color', async () => {
      const { form } = await setup();

      const label = form.querySelector('label span') as HTMLElement;
      expect(label.classList).toContain('peer-checked:bg-accent');
      expect(label.classList).toContain('peer-checked:text-on-accent');
    });

    it('shows the focus ring of the option that has focus, inside the control', async () => {
      const { form } = await setup();

      const label = form.querySelector('label span') as HTMLElement;
      expect(label.classList).toContain('peer-focus-visible:outline-2');
      expect(label.classList).toContain('peer-focus-visible:outline-focus');
      expect(label.classList).toContain('peer-focus-visible:-outline-offset-2');
    });

    it('hides the radio itself from the eye but not from the keyboard or a screen reader', async () => {
      const { form } = await setup();

      const input = form.querySelector('input') as HTMLInputElement;
      expect(input.classList).toContain('sr-only');
      expect(input.getAttribute('aria-hidden')).toBeNull();
      expect(input.tabIndex).toBe(0);
    });

    it('is a 44 px target and wraps a long label instead of widening the page', async () => {
      const { form } = await setup();

      const label = form.querySelector('label') as HTMLElement;
      expect(label.querySelector('span')?.classList).toContain('min-h-11');
      expect(label.classList).toContain('min-w-0');
      expect(form.querySelector('fieldset')?.classList).toContain('min-w-0');
    });
  });

  it('has nothing for a screen reader to complain about', async () => {
    const { element } = await setup();
    expect(a11yProblems(element)).toEqual([]);
  });
});
