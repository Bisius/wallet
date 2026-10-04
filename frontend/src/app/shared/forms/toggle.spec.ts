import { Component, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { getByLabel, getByRole, getByText } from '../../../testing/dom';
import { render, settle } from '../../../testing/harness';
import { Toggle } from './toggle';

@Component({
  selector: 'app-toggle-host',
  imports: [ReactiveFormsModule, Toggle],
  template: `
    <app-toggle [formControl]="incremental" label="Incremental" hint="Leftovers carry over." />
    <app-toggle [formControl]="agree" kind="checkbox" label="I agree" />
    <app-toggle kind="checkbox" label="First row is a header" [(checked)]="header" />
  `,
})
class ToggleHost {
  readonly incremental = new FormControl(false, { nonNullable: true });
  readonly agree = new FormControl(true, { nonNullable: true });
  readonly header = signal(true);
}

describe('Toggle', () => {
  async function setup() {
    const fixture = await render(ToggleHost);
    return {
      fixture,
      element: fixture.nativeElement as HTMLElement,
      host: fixture.componentInstance,
    };
  }

  it('is a real switch with its label and hint', async () => {
    const { element } = await setup();

    const toggle = getByRole(element, 'switch', 'Incremental') as HTMLInputElement;
    expect(toggle.type).toBe('checkbox');
    expect(toggle.checked).toBe(false);
    const hint = element.querySelector(`#${toggle.getAttribute('aria-describedby')}`);
    expect(hint?.textContent?.trim()).toBe('Leftovers carry over.');
  });

  it('writes to the control when toggled, by clicking its label text', async () => {
    const { fixture, element, host } = await setup();

    getByText(element, 'Incremental').click();
    await settle(fixture);
    expect(host.incremental.value).toBe(true);
    expect((getByRole(element, 'switch') as HTMLInputElement).checked).toBe(true);

    getByText(element, 'Incremental').click();
    await settle(fixture);
    expect(host.incremental.value).toBe(false);
  });

  it('shows the state of the control, including a change made in code', async () => {
    const { fixture, element, host } = await setup();

    host.incremental.setValue(true);
    await settle(fixture);

    expect((getByRole(element, 'switch') as HTMLInputElement).checked).toBe(true);
    // The knob carries a check mark too: the state is not only a color.
    expect(element.querySelector('span[aria-hidden="true"] span')?.textContent?.trim()).toBe('✓');
  });

  it('can be disabled', async () => {
    const { fixture, element, host } = await setup();
    host.incremental.disable();
    await settle(fixture);
    expect((getByRole(element, 'switch') as HTMLInputElement).disabled).toBe(true);
  });

  it('works without a form too, two-way, for a choice that lives in a signal', async () => {
    const { fixture, element, host } = await setup();
    const header = () => getByLabel(element, 'First row is a header');
    expect(header().checked).toBe(true);

    header().click();
    await settle(fixture);
    expect(host.header()).toBe(false);

    host.header.set(true);
    await settle(fixture);
    expect(header().checked).toBe(true);
  });

  it('can be a plain checkbox', async () => {
    const { fixture, element, host } = await setup();
    const checkbox = getByLabel(element, 'I agree');
    expect(checkbox.getAttribute('role')).toBeNull();
    expect(checkbox.checked).toBe(true);

    checkbox.click();
    await settle(fixture);
    expect(host.agree.value).toBe(false);
  });
});
