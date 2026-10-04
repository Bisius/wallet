import { Component } from '@angular/core';
import { a11yProblems } from '../../../testing/a11y';
import { render } from '../../../testing/harness';
import { ColorDot } from './color-dot';

@Component({
  selector: 'app-dot-host',
  imports: [ColorDot],
  template: `
    <p>
      <span appColorDot color="#3b82f6" id="blue"></span>
      Groceries
    </p>
    <p>
      <span appColorDot id="none"></span>
      Rent
    </p>
  `,
})
class DotHost {}

describe('ColorDot', () => {
  async function setup() {
    const fixture = await render(DotHost);
    const element = fixture.nativeElement as HTMLElement;
    return {
      element,
      blue: element.querySelector('#blue') as HTMLElement,
      none: element.querySelector('#none') as HTMLElement,
    };
  }

  it('is a dot of the colour it is given', async () => {
    const { blue } = await setup();
    expect(blue.style.backgroundColor).toBe('rgb(59, 130, 246)');
    expect(blue.classList).toContain('rounded-full');
  });

  it('is a neutral dot, in the color of the lines, when there is no colour', async () => {
    const { none } = await setup();
    expect(none.style.backgroundColor).toBe('');
    expect(none.classList).toContain('bg-line-strong');
  });

  it('is for the eye only', async () => {
    const { blue, none, element } = await setup();
    expect(blue.getAttribute('aria-hidden')).toBe('true');
    expect(none.getAttribute('aria-hidden')).toBe('true');
    expect(a11yProblems(element)).toEqual([]);
  });
});
