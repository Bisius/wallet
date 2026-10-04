import { type Locator, type Page, expect } from '@playwright/test';

/*
 * Layout checks for a phone-sized page, measured in the browser. Used by `tests/mobile.spec.ts`.
 *
 * They answer the questions that axe does not: does the page scroll sideways, is something that a
 * user is meant to press or read pushed outside the screen or cut off, and are the controls big
 * enough to hit. Every function reports what it found as plain strings, each naming the element (tag,
 * id, classes, the text it holds) and the numbers, so a failure points at the culprit.
 *
 * The measurements need the layout viewport of a real phone: `isMobile: true` in the browser context,
 * because plain width emulation lets Chromium hide an overflow by not widening the viewport.
 */

/** The smallest a pointer target may be at WCAG 2.2 level AA (2.5.8 Target Size, Minimum), in CSS px. */
export const MIN_TARGET_PX = 24;

export interface Viewport {
  /** `document.documentElement.clientWidth`: the layout width that content has to fit. */
  clientWidth: number;
  /** `window.innerWidth`: grows past the device width when Chromium widens a mobile viewport. */
  innerWidth: number;
  innerHeight: number;
  /** `document.documentElement.scrollWidth`: how wide the content really is. */
  scrollWidth: number;
}

export interface LayoutReport {
  viewport: Viewport;
  /** Elements that push the page wider than the screen, widest first. Empty when it fits. */
  overflow: string[];
  /** Controls that cannot be reached: outside the screen, and not inside a region that scrolls to them. */
  unreachable: string[];
  /** Controls smaller than 24 x 24 CSS px. */
  smallTargets: string[];
  /** Money amounts that are cut off by their own box or by a parent that clips. */
  clippedAmounts: string[];
  /** Other text that a parent clips (not an ellipsis, which is a deliberate cut). */
  clippedText: string[];
  /** Text shortened with an ellipsis: informational, a user may not be able to read all of it. */
  truncatedText: string[];
}

/** Measures the page as it is now. The function runs in the page: it may not use anything outside it. */
export async function measureLayout(page: Page): Promise<LayoutReport> {
  const deviceWidth = page.viewportSize()?.width;
  if (deviceWidth === undefined) throw new Error('measureLayout needs a page with a viewport');
  return page.evaluate(
    ({ minTarget, deviceWidth }): LayoutReport => {
      const doc = document.documentElement;
      const viewport: Viewport = {
        clientWidth: doc.clientWidth,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollWidth: doc.scrollWidth,
      };
      // The width of the screen, not of the layout viewport: Chromium widens that one to fit content.
      const vw = deviceWidth;
      const EPS = 0.75;

      const describe = (element: Element): string => {
        const id = element.id ? `#${element.id}` : '';
        const classes = [...element.classList].slice(0, 4).join('.');
        const label =
          element.getAttribute('aria-label') ??
          (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 50);
        return `<${element.tagName.toLowerCase()}${id}${classes ? '.' + classes : ''}> "${label}"`;
      };
      const rounded = (n: number) => Math.round(n * 10) / 10;

      /** Rendered, with a box. `sr-only` boxes (1 x 1) are not "on screen" for this purpose. */
      const isShown = (element: Element): boolean => {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
        const box = element.getBoundingClientRect();
        return box.width > 1.5 && box.height > 1.5;
      };
      const inClosedDetails = (element: Element): boolean => {
        for (let node = element.parentElement; node; node = node.parentElement) {
          if (node instanceof HTMLDetailsElement && !node.open) {
            // The summary itself is shown; what is inside is not.
            return !(element instanceof HTMLElement && element.tagName === 'SUMMARY');
          }
        }
        return false;
      };
      const inInertTree = (element: Element): boolean => element.closest('[inert]') !== null;
      /** Inside a box that is there for screen readers only (`sr-only`: 1 x 1 px, clipped). */
      const inScreenReaderOnly = (element: Element): boolean => {
        for (let node: Element | null = element; node; node = node.parentElement) {
          const box = node.getBoundingClientRect();
          if (
            box.width <= 1.5 &&
            box.height <= 1.5 &&
            getComputedStyle(node).overflow !== 'visible'
          ) {
            return true;
          }
        }
        return false;
      };

      /** The nearest ancestor that scrolls sideways, or clips sideways. */
      const clipper = (element: Element): Element | null => {
        for (let node = element.parentElement; node; node = node.parentElement) {
          const x = getComputedStyle(node).overflowX;
          if (x === 'auto' || x === 'scroll' || x === 'hidden' || x === 'clip') return node;
        }
        return null;
      };
      const scrolls = (node: Element): boolean => {
        const x = getComputedStyle(node).overflowX;
        return x === 'auto' || x === 'scroll';
      };

      // --- 1. What makes the page wider than the screen.
      const overflow: string[] = [];
      if (viewport.scrollWidth > vw + EPS || viewport.innerWidth > vw + EPS) {
        const found: { element: Element; right: number; text: string }[] = [];
        for (const element of document.body.querySelectorAll('*')) {
          const box = element.getBoundingClientRect();
          if (box.width === 0 || box.right <= vw + EPS) continue;
          if (getComputedStyle(element).position === 'fixed') continue;
          if (inScreenReaderOnly(element)) continue;
          // A box that sticks out but sits inside a scroller or clipper that fits is not the cause.
          const parent = clipper(element);
          if (parent && parent.getBoundingClientRect().right <= vw + EPS) continue;
          found.push({
            element,
            right: box.right,
            text: `${describe(element)} right=${rounded(box.right)} width=${rounded(box.width)}`,
          });
        }
        found.sort((a, b) => b.right - a.right);
        // The outermost ones are only containers that grew to fit something. The cause is the deepest:
        // an element that sticks out and has no descendant that does.
        const deepest = found.filter(
          (item) => !found.some((other) => other !== item && item.element.contains(other.element)),
        );
        overflow.push(
          `page is ${viewport.scrollWidth}px wide on a ${vw}px screen (clientWidth ${viewport.clientWidth}, window.innerWidth ${viewport.innerWidth})`,
          ...found.slice(0, 2).map((item) => `outermost: ${item.text}`),
          ...deepest.slice(0, 6).map((item) => `deepest: ${item.text}`),
        );
      }

      // --- 2. Controls: reachable, and big enough.
      const controls = document.body.querySelectorAll(
        'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="switch"], [role="tab"], [tabindex]:not([tabindex="-1"])',
      );
      const unreachable: string[] = [];
      const smallTargets: string[] = [];
      for (const control of controls) {
        if (!isShown(control) || inClosedDetails(control) || inInertTree(control)) continue;
        if (inScreenReaderOnly(control)) continue;
        if (
          control.matches('input, select, textarea') &&
          control.getAttribute('type') === 'hidden'
        ) {
          continue;
        }
        const box = control.getBoundingClientRect();
        const horizontallyOut = box.left < -EPS || box.right > vw + EPS;
        if (horizontallyOut) {
          // Fine when a region that scrolls sideways (a strip of links, a table) takes the user there.
          const holder = clipper(control);
          if (holder && scrolls(holder) && holder.getBoundingClientRect().right <= vw + EPS) {
            const before = holder.scrollLeft;
            control.scrollIntoView({ inline: 'nearest', block: 'nearest' });
            const after = control.getBoundingClientRect();
            const reachable = after.left >= -EPS && after.right <= vw + EPS;
            holder.scrollLeft = before;
            if (!reachable) {
              unreachable.push(`${describe(control)} stays outside the screen when scrolled to`);
            }
          } else {
            unreachable.push(
              `${describe(control)} left=${rounded(box.left)} right=${rounded(box.right)} (screen is ${vw}px)`,
            );
          }
        }
        // WCAG 2.5.8: 24 x 24 CSS px, except a link inside a sentence.
        const isInlineLink =
          control.tagName === 'A' &&
          getComputedStyle(control).display === 'inline' &&
          (control.parentElement?.textContent ?? '').trim().length >
            (control.textContent ?? '').trim().length + 3;
        if (!isInlineLink && (box.width < minTarget - EPS || box.height < minTarget - EPS)) {
          smallTargets.push(
            `${describe(control)} is ${rounded(box.width)} x ${rounded(box.height)}`,
          );
        }
      }

      // --- 3. Text that is cut off. Walk every text node and compare its box with what clips it.
      const MONEY = /[-+−]?\s?(?:[€$£¥]|EUR|USD)\s?[-+−]?\d[\d.,   ]*|\d[\d.,]*\s?(?:€|EUR)/;
      const clippedAmounts: string[] = [];
      const clippedText: string[] = [];
      const truncatedText: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        if (text.trim() === '') continue;
        const owner = node.parentElement;
        if (!owner || owner.closest('script, style, noscript') || !isShown(owner)) continue;
        if (inClosedDetails(owner) || inInertTree(owner) || inScreenReaderOnly(owner)) continue;
        range.selectNodeContents(node);
        const box = range.getBoundingClientRect();
        if (box.width === 0) continue;
        const isAmount = MONEY.test(text);

        for (
          let holder: Element | null = owner;
          holder && holder !== doc;
          holder = holder.parentElement
        ) {
          const style = getComputedStyle(holder);
          const x = style.overflowX;
          if (x !== 'hidden' && x !== 'clip') continue;
          const holderBox = holder.getBoundingClientRect();
          const cut = box.right > holderBox.right + 1 || box.left < holderBox.left - 1;
          if (!cut) continue;
          const note = `${describe(owner)} text spans ${rounded(box.left)}..${rounded(box.right)}, ${describe(holder)} clips at ${rounded(holderBox.left)}..${rounded(holderBox.right)}`;
          if (isAmount) clippedAmounts.push(note);
          else if (style.textOverflow === 'ellipsis') truncatedText.push(note);
          else clippedText.push(note);
          break;
        }

        // Text that runs out of the screen sideways inside a box that does not clip it.
        if (isAmount && box.right > vw + 1) {
          const holder = clipper(owner);
          const contained =
            holder && scrolls(holder) && holder.getBoundingClientRect().right <= vw + EPS;
          if (!contained) {
            clippedAmounts.push(
              `${describe(owner)} text ends at ${rounded(box.right)}, beyond the ${vw}px screen`,
            );
          }
        }
      }

      return {
        viewport,
        overflow,
        unreachable,
        smallTargets,
        clippedAmounts,
        clippedText,
        truncatedText,
      };
    },
    { minTarget: MIN_TARGET_PX, deviceWidth },
  );
}

/** What the fixed bars of a phone leave of the page: see `measureBars`. */
export interface BarsReport {
  /** The sticky top bar: how tall it is (0 when there is none). */
  topBarHeight: number;
  /** Where it is with the page scrolled to its end: 0 when it sticks to the top, as it should. null when the page does not scroll. */
  topBarTopWhenScrolled: number | null;
  /** The tab bar fixed to the bottom of the window, when the page has one. */
  tabBar: { top: number; height: number } | null;
  /** The floating "Add spending" button over it, when the page has one. */
  fab: { top: number; height: number } | null;
  /** Content that is under a fixed bar when the page is scrolled to its end. Empty when it all clears them. */
  covered: string[];
}

/**
 * How the fixed bars of a phone sit on the page: the sticky top bar, the tab bar fixed to the bottom
 * and the floating button over it. The bars are fixed, so the layout checks above skip them (they do
 * not make the page wider, and they are always on screen), but a fixed bar can hide what scrolls under
 * it. This scrolls to the very end of the page, finds the lowest content (what is in `main`, not the
 * bars) and says what is under a bar. It puts the scroll position back.
 *
 * Content that is only a box (a card's bottom edge, padding) is content too: the page has to leave room
 * under the last thing a user can read or press, with the floating button's corner included.
 */
export async function measureBars(page: Page): Promise<BarsReport> {
  return page.evaluate(async (): Promise<BarsReport> => {
    const rect = (element: Element | null) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.display === 'none' || box.width < 1.5 || box.height < 1.5) return null;
      return { top: box.top, height: box.height };
    };
    const header = document.querySelector('header');
    const tabs = rect(document.querySelector('nav[aria-label="Main (tabs)"]'));
    const fab = rect(document.querySelector('app-add-spending-fab button'));
    const main = document.querySelector('main');
    const covered: string[] = [];
    const describe = (element: Element): string => {
      const classes = [...element.classList].slice(0, 3).join('.');
      const label = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      return `<${element.tagName.toLowerCase()}${classes ? '.' + classes : ''}> "${label}"`;
    };

    const before = { x: window.scrollX, y: window.scrollY };
    window.scrollTo({ left: 0, top: document.documentElement.scrollHeight, behavior: 'instant' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    if (main && (tabs || fab)) {
      let lowest = { bottom: -Infinity, element: main as Element };
      for (const element of main.querySelectorAll('*')) {
        const style = getComputedStyle(element);
        if (
          style.position === 'fixed' ||
          style.display === 'none' ||
          style.visibility === 'hidden'
        ) {
          continue;
        }
        if (element.closest('[inert]') || element.closest('app-add-spending-fab')) continue;
        const box = element.getBoundingClientRect();
        if (box.width <= 1.5 || box.height <= 1.5) continue;
        // What is inside a box for a screen reader only (`sr-only`: 1 x 1 px, clipped, like the table
        // that stands for a chart) is not content that a person reads.
        let hidden = false;
        for (let node: Element | null = element; node && node !== main; node = node.parentElement) {
          const nodeBox = node.getBoundingClientRect();
          if (
            nodeBox.width <= 1.5 &&
            nodeBox.height <= 1.5 &&
            getComputedStyle(node).overflow !== 'visible'
          ) {
            hidden = true;
            break;
          }
        }
        if (hidden) continue;
        // Folded away in a closed `<details>` (the summary itself is shown).
        const folded = element.closest('details:not([open])');
        if (folded && !element.closest('summary')) continue;
        if (box.bottom > lowest.bottom) lowest = { bottom: box.bottom, element };
      }
      const limit = Math.min(tabs?.top ?? Infinity, fab?.top ?? Infinity);
      if (lowest.bottom > limit + 0.5) {
        covered.push(
          `${describe(lowest.element)} ends at ${Math.round(lowest.bottom)}, under the bar that starts at ${Math.round(limit)}`,
        );
      }
    }

    const topBarTopWhenScrolled =
      header && window.scrollY > 0 ? header.getBoundingClientRect().top : null;
    window.scrollTo({ left: before.x, top: before.y, behavior: 'instant' });
    return {
      topBarHeight: header ? header.getBoundingClientRect().height : 0,
      topBarTopWhenScrolled,
      tabBar: tabs,
      fab,
      covered,
    };
  });
}

/**
 * Where a modal dialog sits, when one is open: all of it must be on the screen, and its heading too.
 * Returns what is wrong, or an empty list (also when no dialog is open).
 */
export async function measureDialog(page: Page): Promise<string[]> {
  const screen = page.viewportSize();
  if (!screen) throw new Error('measureDialog needs a page with a viewport');
  return page.evaluate(({ width: vw, height: vh }) => {
    const dialog = document.querySelector('dialog[open]');
    if (!dialog) return [];
    const box = dialog.getBoundingClientRect();
    const problems: string[] = [];
    const rounded = (n: number) => Math.round(n * 10) / 10;
    if (box.left < -0.75 || box.right > vw + 0.75) {
      problems.push(
        `the dialog spans ${rounded(box.left)}..${rounded(box.right)} of a ${vw}px screen`,
      );
    }
    if (box.top < -0.75 || box.bottom > vh + 0.75) {
      problems.push(
        `the dialog spans ${rounded(box.top)}..${rounded(box.bottom)} of a ${vh}px high screen`,
      );
    }
    if (dialog.scrollWidth > dialog.clientWidth + 1) {
      problems.push(
        `the dialog's content is ${dialog.scrollWidth}px wide in a ${dialog.clientWidth}px box`,
      );
    }
    return problems;
  }, screen);
}

/**
 * Asserts that `locator` (one element) is shown, entirely inside the screen once scrolled to, and a
 * target of at least 24 x 24 CSS px. `what` names it in the failure message.
 */
export async function expectReachableTarget(locator: Locator, what: string): Promise<void> {
  await expect.soft(locator, `${what} is visible`).toBeVisible();
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const viewport = locator.page().viewportSize();
  if (!box || !viewport) {
    expect.soft(box, `${what} has a box`).not.toBeNull();
    return;
  }
  expect
    .soft(
      Math.min(box.width, box.height),
      `${what} is ${box.width} x ${box.height} CSS px, below the 24 x 24 minimum`,
    )
    .toBeGreaterThanOrEqual(MIN_TARGET_PX);
  expect
    .soft(
      box.x >= -0.75 && box.x + box.width <= viewport.width + 0.75,
      `${what} spans ${box.x}..${box.x + box.width} of a ${viewport.width}px screen`,
    )
    .toBe(true);
}
