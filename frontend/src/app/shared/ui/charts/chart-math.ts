/**
 * The arithmetic behind the charts, as pure functions: nice axis ticks, scales, band positions, line
 * paths and bar spans. Nothing here knows about Angular, the DOM or money formatting, so every edge
 * case (no data, one point, all zero, all negative) is a plain unit test.
 *
 * Amounts are integer cents. The ticks are integers too, and no function rounds an amount: only
 * pixel and percent positions are rounded, and only to keep the markup short.
 */

/** A position in the chart's own coordinates (pixels of the SVG). */
export interface Point {
  x: number;
  y: number;
}

/** A closed range of values, `[from, to]`. */
export type Domain = readonly [from: number, to: number];

export interface NiceScale {
  /** The axis' lowest value: a tick, at or below the data's minimum and never above 0. */
  min: number;
  /** The axis' highest value: a tick, at or above the data's maximum and never below 0. */
  max: number;
  /** The distance between two ticks: 1, 2 or 5 times a power of ten (never below 1). */
  step: number;
  /** Every tick from `min` to `max`, ascending, `step` apart. 0 is always one of them. */
  ticks: number[];
}

/**
 * How wide an axis is when there is nothing to scale: no values at all, or only zeros. A flat zero
 * line then sits on an axis of a few whole currency units instead of on a degenerate one.
 */
export const EMPTY_SPAN = 1000;

/** Rounds a pixel or percent position to two decimals. Never use it on an amount. */
export function roundPosition(value: number): number {
  return Math.round(value * 100) / 100;
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Folds `-0` into `0`, so a tick never reads "-0". */
function plainZero(value: number): number {
  return value === 0 ? 0 : value;
}

/**
 * The lowest and highest of the finite values, or `null` when there are none (an empty list, or
 * only `NaN` and infinities).
 */
export function extent(values: readonly number[]): [low: number, high: number] | null {
  let low = Infinity;
  let high = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  return low === Infinity ? null : [low, high];
}

/**
 * The distance between ticks for a range of `span`, aiming at `intervals` of them: the smallest of
 * 1, 2, 5 or 10 times a power of ten that is not below `span / intervals`. A step is a whole number
 * of cents, so it is never below 1.
 */
export function niceStep(span: number, intervals: number): number {
  if (!(span > 0) || !(intervals > 0)) return 1;
  const raw = span / intervals;
  if (raw <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / magnitude;
  const factor = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return factor * magnitude;
}

/**
 * An axis for amounts that contains `min` to `max` and always 0, since money is read against zero:
 * all-negative data gets an axis that ends at 0, all-positive data one that starts at 0. Ticks are
 * "nice" (see `niceStep`), about `intervals` of them, and the ends of the axis are ticks.
 *
 * `NaN` and infinities count as no data. With no data, or only zeros, the axis spans `EMPTY_SPAN`.
 * One value is simply a range of one value (plus 0).
 */
export function niceScale(min: number, max: number, intervals = 4): NiceScale {
  const a = Number.isFinite(min) ? min : 0;
  const b = Number.isFinite(max) ? max : 0;
  const low = Math.min(a, b, 0);
  let high = Math.max(a, b, 0);
  if (high === low) high = low + EMPTY_SPAN;

  const step = niceStep(high - low, intervals);
  const niceMin = plainZero(Math.floor(low / step) * step);
  const niceMax = plainZero(Math.ceil(high / step) * step);
  const ticks: number[] = [];
  for (let tick = niceMin; tick <= niceMax; tick += step) ticks.push(plainZero(tick));
  return { min: niceMin, max: niceMax, step, ticks };
}

/** The axis for a list of amounts: `niceScale` of their extent (of nothing, when there are none). */
export function niceScaleOf(values: readonly number[], intervals = 4): NiceScale {
  const range = extent(values);
  return range ? niceScale(range[0], range[1], intervals) : niceScale(0, 0, intervals);
}

/**
 * Maps a value of `domain` to a position of `range` (a pixel range may run backwards: a y axis goes
 * from the bottom up). A domain of no width maps everything to the middle of the range.
 */
export function linearScale(domain: Domain, range: Domain): (value: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  if (span === 0) return () => (r0 + r1) / 2;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

/** Where the points of a line chart sit along an axis. */
export interface PointPositions {
  /** The x of each point, left to right. A single point is centered. */
  positions: number[];
  /** The distance between two neighbouring points. For a single point, the whole axis. */
  step: number;
}

/**
 * Spreads `count` points evenly from `start` to `end`, the first and last `padding` in from the ends
 * (never more than half the axis). A line of two or three months then spans the whole plot instead
 * of huddling in the middle, and a single point is centered.
 */
export function pointPositions(
  count: number,
  start: number,
  end: number,
  padding = 0,
): PointPositions {
  if (!(count > 0)) return { positions: [], step: 0 };
  if (count === 1) return { positions: [(start + end) / 2], step: end - start };
  const inset = clamp(padding, 0, Math.max(0, (end - start) / 2));
  const first = start + inset;
  const step = (end - inset - first) / (count - 1);
  return { positions: Array.from({ length: count }, (_, i) => first + i * step), step };
}

/**
 * The `d` attribute of a polyline through `points`: `M x y L x y …`, positions rounded to two
 * decimals. No points give an empty string. One point gives a lone `M` that draws nothing: a chart
 * shows a lone point with its marker.
 */
export function linePath(points: readonly Point[]): string {
  return points
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${roundPosition(point.x)} ${roundPosition(point.y)}`,
    )
    .join(' ');
}

/** Where a bar starts and how long it is, both as a percent of the axis (0 to 100). */
export interface BarSpan {
  start: number;
  size: number;
}

/**
 * The span of a bar from 0 to `value` on an axis `domain`, in percent of the axis. A negative value
 * runs to the left of zero, so its bar starts before the zero line. A value outside the domain is cut
 * at its end, and a domain of no width has no bars.
 */
export function barSpan(value: number, domain: Domain): BarSpan {
  const [d0, d1] = domain;
  const width = d1 - d0;
  if (!(width > 0) || !Number.isFinite(value)) return { start: 0, size: 0 };
  const from = clamp(Math.min(0, value), d0, d1);
  const to = clamp(Math.max(0, value), d0, d1);
  return {
    start: roundPosition(((from - d0) / width) * 100),
    size: roundPosition(((to - from) / width) * 100),
  };
}

/** Where 0 is on an axis `domain`, in percent of the axis (0 when the axis starts at 0). */
export function zeroPosition(domain: Domain): number {
  const [d0, d1] = domain;
  const width = d1 - d0;
  return width > 0 ? roundPosition(clamp(((0 - d0) / width) * 100, 0, 100)) : 0;
}

/**
 * How many labels to skip so they fit: with `count` categories spread over `width` pixels, the
 * smallest step (1 labels all of them, 2 every other one) at which labels `minLabelWidth` wide do
 * not touch. At least 1, at most `count`.
 */
export function labelStride(count: number, width: number, minLabelWidth: number): number {
  if (!(count > 1) || !(width > 0) || !(minLabelWidth > 0)) return 1;
  return clamp(Math.ceil((minLabelWidth * count) / width), 1, count);
}

/**
 * The indexes to label, counting back from the last category so that one is always labelled (the
 * selected month is the last one), in ascending order.
 */
export function labelIndexes(count: number, stride: number): number[] {
  const step = Math.max(1, Math.floor(stride));
  const indexes: number[] = [];
  for (let index = count - 1; index >= 0; index -= step) indexes.push(index);
  return indexes.reverse();
}

/**
 * A rough width of `text` in pixels at `fontSize`, for sizing a margin: digits and currency symbols
 * are about 0.6 em wide. An estimate to leave room with, never to decide what to clip.
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  return Math.ceil(text.length * fontSize * 0.6);
}

/** The shapes a marker can have, one per series, so a line is told apart without its color. */
export type MarkerShape = 'circle' | 'square' | 'diamond';

/**
 * The `d` attribute of a marker centered on `(x, y)`. `radius` is its nominal size: a circle has
 * that radius, a square is a little smaller and a diamond a little larger, so the three look about
 * as heavy. One path for every shape lets a series change its marker without changing its markup.
 */
export function markerPath(shape: MarkerShape, x: number, y: number, radius: number): string {
  const at = (value: number) => roundPosition(value);
  switch (shape) {
    case 'circle':
      return (
        `M${at(x - radius)} ${at(y)}` +
        `a${at(radius)} ${at(radius)} 0 1 0 ${at(2 * radius)} 0` +
        `a${at(radius)} ${at(radius)} 0 1 0 ${at(-2 * radius)} 0Z`
      );
    case 'square': {
      const half = radius * 0.9;
      return `M${at(x - half)} ${at(y - half)}h${at(2 * half)}v${at(2 * half)}h${at(-2 * half)}Z`;
    }
    case 'diamond': {
      const half = radius * 1.3;
      return (
        `M${at(x)} ${at(y - half)}L${at(x + half)} ${at(y)}` +
        `L${at(x)} ${at(y + half)}L${at(x - half)} ${at(y)}Z`
      );
    }
  }
}
