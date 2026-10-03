import { Component } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { getByLabel, getByRole, queryAllByRole } from '../../../testing/dom';
import { render, settle } from '../../../testing/harness';
import { COLOR_SWATCHES, ColorPicker } from './color-picker';

@Component({
  selector: 'app-color-host',
  imports: [ReactiveFormsModule, ColorPicker],
  template: `<form><app-color-picker [formControl]="color" /></form>`,
})
class ColorHost {
  readonly color = new FormControl<string | null>(null);
}

describe('ColorPicker', () => {
  async function setup(initial: string | null = null) {
    const fixture = await render(ColorHost);
    const host = fixture.componentInstance;
    host.color.setValue(initial);
    await settle(fixture);
    const element = fixture.nativeElement as HTMLElement;
    const radio = (name: string) => getByLabel(element, name) as HTMLInputElement;
    return { fixture, host, element, radio };
  }

  it('is a group named Color, with None and every swatch as a radio button', async () => {
    const { element } = await setup();

    expect(getByRole(element, 'group', 'Color (optional)')).toBeTruthy();
    const names = queryAllByRole(element, 'radio').map((radio) =>
      (radio.closest('label')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
    expect(names).toEqual(['None', ...COLOR_SWATCHES.map((swatch) => swatch.name)]);
  });

  it('starts on None: no color', async () => {
    const { radio } = await setup();

    expect(radio('None').checked).toBe(true);
    expect(radio('Blue').checked).toBe(false);
  });

  it('puts the chosen color into the control, and None clears it', async () => {
    const { host, fixture, radio } = await setup();

    radio('Pink').click();
    await settle(fixture);
    expect(host.color.value).toBe('#be185d');
    expect(radio('Pink').checked).toBe(true);

    radio('None').click();
    await settle(fixture);
    expect(host.color.value).toBeNull();
    expect(radio('None').checked).toBe(true);
  });

  it('shows the color the control already holds', async () => {
    const { radio } = await setup('#2563EB');

    expect(radio('Blue').checked).toBe(true);
    expect(radio('None').checked).toBe(false);
  });

  it('keeps a color that is not on offer, as one more swatch', async () => {
    const { element, radio } = await setup('#123456');

    expect(queryAllByRole(element, 'radio')).toHaveLength(COLOR_SWATCHES.length + 2);
    expect(radio('Custom #123456').checked).toBe(true);
  });

  it('marks the selected swatch with a check mark, not only a ring', async () => {
    const { element, host, fixture, radio } = await setup();
    expect(element.querySelectorAll('svg').length).toBe(1); // the check of "None"

    radio('Teal').click();
    await settle(fixture);

    const labelOfTeal = radio('Teal').closest('label') as HTMLElement;
    expect(labelOfTeal.querySelector('svg')).not.toBeNull();
    expect(host.color.value).toBe('#0e7490');
  });

  it('moves as one group for the keyboard: the radios share a name', async () => {
    const { element } = await setup();
    const names = new Set(
      queryAllByRole(element, 'radio').map((r) => (r as HTMLInputElement).name),
    );

    expect(names.size).toBe(1);
  });

  it('can be disabled', async () => {
    const { host, fixture, radio } = await setup();
    host.color.disable();
    await settle(fixture);

    expect(radio('Blue').disabled).toBe(true);
  });
});
