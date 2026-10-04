import { Component, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { parseApiError } from '../../core/api-error';
import { blur, fieldError, getByLabel, textOf, typeInto } from '../../../testing/dom';
import { apiError, httpError, render, settle } from '../../../testing/harness';
import { applyApiErrors } from './api-errors';
import { AppInput } from './app-input';
import { Field } from './field';

@Component({
  selector: 'app-field-host',
  imports: [ReactiveFormsModule, Field, AppInput],
  template: `
    <form [formGroup]="form" novalidate>
      <app-field label="Name" hint="Shown on the budget card">
        <input appInput formControlName="name" />
      </app-field>
      <app-field label="Nickname" [optional]="true">
        <input appInput formControlName="nickname" />
      </app-field>
      <app-field label="Code" [error]="problem()">
        <input appInput formControlName="code" />
      </app-field>
    </form>
  `,
})
class FieldHost {
  readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    nickname: new FormControl(''),
    code: new FormControl(''),
  });
  readonly problem = signal<string | undefined>(undefined);
}

describe('Field', () => {
  async function setup() {
    const fixture = await render(FieldHost);
    const element = fixture.nativeElement as HTMLElement;
    return { fixture, element, host: fixture.componentInstance };
  }

  it('labels its control: the label is how the control is found', async () => {
    const { element } = await setup();

    const name = getByLabel(element, 'Name');
    expect(name.id).toMatch(/^field-\d+$/);
    expect(getByLabel(element, 'Nickname (optional)')).toBeTruthy();
    // Each field has its own id.
    expect(new Set([name.id, getByLabel(element, 'Code').id]).size).toBe(2);
  });

  it('describes the control by its hint', async () => {
    const { element } = await setup();
    const name = getByLabel(element, 'Name');

    const hint = element.querySelector(`#${name.getAttribute('aria-describedby')}`);
    expect(textOf(hint as Element)).toBe('Shown on the budget card');
    expect(name.getAttribute('aria-invalid')).toBeNull();
  });

  it('does not nag before the user has touched the field', async () => {
    const { element } = await setup();
    expect(fieldError(getByLabel(element, 'Name'))).toBe('');
  });

  it('shows what is wrong once the field is touched, and marks the control invalid', async () => {
    const { fixture, element } = await setup();
    const name = getByLabel(element, 'Name');

    blur(name);
    await settle(fixture);

    expect(fieldError(name)).toBe('Name is required.');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    // The hint is still part of the description.
    expect(name.getAttribute('aria-describedby')).toContain('-hint');
  });

  it('keeps an aria-live region in the page, with or without an error, so a late error is announced', async () => {
    const { fixture, element } = await setup();
    const regions = () => element.querySelectorAll('app-field [aria-live="polite"]');
    expect(regions()).toHaveLength(3);
    const first = regions()[0];

    blur(getByLabel(element, 'Name'));
    await settle(fixture);

    // The very same element received the message: that is what makes it announced.
    expect(regions()[0]).toBe(first);
    expect(textOf(first)).toBe('Name is required.');
  });

  it('clears the error when the value becomes valid', async () => {
    const { fixture, element } = await setup();
    const name = getByLabel(element, 'Name');
    blur(name);
    await settle(fixture);

    typeInto(name, 'Groceries');
    await settle(fixture);

    expect(fieldError(name)).toBe('');
    expect(name.getAttribute('aria-invalid')).toBeNull();
  });

  it('shows an error that comes from the API on the right field, until the user edits it', async () => {
    const { fixture, element, host } = await setup();
    const code = getByLabel(element, 'Code');

    const parsed = parseApiError(
      httpError(
        422,
        apiError('rule_violation', 'That code is taken', { rule: 'x', field: 'code' }),
      ),
    );
    applyApiErrors(host.form, parsed);
    await settle(fixture);

    expect(fieldError(code)).toBe('That code is taken');
    expect(code.getAttribute('aria-invalid')).toBe('true');
    expect(fieldError(getByLabel(element, 'Name'))).toBe('');

    typeInto(code, 'another');
    await settle(fixture);
    expect(fieldError(code)).toBe('');
  });

  it('can show an error that does not live in the control', async () => {
    const { fixture, element, host } = await setup();
    host.problem.set('Pick another code');
    await settle(fixture);

    const code = getByLabel(element, 'Code');
    expect(fieldError(code)).toBe('Pick another code');
    expect(code.getAttribute('aria-invalid')).toBe('true');
  });
});

@Component({
  selector: 'app-hidden-label-host',
  imports: [ReactiveFormsModule, Field, AppInput],
  template: `
    <app-field label="Search" [labelHidden]="true">
      <input appInput type="search" [formControl]="search" />
    </app-field>
  `,
})
class HiddenLabelHost {
  readonly search = new FormControl('', { nonNullable: true });
}

describe('Field with a hidden label', () => {
  it('keeps the label for screen readers: it still names the control, but is not drawn', async () => {
    const fixture = await render(HiddenLabelHost);
    const element = fixture.nativeElement as HTMLElement;

    expect(getByLabel(element, 'Search')).toBeTruthy();
    const label = element.querySelector('label') as HTMLElement;
    expect(label.classList).toContain('sr-only');
    expect(label.classList).not.toContain('mb-1.5');
  });
});

@Component({
  selector: 'app-control-types-host',
  imports: [ReactiveFormsModule, Field, AppInput],
  template: `
    <form [formGroup]="form" novalidate>
      <app-field label="Notes"><textarea appInput formControlName="notes"></textarea></app-field>
      <app-field label="Theme">
        <select appInput formControlName="theme">
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </app-field>
      <app-field label="Date"><input appInput type="date" formControlName="date" /></app-field>
    </form>
  `,
})
class ControlTypesHost {
  readonly form = new FormGroup({
    notes: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    theme: new FormControl('light', { nonNullable: true }),
    date: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });
}

describe('AppInput on every kind of control', () => {
  it('styles and wires text areas, selects and date inputs the same way', async () => {
    const fixture = await render(ControlTypesHost);
    const element = fixture.nativeElement as HTMLElement;

    const controls = [
      getByLabel<HTMLTextAreaElement>(element, 'Notes'),
      getByLabel<HTMLSelectElement>(element, 'Theme'),
      getByLabel<HTMLInputElement>(element, 'Date'),
    ];
    expect(controls.map((control) => control.tagName)).toEqual(['TEXTAREA', 'SELECT', 'INPUT']);
    for (const control of controls) {
      expect(control.className).toContain('rounded-control');
      expect(control.className).toContain('border-line-strong');
      expect(control.id).toMatch(/^field-\d+$/);
    }

    // Errors work for all of them.
    blur(controls[0]);
    blur(controls[2]);
    await settle(fixture);
    expect(fieldError(controls[0])).toBe('Notes is required.');
    expect(fieldError(controls[2])).toBe('Date is required.');
    expect(controls[0].getAttribute('aria-invalid')).toBe('true');
    expect(controls[1].getAttribute('aria-invalid')).toBeNull();
  });
});
