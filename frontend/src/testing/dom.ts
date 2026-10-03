/**
 * Queries that find things the way a person (or a screen reader) does: by role and accessible name,
 * by label, by visible text. A control that is missing its label is not found, so a test using these
 * also checks the markup is accessible.
 */

const ROLE_SELECTORS: Record<string, string> = {
  button: 'button, [role="button"], input[type="button"], input[type="submit"]',
  link: 'a[href], [role="link"]',
  heading: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
  textbox:
    'input:not([type]), input[type="text"], input[type="email"], input[type="search"], textarea, [role="textbox"]',
  spinbutton: 'input[type="number"]',
  switch: '[role="switch"]',
  checkbox: 'input[type="checkbox"]:not([role="switch"]), [role="checkbox"]',
  combobox: 'select, [role="combobox"]',
  dialog: 'dialog, [role="dialog"]',
  alert: '[role="alert"]',
  status: '[role="status"]',
  group: '[role="group"], fieldset',
  list: 'ul, ol, [role="list"]',
  listitem: 'li, [role="listitem"]',
  navigation: 'nav, [role="navigation"]',
  main: 'main, [role="main"]',
  region: 'section[aria-label], section[aria-labelledby], [role="region"]',
  article: 'article, [role="article"]',
  radio: 'input[type="radio"], [role="radio"]',
  progressbar: '[role="progressbar"]',
  figure: 'figure, [role="figure"]',
  table: 'table, [role="table"]',
  img: 'img, [role="img"]',
  columnheader: 'th[scope="col"], [role="columnheader"]',
  rowheader: 'th[scope="row"], [role="rowheader"]',
};

type Matcher = string | RegExp;

function matches(actual: string, expected: Matcher): boolean {
  return typeof expected === 'string' ? actual === expected : expected.test(actual);
}

/** Text with whitespace collapsed, as a reader would take it in. Hidden-from-AT content is left out. */
export function textOf(element: Element): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '');
    } else if (node instanceof Element && node.getAttribute('aria-hidden') !== 'true') {
      node.childNodes.forEach(walk);
    }
  };
  walk(element);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** The accessible name: `aria-label`, `aria-labelledby`, an associated `<label>`, then the content. */
export function accessibleName(element: Element): string {
  const label = element.getAttribute('aria-label');
  if (label !== null) return label.trim();

  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const root = element.getRootNode() as Document | ShadowRoot;
    return labelledBy
      .split(/\s+/)
      .map((id) => root.getElementById(id))
      .filter((target): target is HTMLElement => target !== null)
      .map(textOf)
      .join(' ');
  }

  const id = element.getAttribute('id');
  if (id && /^(INPUT|SELECT|TEXTAREA)$/.test(element.tagName)) {
    const root = element.getRootNode() as Document | ShadowRoot;
    const forLabel = Array.from(root.querySelectorAll('label')).find((l) => l.htmlFor === id);
    if (forLabel) return textOf(forLabel);
  }
  if (element.tagName === 'FIELDSET') {
    const legend = element.querySelector(':scope > legend');
    if (legend) return textOf(legend);
  }
  if (element.tagName === 'TABLE') {
    const caption = element.querySelector(':scope > caption');
    if (caption) return textOf(caption);
  }

  const wrapping = element.closest('label');
  if (wrapping && /^(INPUT|SELECT|TEXTAREA)$/.test(element.tagName)) return textOf(wrapping);

  return textOf(element);
}

export function queryAllByRole(root: ParentNode, role: string, name?: Matcher): HTMLElement[] {
  const selector = ROLE_SELECTORS[role] ?? `[role="${role}"]`;
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((element) => {
    // An element with an explicit role is only of that role.
    const explicit = element.getAttribute('role');
    if (explicit && explicit !== role && ROLE_SELECTORS[role] !== undefined) {
      if (!ROLE_SELECTORS[role].includes(`[role="${explicit}"]`)) return false;
    }
    return name === undefined || matches(accessibleName(element), name);
  });
}

export function getByRole(root: ParentNode, role: string, name?: Matcher): HTMLElement {
  const found = queryAllByRole(root, role, name);
  if (found.length !== 1) {
    const available = queryAllByRole(root, role).map((e) => `"${accessibleName(e)}"`);
    throw new Error(
      `Expected one ${role}${name === undefined ? '' : ` named ${String(name)}`}, found ${found.length}. ` +
        `All ${role}s: ${available.join(', ') || '(none)'}`,
    );
  }
  return found[0];
}

export function queryByRole(root: ParentNode, role: string, name?: Matcher): HTMLElement | null {
  return queryAllByRole(root, role, name)[0] ?? null;
}

/** The form control labelled `label` (by `<label for>`, a wrapping label, or `aria-label`). */
export function getByLabel<T extends HTMLElement = HTMLInputElement>(
  root: ParentNode,
  label: Matcher,
): T {
  const controls = Array.from(
    root.querySelectorAll<HTMLElement>('input, select, textarea, [role="switch"]'),
  ).filter((control) => matches(accessibleName(control), label));
  if (controls.length !== 1) {
    throw new Error(`Expected one control labelled ${String(label)}, found ${controls.length}`);
  }
  return controls[0] as T;
}

/** Every form control labelled `label` (a form can repeat a label, for example one per row). */
export function getAllByLabel<T extends HTMLElement = HTMLInputElement>(
  root: ParentNode,
  label: Matcher,
): T[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('input, select, textarea, [role="switch"]'),
  ).filter((control) => matches(accessibleName(control), label)) as T[];
}

/** The smallest element whose own text matches. */
export function getByText(root: ParentNode, text: Matcher): HTMLElement {
  const found = Array.from(root.querySelectorAll<HTMLElement>('*')).filter((element) => {
    const own = Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return own !== '' && matches(own, text);
  });
  if (found.length !== 1) {
    throw new Error(`Expected one element with text ${String(text)}, found ${found.length}`);
  }
  return found[0];
}

export function queryByText(root: ParentNode, text: Matcher): HTMLElement | null {
  try {
    return getByText(root, text);
  } catch {
    return null;
  }
}

/** Types into a control the way the browser reports it: sets the value and fires `input`. */
export function typeInto(
  control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  control.focus();
  control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

export function blur(control: HTMLElement): void {
  control.dispatchEvent(new Event('blur'));
  control.blur();
}

export function click(element: HTMLElement): void {
  element.click();
}

/** The message currently shown for a field, from its `aria-live` error region (empty when none). */
export function fieldError(control: HTMLElement): string {
  const ids = (control.getAttribute('aria-describedby') ?? '').split(/\s+/);
  const root = control.getRootNode() as Document | ShadowRoot;
  const region = ids
    .map((id) => root.getElementById(id))
    .find((element) => element?.getAttribute('aria-live') === 'polite');
  return region ? textOf(region) : '';
}
