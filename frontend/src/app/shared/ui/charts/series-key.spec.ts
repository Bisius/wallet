import { Component } from '@angular/core';
import { render } from '../../../../testing/harness';
import { SeriesKey } from './series-key';

@Component({
  selector: 'app-series-key-host',
  imports: [SeriesKey],
  template: `
    <app-series-key id="one" kind="line" [slot]="1" />
    <app-series-key id="two" kind="line" [slot]="2" />
    <app-series-key id="three" kind="line" [slot]="3" />
    <app-series-key id="bar" kind="bar" [slot]="2" />
    <app-series-key id="track" kind="track" />
  `,
})
class Host {}

describe('SeriesKey', () => {
  async function open() {
    const fixture = await render(Host);
    const element = fixture.nativeElement as HTMLElement;
    const get = (id: string) => element.querySelector(`#${id}`) as HTMLElement;
    return { element, get };
  }

  it('is decoration: the words beside it name the series', async () => {
    const { element } = await open();
    const svgs = Array.from(element.querySelectorAll('svg'));
    expect(svgs).toHaveLength(5);
    expect(svgs.every((svg) => svg.getAttribute('aria-hidden') === 'true')).toBe(true);
  });

  it('shows each line as it is drawn: its color, its line style and its marker shape', async () => {
    const { get } = await open();
    const parts = (id: string) => {
      const [line, marker] = Array.from(get(id).querySelectorAll('path'));
      return {
        color: line.getAttribute('class'),
        dash: line.getAttribute('stroke-dasharray'),
        markerFill: marker.getAttribute('class'),
        marker: marker.getAttribute('d'),
      };
    };

    const [one, two, three] = [parts('one'), parts('two'), parts('three')];
    expect([one.color, two.color, three.color]).toEqual([
      'stroke-series-1',
      'stroke-series-2',
      'stroke-series-3',
    ]);
    expect([one.dash, two.dash, three.dash]).toEqual([null, '7 5', '1 5']);
    expect(one.markerFill).toContain('fill-series-1');
    expect(two.markerFill).toContain('fill-series-2');
    expect(three.markerFill).toContain('fill-series-3');
    // Three different shapes.
    expect(new Set([one.marker, two.marker, three.marker]).size).toBe(3);
  });

  it('shows a bar as a filled bar, and a track as an outline', async () => {
    const { get } = await open();
    expect(get('bar').querySelector('rect')?.getAttribute('class')).toBe('fill-series-2');
    expect(get('track').querySelector('rect')?.getAttribute('fill')).toBe('none');
    expect(get('track').querySelector('rect')?.getAttribute('class')).toBe('stroke-line-strong');
  });
});
