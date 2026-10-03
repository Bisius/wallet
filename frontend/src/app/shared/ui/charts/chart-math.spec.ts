import {
  EMPTY_SPAN,
  barSpan,
  clamp,
  estimateTextWidth,
  extent,
  labelIndexes,
  labelStride,
  linePath,
  linearScale,
  markerPath,
  niceScale,
  niceScaleOf,
  niceStep,
  pointPositions,
  roundPosition,
  zeroPosition,
} from './chart-math';

describe('extent', () => {
  it.each([
    ['nothing', [], null],
    ['only values that are not numbers', [NaN, Infinity, -Infinity], null],
    ['one value', [3], [3, 3]],
    ['several values', [3, -2, 9, 0], [-2, 9]],
    ['values that are not numbers among others', [NaN, 4, Infinity, -1], [-1, 4]],
  ] as const)('%s', (_name, values, expected) => {
    expect(extent(values)).toEqual(expected);
  });
});

describe('niceStep', () => {
  // [span, intervals aimed at, the step]
  it.each([
    [0, 4, 1],
    [-5, 4, 1],
    [3, 4, 1],
    [4, 4, 1],
    [8, 4, 2],
    [10, 4, 5],
    [100, 4, 50],
    [1000, 4, 500],
    [1234, 4, 500],
    [3200, 4, 1000],
    [25000, 4, 10000],
    [1_000_000_000, 5, 200_000_000],
    [1000, 0, 1],
  ])('a span of %i aiming at %i intervals steps by %i', (span, intervals, step) => {
    expect(niceStep(span, intervals)).toBe(step);
  });
});

describe('niceScale', () => {
  interface Case {
    name: string;
    min: number;
    max: number;
    intervals?: number;
    expected: { min: number; max: number; step: number; ticks: number[] };
  }
  const empty = { min: 0, max: EMPTY_SPAN, step: 500, ticks: [0, 500, 1000] };

  const cases: Case[] = [
    { name: 'no data at all (0 to 0)', min: 0, max: 0, expected: empty },
    { name: 'NaN counts as no data', min: NaN, max: NaN, expected: empty },
    { name: 'infinities count as no data', min: -Infinity, max: Infinity, expected: empty },
    {
      name: 'a single positive point starts at zero',
      min: 25000,
      max: 25000,
      expected: { min: 0, max: 30000, step: 10000, ticks: [0, 10000, 20000, 30000] },
    },
    {
      name: 'a single negative point ends at zero',
      min: -12000,
      max: -12000,
      expected: { min: -15000, max: 0, step: 5000, ticks: [-15000, -10000, -5000, 0] },
    },
    {
      name: 'all negative data ends at zero',
      min: -300,
      max: -100,
      expected: { min: -300, max: 0, step: 100, ticks: [-300, -200, -100, 0] },
    },
    {
      name: 'all positive data starts at zero',
      min: 700,
      max: 2900,
      expected: { min: 0, max: 3000, step: 1000, ticks: [0, 1000, 2000, 3000] },
    },
    {
      name: 'data on both sides of zero',
      min: -300,
      max: 2900,
      expected: { min: -1000, max: 3000, step: 1000, ticks: [-1000, 0, 1000, 2000, 3000] },
    },
    {
      name: 'swapped arguments are the same range',
      min: 2900,
      max: -300,
      expected: { min: -1000, max: 3000, step: 1000, ticks: [-1000, 0, 1000, 2000, 3000] },
    },
    {
      name: 'a range of a few cents steps by one cent',
      min: 1,
      max: 3,
      expected: { min: 0, max: 3, step: 1, ticks: [0, 1, 2, 3] },
    },
    {
      name: 'a single cent',
      min: 1,
      max: 1,
      expected: { min: 0, max: 1, step: 1, ticks: [0, 1] },
    },
    {
      name: 'a maximum that is exactly a multiple of the step gets no extra headroom',
      min: 0,
      max: 4000,
      expected: { min: 0, max: 4000, step: 1000, ticks: [0, 1000, 2000, 3000, 4000] },
    },
    {
      name: 'one cent more than that moves to the next nice step',
      min: 0,
      max: 4001,
      expected: { min: 0, max: 6000, step: 2000, ticks: [0, 2000, 4000, 6000] },
    },
    {
      name: 'a very large range',
      min: 0,
      max: 123_456_789,
      expected: {
        min: 0,
        max: 150_000_000,
        step: 50_000_000,
        ticks: [0, 50_000_000, 100_000_000, 150_000_000],
      },
    },
    {
      name: 'more intervals when asked',
      min: 0,
      max: 1000,
      intervals: 10,
      expected: {
        min: 0,
        max: 1000,
        step: 100,
        ticks: [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000],
      },
    },
  ];

  it.each(cases)('$name', ({ min, max, intervals, expected }) => {
    expect(niceScale(min, max, intervals)).toEqual(expected);
  });

  it('never gives a tick that reads -0', () => {
    for (const scale of [niceScale(-0, -0), niceScale(-500, -0), niceScale(0, 0)]) {
      for (const tick of [scale.min, scale.max, ...scale.ticks]) {
        expect(Object.is(tick, -0)).toBe(false);
      }
    }
  });

  it('keeps its promises for any range (seeded sweep)', () => {
    // A small deterministic generator: the sweep is the same on every run.
    let seed = 20261002;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const amount = () => Math.round((next() - 0.4) * 10 ** (1 + Math.floor(next() * 8)));

    for (let run = 0; run < 400; run++) {
      const a = amount();
      const b = amount();
      const intervals = 2 + Math.floor(next() * 7);
      const scale = niceScale(a, b, intervals);
      const label = `${a}, ${b}, ${intervals}`;

      // Ticks run from min to max in equal whole steps and include zero.
      expect(scale.ticks[0], label).toBe(scale.min);
      expect(scale.ticks.at(-1), label).toBe(scale.max);
      expect(scale.ticks, label).toContain(0);
      expect(Number.isInteger(scale.step), label).toBe(true);
      scale.ticks.slice(1).forEach((tick, index) => {
        expect(tick - scale.ticks[index], label).toBe(scale.step);
      });
      // The axis covers the data, and zero.
      expect(scale.min, label).toBeLessThanOrEqual(Math.min(a, b, 0));
      expect(scale.max, label).toBeGreaterThanOrEqual(Math.max(a, b, 0));
      // About as many ticks as asked for, never a wall of them.
      expect(scale.ticks.length, label).toBeGreaterThanOrEqual(2);
      expect(scale.ticks.length, label).toBeLessThanOrEqual(intervals + 3);
      // The step is 1, 2 or 5 times a power of ten.
      const magnitude = 10 ** Math.floor(Math.log10(scale.step));
      expect([1, 2, 5], label).toContain(Math.round(scale.step / magnitude));
    }
  });
});

describe('niceScaleOf', () => {
  it('is the scale of the extent of the values', () => {
    expect(niceScaleOf([5, 7, -2])).toEqual(niceScale(-2, 7));
    expect(niceScaleOf([-300, 2900, 150])).toEqual(niceScale(-300, 2900));
  });

  it('has an axis of its own for no values, and for values that are not numbers', () => {
    expect(niceScaleOf([])).toEqual(niceScale(0, 0));
    expect(niceScaleOf([NaN])).toEqual(niceScale(0, 0));
    expect(niceScaleOf([]).ticks).toEqual([0, 500, 1000]);
  });

  it('passes the number of intervals on', () => {
    expect(niceScaleOf([0, 1000], 10).step).toBe(100);
  });
});

describe('linearScale', () => {
  it('maps the ends of the domain to the ends of the range', () => {
    const scale = linearScale([0, 10], [0, 100]);
    expect(scale(0)).toBe(0);
    expect(scale(10)).toBe(100);
    expect(scale(5)).toBe(50);
  });

  it('can run backwards, for a y axis that grows upwards', () => {
    const scale = linearScale([-1000, 3000], [200, 0]);
    expect(scale(-1000)).toBe(200);
    expect(scale(3000)).toBe(0);
    expect(scale(0)).toBe(150);
    expect(scale(1000)).toBe(100);
  });

  it('does not clamp a value outside the domain', () => {
    const scale = linearScale([0, 10], [0, 100]);
    expect(scale(15)).toBe(150);
    expect(scale(-5)).toBe(-50);
  });

  it('puts everything in the middle of the range when the domain has no width', () => {
    const scale = linearScale([7, 7], [0, 100]);
    expect(scale(7)).toBe(50);
    expect(scale(1000)).toBe(50);
  });
});

describe('pointPositions', () => {
  it('has no points for none', () => {
    expect(pointPositions(0, 0, 100)).toEqual({ positions: [], step: 0 });
    expect(pointPositions(-2, 0, 100)).toEqual({ positions: [], step: 0 });
  });

  it('centers a single point, whatever the padding', () => {
    expect(pointPositions(1, 40, 140)).toEqual({ positions: [90], step: 100 });
    expect(pointPositions(1, 40, 140, 12)).toEqual({ positions: [90], step: 100 });
  });

  it('puts two points at the two ends, so their line spans the plot', () => {
    expect(pointPositions(2, 0, 100)).toEqual({ positions: [0, 100], step: 100 });
    expect(pointPositions(2, 50, 150, 10)).toEqual({ positions: [60, 140], step: 80 });
  });

  it('spreads more points evenly, padded in from both ends', () => {
    expect(pointPositions(3, 0, 100)).toEqual({ positions: [0, 50, 100], step: 50 });
    expect(pointPositions(5, 0, 100, 10)).toEqual({ positions: [10, 30, 50, 70, 90], step: 20 });
    expect(pointPositions(4, 100, 400, 0).positions).toEqual([100, 200, 300, 400]);
  });

  it('never pads in more than half the axis: the points then meet in the middle', () => {
    expect(pointPositions(3, 0, 20, 50)).toEqual({ positions: [10, 10, 10], step: 0 });
  });

  it('ignores a negative padding', () => {
    expect(pointPositions(3, 0, 100, -20).positions).toEqual([0, 50, 100]);
  });
});

describe('linePath', () => {
  it.each([
    ['no points', [], ''],
    [
      'one point (a lone move: nothing is drawn, the marker shows it)',
      [{ x: 10, y: 20 }],
      'M10 20',
    ],
    [
      'several points',
      [
        { x: 0, y: 0 },
        { x: 10.5, y: 20.25 },
        { x: 30, y: 5 },
      ],
      'M0 0 L10.5 20.25 L30 5',
    ],
    [
      'positions rounded to two decimals',
      [
        { x: 1 / 3, y: 2 / 3 },
        { x: 10.004, y: 10.006 },
      ],
      'M0.33 0.67 L10 10.01',
    ],
  ])('%s', (_name, points, expected) => {
    expect(linePath(points)).toBe(expected);
  });
});

describe('barSpan', () => {
  // A domain with room on both sides of zero: 100 below, 300 above. Zero is 25% along.
  const domain = [-100, 300] as const;

  it.each([
    ['a positive value starts at zero', 150, { start: 25, size: 37.5 }],
    ['a negative value ends at zero', -50, { start: 12.5, size: 12.5 }],
    ['zero has no length, and sits on the zero line', 0, { start: 25, size: 0 }],
    ['a value past the top is cut at the end of the axis', 500, { start: 25, size: 75 }],
    ['a value past the bottom is cut at the start of the axis', -500, { start: 0, size: 25 }],
    ['the whole axis', 300, { start: 25, size: 75 }],
    ['a value that is not a number has no bar', NaN, { start: 0, size: 0 }],
  ])('%s', (_name, value, expected) => {
    expect(barSpan(value, domain)).toEqual(expected);
  });

  it('starts at the left edge when the axis starts at zero', () => {
    expect(barSpan(100, [0, 400])).toEqual({ start: 0, size: 25 });
  });

  it('has no bars on an axis of no width, or one that runs backwards', () => {
    expect(barSpan(100, [0, 0])).toEqual({ start: 0, size: 0 });
    expect(barSpan(100, [10, 0])).toEqual({ start: 0, size: 0 });
  });
});

describe('zeroPosition', () => {
  it.each([
    [[-100, 300], 25],
    [[0, 300], 0],
    [[-300, 0], 100],
    [[0, 0], 0],
    [[50, 100], 0],
    [[-100, -50], 100],
  ] as const)('on an axis from %j zero is at %i%%', (domain, expected) => {
    expect(zeroPosition(domain)).toBe(expected);
  });
});

describe('labelStride', () => {
  // [categories, width of the axis, width one label needs, stride]
  it.each([
    [12, 600, 36, 1],
    [12, 262, 34, 2],
    [12, 100, 30, 4],
    [12, 10, 100, 12],
    [1, 100, 30, 1],
    [0, 100, 30, 1],
    [12, 0, 30, 1],
    [12, 600, 0, 1],
  ])('%i categories over %ipx with %ipx labels: every %ith', (count, width, label, stride) => {
    expect(labelStride(count, width, label)).toBe(stride);
  });
});

describe('labelIndexes', () => {
  // The last category is always labelled: it is the selected month.
  it.each([
    [5, 1, [0, 1, 2, 3, 4]],
    [12, 2, [1, 3, 5, 7, 9, 11]],
    [12, 3, [2, 5, 8, 11]],
    [12, 12, [11]],
    [1, 5, [0]],
    [0, 1, []],
    [4, 0, [0, 1, 2, 3]],
    [12, 2.7, [1, 3, 5, 7, 9, 11]],
  ])('%i categories, every %ith: %j', (count, stride, expected) => {
    expect(labelIndexes(count, stride)).toEqual(expected);
  });
});

describe('estimateTextWidth', () => {
  it('grows with the text and the font size', () => {
    expect(estimateTextWidth('', 12)).toBe(0);
    expect(estimateTextWidth('€2,000', 12)).toBe(44);
    expect(estimateTextWidth('-€12,000', 12)).toBeGreaterThan(estimateTextWidth('€2,000', 12));
    expect(estimateTextWidth('€2,000', 16)).toBeGreaterThan(estimateTextWidth('€2,000', 12));
  });
});

describe('small helpers', () => {
  it('clamps', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('rounds a position to two decimals', () => {
    expect(roundPosition(1 / 3)).toBe(0.33);
    expect(roundPosition(12.5)).toBe(12.5);
    expect(roundPosition(10.006)).toBe(10.01);
  });
});

describe('markerPath', () => {
  it.each([
    ['a circle has the radius it is given', 'circle', 'M5 20a5 5 0 1 0 10 0a5 5 0 1 0 -10 0Z'],
    ['a square is a little smaller', 'square', 'M5.5 15.5h9v9h-9Z'],
    ['a diamond is a little larger', 'diamond', 'M10 13.5L16.5 20L10 26.5L3.5 20Z'],
  ] as const)('%s', (_name, shape, expected) => {
    expect(markerPath(shape, 10, 20, 5)).toBe(expected);
  });

  it('is centered on the point it is given', () => {
    expect(markerPath('square', 0, 0, 10)).toBe('M-9 -9h18v18h-18Z');
    expect(markerPath('diamond', 0, 0, 10)).toBe('M0 -13L13 0L0 13L-13 0Z');
  });
});
