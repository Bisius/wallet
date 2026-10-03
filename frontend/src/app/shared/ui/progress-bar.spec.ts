import { Component, signal } from '@angular/core';
import { getByRole } from '../../../testing/dom';
import { render, settle } from '../../../testing/harness';
import { type ProgressTone, ProgressBar } from './progress-bar';

@Component({
  selector: 'app-progress-host',
  imports: [ProgressBar],
  template: `<app-progress-bar
    label="Groceries usage"
    [percent]="percent()"
    [tone]="tone()"
    [valueText]="valueText()"
  />`,
})
class ProgressHost {
  readonly percent = signal(40);
  readonly tone = signal<ProgressTone>('neutral');
  readonly valueText = signal('40% used, on track');
}

describe('ProgressBar', () => {
  async function setup() {
    const fixture = await render(ProgressHost);
    const element = fixture.nativeElement as HTMLElement;
    const bar = () => getByRole(element, 'progressbar', 'Groceries usage');
    const fill = () => bar().querySelector('div') as HTMLElement;
    return { fixture, host: fixture.componentInstance, bar, fill };
  }

  it('is a progress bar with a name, a range and a value in words', async () => {
    const { bar } = await setup();

    expect(bar().getAttribute('aria-valuemin')).toBe('0');
    expect(bar().getAttribute('aria-valuemax')).toBe('100');
    expect(bar().getAttribute('aria-valuenow')).toBe('40');
    expect(bar().getAttribute('aria-valuetext')).toBe('40% used, on track');
  });

  it('fills as much as the percentage says', async () => {
    const { fill } = await setup();
    expect(fill().style.width).toBe('40%');
  });

  it('fills to the end and no further when over 100%, while the words can say more', async () => {
    const { fixture, host, bar, fill } = await setup();
    host.percent.set(175);
    host.valueText.set('175% used, over budget');
    await settle(fixture);

    expect(fill().style.width).toBe('100%');
    expect(bar().getAttribute('aria-valuenow')).toBe('100');
    expect(bar().getAttribute('aria-valuetext')).toBe('175% used, over budget');
  });

  it('never goes below empty', async () => {
    const { fixture, host, bar } = await setup();
    host.percent.set(-5);
    await settle(fixture);

    expect(bar().getAttribute('aria-valuenow')).toBe('0');
  });

  it('colors the fill by tone', async () => {
    const { fixture, host, fill } = await setup();
    expect(fill().className).toContain('bg-accent');

    host.tone.set('warning');
    await settle(fixture);
    expect(fill().className).toContain('bg-warning');
    expect(fill().className).not.toContain('bg-accent');

    host.tone.set('danger');
    await settle(fixture);
    expect(fill().className).toContain('bg-negative');
  });
});
