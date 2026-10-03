import { accessibleName } from './dom';

/**
 * A few of the checks of axe that need no layout, so they run in jsdom: what a screen reader needs to
 * make sense of the markup. They do not replace running axe in a real browser (contrast, focus order
 * and visibility need one), but they keep the cheap mistakes out: a control without a name, an
 * `aria-*` attribute that points at nothing, a duplicate id, a combobox without its listbox.
 *
 * Returns one line per problem, so a spec can say `expect(a11yProblems(element)).toEqual([])`.
 */
export function a11yProblems(root: HTMLElement): string[] {
  const problems: string[] = [];
  const doc = root.ownerDocument;
  // A dialog that is not open is not in the page for anyone: leave it and what is in it alone.
  const all = <T extends Element = Element>(selector: string): T[] =>
    Array.from(root.querySelectorAll<T>(selector)).filter(
      (element) => element.closest('dialog:not([open])') === null,
    );
  const describe = (element: Element) => {
    const id = element.id ? `#${element.id}` : '';
    const role = element.getAttribute('role');
    return `<${element.tagName.toLowerCase()}${id}${role ? ` role=${role}` : ''}>`;
  };

  // Ids are unique.
  const seen = new Map<string, number>();
  for (const element of all('[id]')) {
    seen.set(element.id, (seen.get(element.id) ?? 0) + 1);
  }
  for (const [id, count] of seen) {
    if (count > 1) problems.push(`The id "${id}" is used ${count} times`);
  }

  // What an aria attribute points at exists.
  const references = [
    'aria-labelledby',
    'aria-describedby',
    'aria-controls',
    'aria-activedescendant',
  ];
  for (const element of all('*')) {
    for (const attribute of references) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      if (value.trim() === '') problems.push(`${describe(element)} has an empty ${attribute}`);
      for (const id of value.split(/\s+/).filter(Boolean)) {
        if (!doc.getElementById(id)) {
          problems.push(`${describe(element)} ${attribute} points at "${id}", which is not there`);
        }
      }
    }
  }
  for (const label of all('label[for]')) {
    const target = doc.getElementById(label.getAttribute('for') ?? '');
    if (!target)
      problems.push(`A label points at "${label.getAttribute('for')}", which is not there`);
  }

  // Every control and button has a name.
  for (const control of all<HTMLElement>('input, select, textarea')) {
    if (control.getAttribute('type') === 'hidden') continue;
    if (control.closest('[aria-hidden="true"]')) continue;
    if (accessibleName(control) === '') problems.push(`${describe(control)} has no name`);
  }
  for (const button of all<HTMLElement>('button, [role="button"]')) {
    if (button.closest('[aria-hidden="true"]')) continue;
    if (accessibleName(button) === '') problems.push(`${describe(button)} has no name`);
  }

  // Dialogs, lists and regions that are named by role need a name.
  for (const named of all<HTMLElement>(
    'dialog, [role="listbox"], [role="search"], [role="radiogroup"]',
  )) {
    if (accessibleName(named) === '') problems.push(`${describe(named)} has no name`);
  }

  // The combobox pattern is complete.
  for (const combobox of all<HTMLElement>('[role="combobox"]')) {
    if (!combobox.hasAttribute('aria-expanded'))
      problems.push(`${describe(combobox)} has no aria-expanded`);
    const controls = combobox.getAttribute('aria-controls');
    const listbox = controls ? doc.getElementById(controls) : null;
    if (listbox?.getAttribute('role') !== 'listbox') {
      problems.push(`${describe(combobox)} does not control a listbox`);
    }
  }
  for (const option of all<HTMLElement>('[role="option"]')) {
    if (!option.closest('[role="listbox"]'))
      problems.push(`${describe(option)} is not in a listbox`);
  }

  // Nothing that can be focused hides from assistive technology.
  for (const hidden of all('[aria-hidden="true"]')) {
    const focusable = hidden.querySelector(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusable)
      problems.push(`${describe(hidden)} is aria-hidden but holds ${describe(focusable)}`);
  }

  // Pictures are decoration or named.
  for (const svg of all('svg')) {
    if (svg.closest('[aria-hidden="true"]') || svg.getAttribute('aria-hidden') === 'true') continue;
    if (!svg.getAttribute('aria-label') && svg.getAttribute('role') !== 'img') {
      problems.push('An svg is neither hidden nor named');
    }
  }

  // Headings are not empty, and no tabindex jumps the order.
  for (const heading of all('h1, h2, h3, h4, h5, h6')) {
    if ((heading.textContent ?? '').trim() === '') problems.push(`${describe(heading)} is empty`);
  }
  for (const element of all('[tabindex]')) {
    if (Number(element.getAttribute('tabindex')) > 0) {
      problems.push(`${describe(element)} has a positive tabindex`);
    }
  }

  return problems;
}
