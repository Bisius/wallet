import { Component } from '@angular/core';
import { textOf } from '../../../testing/dom';
import { render } from '../../../testing/harness';
import { TagChip } from './tag-chip';

@Component({
  selector: 'app-tag-chip-host',
  imports: [TagChip],
  template: `
    <app-tag-chip name="Groceries" color="#15803d" />
    <app-tag-chip name="Travel" />
    <app-tag-chip name="Holiday" size="md"><button type="button">Remove</button></app-tag-chip>
    <app-tag-chip name="Groceries budget" mode="color" color="#15803d" />
    <app-tag-chip name="Budget without a color" mode="color" />
  `,
})
class Host {}

describe('TagChip', () => {
  async function setup() {
    const fixture = await render(Host);
    const chips = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('app-tag-chip'),
    );
    return chips as HTMLElement[];
  }

  it('shows the name, which is what tells tags apart', async () => {
    const [groceries, travel] = await setup();
    expect(textOf(groceries)).toBe('Groceries');
    expect(textOf(travel)).toBe('Travel');
  });

  it('marks a tag that has a color with a dot in it, hidden from assistive technology', async () => {
    const [groceries] = await setup();

    const dot = groceries.querySelector<HTMLElement>('span[aria-hidden="true"]');
    expect(dot).not.toBeNull();
    expect(dot?.style.backgroundColor).toBe('rgb(21, 128, 61)');
    // The dot has a ring, so it shows on a light and on a dark surface alike.
    expect(dot?.className).toContain('ring-line-strong');
    expect(groceries.querySelector('svg')).toBeNull();
  });

  it('marks a tag without a color with the tag icon instead of leaving it bare', async () => {
    const [, travel] = await setup();

    expect(travel.querySelector('span[aria-hidden="true"].rounded-full')).toBeNull();
    expect(travel.querySelector('svg')).not.toBeNull();
  });

  it('has room for what is put inside it, after the name, and a bigger size for it', async () => {
    const [, , holiday] = await setup();

    expect(textOf(holiday)).toBe('Holiday Remove');
    expect(holiday.querySelector('span')?.className).toContain('text-sm');
  });

  it('uses the colors of the theme for its text and its outline, never a fixed one', async () => {
    const [groceries] = await setup();
    const pill = groceries.querySelector('span') as HTMLElement;
    expect(pill.className).toContain('text-ink');
    expect(pill.className).toContain('bg-surface');
    expect(pill.className).toContain('border-line-strong');
  });

  it('in the color mode is a label with a dot for its color, as a budget has one', async () => {
    const [, , , budget] = await setup();

    expect(textOf(budget)).toBe('Groceries budget');
    const dot = budget.querySelector<HTMLElement>('span[aria-hidden="true"]');
    expect(dot?.style.backgroundColor).toBe('rgb(21, 128, 61)');
    expect(budget.querySelector('svg')).toBeNull();
  });

  it('in the color mode has no marker at all without a color, where a tag has the tag icon', async () => {
    const [, travel, , , plain] = await setup();

    expect(textOf(plain)).toBe('Budget without a color');
    expect(plain.querySelector('svg')).toBeNull();
    expect(plain.querySelector('span[aria-hidden="true"]')).toBeNull();
    expect(travel.querySelector('svg')).not.toBeNull();
  });
});
