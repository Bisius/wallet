import { Component, signal } from '@angular/core';
import { getByRole } from '../../../testing/dom';
import { render, settle } from '../../../testing/harness';
import { Button } from './button';

@Component({
  selector: 'app-button-host',
  imports: [Button],
  template: `
    <form (submit)="$event.preventDefault(); submits.set(submits() + 1)">
      <button appButton>Plain</button>
      <button appButton type="submit">Send</button>
      <button appButton variant="danger">Delete</button>
      <button appButton variant="secondary" size="sm">Cancel</button>
      <button appButton [loading]="loading()">Save</button>
      <button appButton [disabled]="true">Locked</button>
    </form>
  `,
})
class ButtonHost {
  readonly loading = signal(false);
  readonly submits = signal(0);
}

describe('Button', () => {
  it('is type="button" unless told otherwise, so it never submits a form by accident', async () => {
    const fixture = await render(ButtonHost);
    const element = fixture.nativeElement as HTMLElement;

    expect(getByRole(element, 'button', 'Plain').getAttribute('type')).toBe('button');
    expect(getByRole(element, 'button', 'Send').getAttribute('type')).toBe('submit');

    getByRole(element, 'button', 'Plain').click();
    expect(fixture.componentInstance.submits()).toBe(0);
    getByRole(element, 'button', 'Send').click();
    expect(fixture.componentInstance.submits()).toBe(1);
  });

  it('has a variant per purpose', async () => {
    const fixture = await render(ButtonHost);
    const element = fixture.nativeElement as HTMLElement;

    expect(getByRole(element, 'button', 'Plain').className).toContain('bg-accent');
    expect(getByRole(element, 'button', 'Delete').className).toContain('bg-negative');
    expect(getByRole(element, 'button', 'Cancel').className).toContain('border-line-strong');
  });

  it('shows a spinner, disables itself and says it is busy while loading', async () => {
    const fixture = await render(ButtonHost);
    const save = getByRole(fixture.nativeElement, 'button', 'Save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    expect(save.getAttribute('aria-busy')).toBeNull();

    fixture.componentInstance.loading.set(true);
    await settle(fixture);

    expect(save.disabled).toBe(true);
    expect(save.getAttribute('aria-busy')).toBe('true');
    expect(save.querySelector('span[aria-hidden="true"]')).not.toBeNull();
  });

  it('can be disabled', async () => {
    const fixture = await render(ButtonHost);
    const locked = getByRole(fixture.nativeElement, 'button', 'Locked') as HTMLButtonElement;
    expect(locked.disabled).toBe(true);
  });
});
