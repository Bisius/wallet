import { Component } from '@angular/core';
import { a11yProblems } from '../../../testing/a11y';
import { render } from '../../../testing/harness';
import { ICON_NAMES, Icon, type IconName } from './icon';

@Component({
  selector: 'app-icons-host',
  imports: [Icon],
  template: `
    @for (name of names; track name) {
      <span [attr.data-icon]="name"><app-icon [name]="name" /></span>
    }
  `,
})
class IconsHost {
  readonly names = ICON_NAMES;
}

const NAVIGATION: readonly IconName[] = [
  'dashboard',
  'budgets',
  'spendings',
  'subscriptions',
  'income',
  'savings',
  'report',
  'settings',
];

const CONTROLS: readonly IconName[] = [
  'more-horizontal',
  'arrow-right',
  'search',
  'filter',
  'chevron-up',
  'circle-help',
  'menu',
  'calendar',
];

describe('Icon', () => {
  async function setup() {
    const fixture = await render(IconsHost);
    const element = fixture.nativeElement as HTMLElement;
    const iconOf = (name: IconName) =>
      element.querySelector(`[data-icon="${name}"] svg`) as SVGElement | null;
    return { element, iconOf };
  }

  it('has the icons of every page of the app and the controls the shell needs', () => {
    for (const name of [...NAVIGATION, ...CONTROLS]) {
      expect(ICON_NAMES, name).toContain(name);
    }
  });

  it('renders every icon as an svg with a drawing', async () => {
    const { iconOf } = await setup();

    for (const name of ICON_NAMES) {
      const svg = iconOf(name);
      expect(svg, `${name} has an svg`).not.toBeNull();
      const path = svg?.querySelector('path')?.getAttribute('d') ?? '';
      expect(path.trim(), `${name} has a path`).not.toBe('');
      expect(path, `${name} starts with a move`).toMatch(/^[Mm]/);
    }
  });

  it('draws no two icons alike, so each name means something else', async () => {
    const { iconOf } = await setup();

    const names = new Map<string, IconName>();
    for (const name of ICON_NAMES) {
      const path = iconOf(name)?.querySelector('path')?.getAttribute('d') ?? '';
      expect(names.get(path), `${name} repeats ${names.get(path)}`).toBeUndefined();
      names.set(path, name);
    }
  });

  it('is decoration: hidden from assistive technology and out of the tab order', async () => {
    const { element, iconOf } = await setup();

    for (const name of ICON_NAMES) {
      expect(iconOf(name)?.getAttribute('aria-hidden'), name).toBe('true');
      expect(iconOf(name)?.getAttribute('focusable'), name).toBe('false');
    }
    expect(a11yProblems(element)).toEqual([]);
  });
});
