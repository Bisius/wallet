import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';

/*
 * An axe-core check for specs: `await expectNoA11yViolations(page, 'dashboard, dark, phone')`.
 *
 * The frontend's own rule is that the app "MUST pass all AXE checks" and follow WCAG AA, so the
 * default is the whole rule set that those words cover, with nothing excluded and nothing disabled:
 *
 *   wcag2a, wcag2aa     WCAG 2.0 A and AA
 *   wcag21a, wcag21aa   WCAG 2.1 A and AA
 *   wcag22aa            WCAG 2.2 AA (this is where `target-size`, the 24 x 24 CSS px minimum, lives)
 *   best-practice       axe's own best practices (landmarks, heading order, `region`, ...)
 *
 * A violation is reported with `expect.soft`, so a walk over many pages and states collects every
 * violation of every one of them and fails once at the end, instead of stopping at the first. Each
 * message starts with the label the caller gave (page, state, theme, viewport), then lists, for each
 * violation, the rule, its impact, how many nodes it hit, the first few selectors with their HTML,
 * why axe says it fails (for a contrast rule: both colours and the ratio) and the help URL.
 *
 * "Needs review": axe cannot decide some colour contrasts (text over a drawn element, an element
 * partly under another, a link scrolled out of a strip) and puts them in `incomplete` instead of in
 * `violations`, so they would pass silently. For this app that is the text of every chart, and the
 * links of the navigation that are scrolled out of sight on a phone. Those nodes are measured here
 * (`resolveContrast`) and count as violations when the ratio is below the WCAG minimum.
 */

/** The rule sets that make up "passes AXE and WCAG AA". See the comment above. */
export const AXE_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
  'best-practice',
] as const;

export interface A11yOptions {
  /**
   * Selectors to leave out of the scan. Empty by default, and it must stay minimal: every entry
   * needs a comment at the call site that says why axe is wrong about this element and what the
   * evidence is. An exclusion is never a way to get a run green.
   */
  exclude?: readonly string[];
  /**
   * Rule ids to switch off. Empty by default, with the same rules as `exclude`: explicit, minimal and
   * justified in a comment where it is used.
   */
  disableRules?: readonly string[];
  /** How many nodes of one violation to list in the message (default 3). */
  maxNodes?: number;
}

/** One rule that a page breaks, with the elements that break it. */
export interface A11yIssue {
  id: string;
  impact: string;
  help: string;
  helpUrl: string;
  nodes: { selector: string; html: string; why: string }[];
}

/** What a scan found: the issues, and the contrast checks that nobody could decide. */
export interface A11yScan {
  issues: A11yIssue[];
  /** Elements whose contrast could not be worked out even by hand (a background image, say). */
  unverified: string[];
}

/**
 * Lets running CSS transitions and animations finish (a dialog fading in, a progress bar growing),
 * because axe reads colours as they are at that instant. A looping animation (a spinner) never
 * finishes and is not waited for.
 */
export async function finishAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

/** One element whose colours were measured: the numbers behind a contrast verdict. */
interface Contrast {
  selector: string;
  html: string;
  /** `null` when a background image or something else made the background unknowable. */
  ratio: number | null;
  required: number;
  foreground: string;
  background: string;
  fontPx: number;
  weight: number;
}

/**
 * Works out, in the page, the contrast of the elements that axe left "needs review". The text colour
 * is `color` (or `fill` for SVG text), the background is every translucent layer from the element up to
 * the first opaque one, laid over each other. The thresholds are WCAG's: 4.5:1, or 3:1 for large text
 * (24 px, or 18.66 px and bold).
 */
async function resolveContrast(page: Page, selectors: readonly string[]): Promise<Contrast[]> {
  return page.evaluate((all): Contrast[] => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('No canvas to read colours with');

    /** Any CSS colour (hex, rgb, color(srgb ...), oklch, ...) as 0-255 channels and 0-1 alpha. */
    const rgba = (css: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000';
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (
      top: [number, number, number, number],
      below: [number, number, number, number],
    ): [number, number, number, number] => {
      const alpha = top[3] + below[3] * (1 - top[3]);
      if (alpha === 0) return [0, 0, 0, 0];
      const channel = (i: 0 | 1 | 2) =>
        (top[i] * top[3] + below[i] * below[3] * (1 - top[3])) / alpha;
      return [channel(0), channel(1), channel(2), alpha];
    };
    const luminance = ([r, g, b]: number[]) => {
      const linear = (value: number) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * linear(r ?? 0) + 0.7152 * linear(g ?? 0) + 0.0722 * linear(b ?? 0);
    };
    const hex = (c: number[]) =>
      `#${c
        .slice(0, 3)
        .map((v) =>
          Math.round(v ?? 0)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')}`;

    return all.map((selector): Contrast => {
      const element = document.querySelector(selector);
      const none = {
        selector,
        html: '',
        ratio: null,
        required: 4.5,
        foreground: '?',
        background: '?',
        fontPx: 0,
        weight: 0,
      };
      if (!element) return none;
      const style = getComputedStyle(element);
      const fontPx = parseFloat(style.fontSize);
      const weight = Number(style.fontWeight) || 400;
      const large = fontPx >= 24 || (fontPx >= 18.66 && weight >= 700);
      const required = large ? 3 : 4.5;
      const html = element.outerHTML.slice(0, 200);

      // Background: the translucent layers up to the first opaque one, then the page's white.
      const layers: [number, number, number, number][] = [];
      let unknown = false;
      for (let node: Element | null = element; node; node = node.parentElement) {
        const css = getComputedStyle(node);
        if (css.backgroundImage !== 'none') unknown = true;
        const colour = rgba(css.backgroundColor);
        if (colour[3] > 0) layers.push(colour);
        if (colour[3] >= 1) break;
      }
      let background: [number, number, number, number] = [255, 255, 255, 1];
      if (layers.length > 0 && layers[layers.length - 1]?.[3] === 1) {
        background = layers[layers.length - 1] ?? background;
        for (let i = layers.length - 2; i >= 0; i -= 1) {
          background = over(layers[i] ?? background, background);
        }
      } else if (layers.length > 0) {
        for (let i = layers.length - 1; i >= 0; i -= 1) {
          background = over(layers[i] ?? background, background);
        }
      }

      // Foreground: the text colour (SVG text is painted by `fill`), faded by its own opacity.
      const svg = element instanceof SVGElement;
      let ink = rgba(svg && style.fill !== 'none' ? style.fill : style.color);
      let opacity = 1;
      for (let node: Element | null = element; node; node = node.parentElement) {
        opacity *= Number(getComputedStyle(node).opacity);
      }
      ink = [ink[0], ink[1], ink[2], ink[3] * opacity];
      const painted = over(ink, background);

      const [light, dark] = [luminance(painted), luminance(background)].sort((a, b) => b - a);
      const ratio = ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
      return {
        selector,
        html,
        ratio: unknown ? null : Math.round(ratio * 100) / 100,
        required,
        foreground: hex(painted),
        background: hex(background),
        fontPx: Math.round(fontPx * 10) / 10,
        weight,
      };
    });
  }, selectors);
}

/**
 * Runs axe on the page as it is now. Violations, plus the "needs review" colour contrasts that
 * measure below the minimum, are the issues; none is the goal.
 */
export async function a11yScan(page: Page, options: A11yOptions = {}): Promise<A11yScan> {
  await finishAnimations(page);
  const builder = new AxeBuilder({ page }).withTags([...AXE_TAGS]);
  for (const selector of options.exclude ?? []) builder.exclude(selector);
  if (options.disableRules?.length) builder.disableRules([...options.disableRules]);
  const results = await builder.analyze();

  const issues: A11yIssue[] = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact ?? 'no impact given',
    help: violation.help,
    helpUrl: violation.helpUrl,
    nodes: violation.nodes.map((node) => ({
      selector: node.target.map((part) => (Array.isArray(part) ? part.join(' ') : part)).join(' '),
      html: node.html,
      // `failureSummary` is "Fix any of the following:\n  <why>..."; the first reasons are enough.
      why: (node.failureSummary ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('Fix '))
        .slice(0, 2)
        .join(' | '),
    })),
  }));

  // What axe could not decide, decided here. The elements that are just symbols are skipped by axe on
  // purpose ("only non-text characters") and are hidden from assistive technology.
  const review = results.incomplete
    .filter((item) => item.id === 'color-contrast')
    .flatMap((item) => item.nodes)
    .filter((node) => !JSON.stringify(node.any).includes('nonBmp'))
    .map((node) => node.target.filter((part): part is string => typeof part === 'string')[0])
    .filter((selector): selector is string => selector !== undefined);
  const unverified: string[] = [];
  if (review.length > 0) {
    const failing: A11yIssue['nodes'] = [];
    for (const measured of await resolveContrast(page, review)) {
      if (measured.ratio === null) {
        unverified.push(`${measured.selector} ${measured.html}`);
      } else if (measured.ratio < measured.required) {
        failing.push({
          selector: measured.selector,
          html: measured.html,
          why: `Axe could not decide, so it was measured: contrast of ${measured.ratio} (foreground color: ${measured.foreground}, background color: ${measured.background}, font size: ${measured.fontPx}px, font weight: ${measured.weight}). Expected contrast ratio of ${measured.required}:1`,
        });
      }
    }
    if (failing.length > 0) {
      issues.push({
        id: 'color-contrast',
        impact: 'serious',
        help: 'Elements must meet minimum color contrast ratio thresholds (axe: needs review, measured by hand)',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.13/color-contrast',
        nodes: failing,
      });
    }
  }
  return { issues, unverified };
}

/** Runs axe on the page as it is now and returns what it found (none is the goal). */
export async function a11yViolations(page: Page, options: A11yOptions = {}): Promise<A11yIssue[]> {
  return (await a11yScan(page, options)).issues;
}

/** Cuts a long string in the middle of a report line. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The report of a list of issues: one block per rule. `label` says where it happened, so that a
 * failure can be acted on without opening the trace.
 */
export function formatViolations(
  label: string,
  issues: readonly A11yIssue[],
  maxNodes = 3,
): string {
  const blocks = issues.map((issue) => {
    const nodes = issue.nodes
      .slice(0, maxNodes)
      .map((node) =>
        [
          `    - selector: ${node.selector}`,
          `      html:     ${clip(node.html, 220)}`,
          node.why ? `      why:      ${clip(node.why, 320)}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    const more =
      issue.nodes.length > maxNodes ? `\n    ... and ${issue.nodes.length - maxNodes} more` : '';
    return [
      `  ${issue.id} (${issue.impact}, ${issue.nodes.length} node${
        issue.nodes.length === 1 ? '' : 's'
      }): ${issue.help}`,
      nodes.join('\n') + more,
      `    help: ${issue.helpUrl}`,
    ].join('\n');
  });
  return `[${label}] ${issues.length} axe violation${issues.length === 1 ? '' : 's'}:\n${blocks.join('\n')}`;
}

/**
 * Asserts, softly, that the page as it is now has no accessibility violation. `label` goes first in
 * the failure message. Returns the issues, so a caller can also collect them. Contrasts that could
 * not be worked out at all are attached to the test as annotations.
 */
export async function expectNoA11yViolations(
  page: Page,
  label: string,
  options: A11yOptions = {},
): Promise<A11yIssue[]> {
  const { issues, unverified } = await a11yScan(page, options);
  expect.soft(issues.length, formatViolations(label, issues, options.maxNodes)).toBe(0);
  if (unverified.length > 0) {
    test.info().annotations.push({
      type: `contrast not verified, ${label}`,
      description: unverified.join('\n'),
    });
  }
  return issues;
}
