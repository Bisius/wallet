import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The UI conventions of `frontend/.claude/CLAUDE.md`, as a test. Each pattern below is a hand-built
 * copy of something that has a primitive in `shared/ui/`; a feature template that spells it out again
 * makes the app drift apart one page at a time. A failure names the primitive to use instead.
 *
 * It reads the templates under `src/app/features/` (the `.html` files and the `template:` literals of
 * the components) as text, so it needs no browser and runs with `npm test`. There is no allow-list:
 * when a template really needs something this test forbids, the primitive is what has to change.
 */

interface Template {
  /** Path relative to `src/app/features`, for the failure message. */
  file: string;
  /** The template text with its HTML comments blanked out (same length, so offsets stay true). */
  text: string;
  /** The whole file, to turn an offset in `text` into a line number. */
  source: string;
  /** Where `text` starts in `source`. */
  offset: number;
}

interface Hit {
  file: string;
  line: number;
  found: string;
}

interface Rule {
  id: string;
  /** What to use instead: shown with every hit. */
  use: string;
  find(template: Template): { index: number; found: string }[];
}

/** The tokens of each static `class="…"` attribute, with where the attribute starts. */
function classAttributes(text: string): { index: number; tokens: string[]; tag: string }[] {
  const found: { index: number; tokens: string[]; tag: string }[] = [];
  for (const match of text.matchAll(/<([a-z][\w-]*)\b[^>]*?\bclass="([^"]*)"/g)) {
    found.push({
      index: match.index,
      tokens: match[2].split(/\s+/).filter(Boolean),
      tag: match[1],
    });
  }
  return found;
}

function classRule(
  id: string,
  use: string,
  matches: (tokens: string[], tag: string) => boolean,
): Rule {
  return {
    id,
    use,
    find: ({ text }) =>
      classAttributes(text)
        .filter(({ tokens, tag }) => matches(tokens, tag))
        .map(({ index, tokens }) => ({ index, found: `class="${tokens.join(' ')}"` })),
  };
}

const has = (tokens: string[], ...wanted: string[]): boolean =>
  wanted.every((token) => tokens.includes(token));

const RULES: Rule[] = [
  classRule(
    'pill',
    'a pill ("rounded-full" with a border) is <app-badge tone="…"> (or <app-tag-chip> for a tag or a budget chip)',
    (tokens) => has(tokens, 'rounded-full', 'border'),
  ),
  classRule(
    'alert',
    'a message box ("bg-negative-soft" / "bg-warning-soft") is <app-alert tone="error | warning | info | success"> (or <app-error-state> for a failed request)',
    (tokens) => tokens.includes('bg-negative-soft') || tokens.includes('bg-warning-soft'),
  ),
  {
    id: 'summary',
    use: 'a disclosure is <app-disclosure> (or the "How this works" help of <app-section>), not a styled <summary>',
    find: ({ text }) =>
      [...text.matchAll(/<summary\b[^>]*\bclass=/g)].map((match) => ({
        index: match.index,
        found: match[0],
      })),
  },
  classRule(
    'link-button',
    'a link that looks like a button is <a appLinkButton variant="…"> (shared/ui/link-button.ts)',
    (tokens, tag) => tag === 'a' && has(tokens, 'inline-flex', 'rounded-control'),
  ),
  classRule(
    'list-box',
    'a bordered list of rows ("divide-y" with "rounded-card") is <ul appList> with <li appListRow> (shared/ui/list.ts)',
    (tokens) => has(tokens, 'divide-y', 'rounded-card'),
  ),
  {
    id: 'page-root',
    use: 'a page starts with <app-page width="wide | narrow"> (it owns the width and the spacing: no "max-w-" on the root)',
    find: ({ file, text }) => {
      if (!/-page\.(html|ts)$/.test(file)) return [];
      const root = /<([a-z][\w-]*)\b([^>]*)>/.exec(text);
      if (!root) return [];
      const rootClass = /\bclass="([^"]*)"/.exec(root[2])?.[1] ?? '';
      const hits: { index: number; found: string }[] = [];
      if (root[1] !== 'app-page')
        hits.push({ index: root.index, found: `<${root[1]}> as the root` });
      for (const token of rootClass.split(/\s+/)) {
        if (token.includes('max-w-')) hits.push({ index: root.index, found: token });
      }
      return hits;
    },
  },
  {
    id: 'glyph',
    use: 'an icon is <app-icon name="…"> (check, arrow-right, arrow-left, x, …), never a text glyph',
    find: ({ text }) =>
      [...text.matchAll(/[✓✔✗✕→←]/g)].map((match) => ({ index: match.index, found: match[0] })),
  },
];

/** The templates of one file: the whole of an `.html`, the `template:` literals of a `.ts`. */
function templatesOf(file: string, source: string): Template[] {
  const blank = (text: string) =>
    text.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
  if (file.endsWith('.html')) return [{ file, text: blank(source), source, offset: 0 }];
  const templates: Template[] = [];
  for (const match of source.matchAll(/\btemplate:\s*`([\s\S]*?)`/g)) {
    const offset = match.index + match[0].indexOf('`') + 1;
    templates.push({ file, text: blank(match[1]), source, offset });
  }
  return templates;
}

function findHits(rule: Rule, templates: Template[]): Hit[] {
  return templates.flatMap((template) =>
    rule.find(template).map(({ index, found }) => ({
      file: template.file,
      line: template.source.slice(0, template.offset + index).split('\n').length,
      found,
    })),
  );
}

function featuresDir(): string {
  const candidates = [
    join(process.cwd(), 'src/app/features'),
    join(process.cwd(), 'frontend/src/app/features'),
  ];
  const found = candidates.find((dir) => existsSync(dir));
  if (!found) throw new Error(`ui-conventions: cannot find src/app/features from ${process.cwd()}`);
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    const isTemplate = entry.name.endsWith('.html');
    const isComponent = entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts');
    return isTemplate || isComponent ? [path] : [];
  });
}

const featuresRoot = featuresDir();
const templates = sourceFiles(featuresRoot).flatMap((path) =>
  templatesOf(relative(featuresRoot, path), readFileSync(path, 'utf8')),
);

describe('UI conventions in features/', () => {
  it('finds the templates it is meant to check', () => {
    // A wrong path must not make every rule pass for lack of anything to read.
    expect(templates.length).toBeGreaterThan(40);
    expect(templates.some((template) => template.file.endsWith('budgets-page.html'))).toBe(true);
  });

  it.each(RULES.map((rule) => [rule.id, rule] as const))('has no hand-built %s', (_id, rule) => {
    const hits = findHits(rule, templates).map(
      (hit) => `features/${hit.file}:${hit.line}  ${hit.found}\n    -> ${rule.use}`,
    );
    expect(hits).toEqual([]);
  });
});

describe('the convention checks themselves', () => {
  const run = (id: string, source: string, file = 'x/x.html') => {
    const rule = RULES.find((candidate) => candidate.id === id);
    if (!rule) throw new Error(`no rule ${id}`);
    return findHits(rule, templatesOf(file, source));
  };

  it('flags a pill, whatever the order of its classes', () => {
    expect(run('pill', '<span class="rounded-full border border-line px-2">x</span>')).toHaveLength(
      1,
    );
    expect(run('pill', '<span class="border rounded-full">x</span>')).toHaveLength(1);
    expect(run('pill', '<span class="rounded-full bg-accent">x</span>')).toEqual([]);
    expect(run('pill', '<span class="border-line rounded-card">x</span>')).toEqual([]);
  });

  it('flags a hand-made alert, a summary and a button-looking link', () => {
    expect(run('alert', '<div class="bg-negative-soft p-4">x</div>')).toHaveLength(1);
    expect(run('alert', '<div class="bg-warning-soft">x</div>')).toHaveLength(1);
    expect(run('summary', '<summary class="cursor-pointer">x</summary>')).toHaveLength(1);
    expect(run('summary', '<summary>x</summary>')).toEqual([]);
    expect(
      run('link-button', '<a href="/x" class="inline-flex rounded-control px-3">x</a>'),
    ).toHaveLength(1);
    expect(run('link-button', '<a appLinkButton href="/x">x</a>')).toEqual([]);
    expect(run('link-button', '<button class="inline-flex rounded-control">x</button>')).toEqual(
      [],
    );
  });

  it('flags a bordered list, a page root that is not app-page, and glyph icons', () => {
    expect(
      run('list-box', '<ul class="divide-y divide-line rounded-card border">x</ul>'),
    ).toHaveLength(1);
    expect(run('list-box', '<ul appList class="divide-y">x</ul>')).toEqual([]);
    expect(run('page-root', '<div class="max-w-3xl">x</div>', 'a/a-page.html')).toHaveLength(2);
    expect(run('page-root', '<app-page width="narrow">x</app-page>', 'a/a-page.html')).toEqual([]);
    expect(run('page-root', '<div class="max-w-3xl">x</div>', 'a/a-card.html')).toEqual([]);
    expect(run('glyph', '<p>Done ✓</p>')).toHaveLength(1);
    expect(run('glyph', '<p>From A → B</p>')).toHaveLength(1);
    expect(run('glyph', '<p><app-icon name="check" /></p>')).toEqual([]);
  });

  it('reads inline templates, skips comments and reports the line', () => {
    const source = [
      '@Component({',
      "  selector: 'app-x',",
      '  template: `',
      '    <!-- <span class="rounded-full border"> -->',
      '    <p>fine</p>',
      '    <span class="rounded-full border">pill</span>',
      '  `,',
      '})',
    ].join('\n');
    const hits = run('pill', source, 'x/x.ts');
    expect(hits).toEqual([{ file: 'x/x.ts', line: 6, found: 'class="rounded-full border"' }]);
  });
});
