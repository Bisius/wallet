import type { MarkerShape } from './chart-math';

/** A series' place in the fixed order of series colors (`--color-series-N` in `styles.css`). */
export type SeriesSlot = 1 | 2 | 3;

/**
 * What a series looks like. The hue is only one of three signals: each slot also has its own line
 * style and marker shape, so the series are told apart in grayscale, by readers who cannot tell the
 * hues apart, and in the legend as well as on the chart.
 *
 * The class names are written out in full so Tailwind finds them.
 */
export interface SeriesStyle {
  stroke: string;
  fill: string;
  /** `stroke-dasharray` of the line: none for solid, otherwise dashes or dots. */
  dash: string | null;
  marker: MarkerShape;
}

export const SERIES_STYLES: Record<SeriesSlot, SeriesStyle> = {
  1: { stroke: 'stroke-series-1', fill: 'fill-series-1', dash: null, marker: 'circle' },
  2: { stroke: 'stroke-series-2', fill: 'fill-series-2', dash: '7 5', marker: 'square' },
  3: { stroke: 'stroke-series-3', fill: 'fill-series-3', dash: '1 5', marker: 'diamond' },
};
