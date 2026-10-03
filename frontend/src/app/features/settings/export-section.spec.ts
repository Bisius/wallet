import { TestBed } from '@angular/core/testing';
import {
  fieldError,
  getByLabel,
  getByRole,
  queryAllByRole,
  queryByRole,
  textOf,
  typeInto,
} from '../../../testing/dom';
import { settle } from '../../../testing/harness';
import { a11yProblems } from '../../../testing/a11y';
import { ExportSection } from './export-section';

describe('ExportSection', () => {
  async function setup() {
    const fixture = TestBed.createComponent(ExportSection);
    fixture.detectChanges();
    await settle(fixture);
    const element = fixture.nativeElement as HTMLElement;
    const type = async (label: RegExp, value: string) => {
      typeInto(getByLabel(element, label), value);
      await settle(fixture);
    };
    const link = (kind: string) => getByRole(element, 'link', `Download ${kind} CSV`);
    return { fixture, element, type, link };
  }

  it('offers the three downloads as plain links, for the whole history', async () => {
    const { link, element } = await setup();

    const hrefs = ['spendings', 'incomes', 'savings'].map((kind) => link(kind).getAttribute('href'));
    expect(hrefs).toEqual([
      '/api/export/spendings.csv',
      '/api/export/incomes.csv',
      '/api/export/savings.csv',
    ]);
    // The browser downloads the file itself: a link with the name it will be saved as.
    expect(link('spendings').hasAttribute('download')).toBe(true);
    expect(link('spendings').getAttribute('download')).toBe('wallet-spendings-all.csv');
    expect(link('incomes').getAttribute('download')).toBe('wallet-incomes-all.csv');
    expect(link('savings').getAttribute('download')).toBe('wallet-savings-all.csv');
    expect(queryAllByRole(element, 'button')).toEqual([]);
    expect(textOf(element)).toContain('Your salary is not in this file.');
  });

  it('shares the range between the three links', async () => {
    const { link, type } = await setup();

    await type(/^From/, '2026-01-01');
    await type(/^To/, '2026-03-31');

    for (const kind of ['spendings', 'incomes', 'savings']) {
      expect(link(kind).getAttribute('href')).toBe(
        `/api/export/${kind}.csv?from=2026-01-01&to=2026-03-31`,
      );
      expect(link(kind).getAttribute('download')).toBe(
        `wallet-${kind}-2026-01-01_to_2026-03-31.csv`,
      );
    }
  });

  it('leaves out an empty bound', async () => {
    const { link, type } = await setup();

    await type(/^From/, '2026-01-01');
    expect(link('spendings').getAttribute('href')).toBe('/api/export/spendings.csv?from=2026-01-01');

    await type(/^From/, '');
    await type(/^To/, '2026-03-31');
    expect(link('spendings').getAttribute('href')).toBe('/api/export/spendings.csv?to=2026-03-31');
    expect(link('spendings').getAttribute('download')).toBe('wallet-spendings-until-2026-03-31.csv');
  });

  it('accepts a single day as a range', async () => {
    const { link, type } = await setup();

    await type(/^From/, '2026-03-05');
    await type(/^To/, '2026-03-05');

    expect(link('savings').getAttribute('href')).toBe(
      '/api/export/savings.csv?from=2026-03-05&to=2026-03-05',
    );
  });

  describe('a range that ends before it starts', () => {
    it('turns the links off and says why on the To field', async () => {
      const { element, type } = await setup();

      await type(/^From/, '2026-03-31');
      await type(/^To/, '2026-01-01');

      expect(queryByRole(element, 'link')).toBeNull();
      const buttons = queryAllByRole(element, 'button');
      expect(buttons.map((button) => textOf(button))).toEqual([
        'Download spendings CSV',
        'Download incomes CSV',
        'Download savings CSV',
      ]);
      expect(buttons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);

      const to = getByLabel(element, /^To/);
      expect(to.getAttribute('aria-invalid')).toBe('true');
      expect(fieldError(to)).toBe(
        '"From" is after "To". Choose a From date that is on or before the To date.',
      );
    });

    it('brings the links back, with the new range, once it is fixed', async () => {
      const { element, type, link } = await setup();
      await type(/^From/, '2026-03-31');
      await type(/^To/, '2026-01-01');
      expect(queryByRole(element, 'link')).toBeNull();

      await type(/^To/, '2026-04-30');

      expect(fieldError(getByLabel(element, /^To/))).toBe('');
      expect(link('spendings').getAttribute('href')).toBe(
        '/api/export/spendings.csv?from=2026-03-31&to=2026-04-30',
      );
    });
  });

  it('refuses a date the API would not read (a five-digit year)', async () => {
    const { element, type } = await setup();

    await type(/^To/, '12345-01-01');

    expect(queryByRole(element, 'link')).toBeNull();
    expect(fieldError(getByLabel(element, /^To/))).toBe('Enter a valid "To" date, with a four-digit year.');
  });

  it('labels every control and has nothing a screen reader cannot use', async () => {
    const { element } = await setup();

    expect(getByRole(element, 'region', 'Export')).toBeTruthy();
    expect(getByRole(element, 'heading', 'Export')).toBeTruthy();
    expect(getByLabel(element, /^From/)).toBeTruthy();
    expect(getByLabel(element, /^To/)).toBeTruthy();
    expect(a11yProblems(element)).toEqual([]);
  });
});
