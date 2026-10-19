/**
 * Tests of the statistics helpers of the match analysis: median, MAD, interpolation, the normal
 * distribution and the placement of a value among the percentiles of a community table.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  interpolate,
  median,
  medianAbsoluteDeviation,
  normalCdf,
  PERCENTILE_POINTS,
  placeInPercentiles,
  type PercentileTable,
} from './statistics';

/** A table that goes up by one at each percentile point: the value `n` sits at the nth point. */
const table: PercentileTable = [1, 2, 3, 4, 5, 6, 7, 8, 9];

describe('PERCENTILE_POINTS', () => {
  it('lists the nine percentile points of the community tables, in increasing order', () => {
    expect(PERCENTILE_POINTS).toEqual([1, 5, 10, 25, 50, 75, 90, 95, 99]);
  });
});

describe('placeInPercentiles', () => {
  it('interpolates between two points', () => {
    expect(placeInPercentiles(5.5, table, { integer: false })).toBe(62.5);
  });

  it('returns the percentile of a value that sits exactly on a point', () => {
    expect(placeInPercentiles(5, table, { integer: false })).toBe(50);
    expect(placeInPercentiles(1, table, { integer: false })).toBe(1);
    expect(placeInPercentiles(9, table, { integer: false })).toBe(99);
  });

  it('clamps below p1 and above p99', () => {
    expect(placeInPercentiles(0.5, table, { integer: false })).toBe(1);
    expect(placeInPercentiles(10, table, { integer: false })).toBe(99);
    expect(placeInPercentiles(Number.NEGATIVE_INFINITY, table, { integer: false })).toBe(1);
    expect(placeInPercentiles(Number.POSITIVE_INFINITY, table, { integer: false })).toBe(99);
  });

  it('places a tied value in the middle of its range', () => {
    expect(placeInPercentiles(0, [0, 0, 1, 2, 4, 6, 8, 9, 11], { integer: true })).toBe(3);
  });

  it('places a value tied at the last points in the middle of them', () => {
    expect(placeInPercentiles(9, [0, 1, 2, 3, 4, 5, 6, 9, 9], { integer: true })).toBe(97);
  });

  it('places the value of a table of identical values at the middle of every percentile', () => {
    expect(placeInPercentiles(2, [2, 2, 2, 2, 2, 2, 2, 2, 2], { integer: true })).toBe(50);
  });

  it('rounds the table of a count metric first', () => {
    expect(
      placeInPercentiles(4, [0, 0, 1.01, 1.994, 4.015, 5.99, 7.925, 8.935, 10.9], {
        integer: true,
      }),
    ).toBe(50);
  });

  it('keeps the table as is when the metric is not a count', () => {
    // The same table as above, not rounded: 4 falls between p25 (1.994) and p50 (4.015).
    const placement = placeInPercentiles(4, [0, 0, 1.01, 1.994, 4.015, 5.99, 7.925, 8.935, 10.9], {
      integer: false,
    });

    expect(placement).toBeCloseTo(49.814, 3);
  });

  it('makes a non-monotonic table monotonic', () => {
    expect(placeInPercentiles(3, [1, 2, 3, 2.9, 5, 6, 7, 8, 9], { integer: false })).toBe(17.5);
  });

  it('leaves the table it is given untouched', () => {
    const unsorted = [1, 2, 3, 2.9, 5.4, 6, 7, 8, 9];
    placeInPercentiles(3, unsorted, { integer: true });

    expect(unsorted).toEqual([1, 2, 3, 2.9, 5.4, 6, 7, 8, 9]);
  });

  it('refuses a table that does not hold one value per percentile point', () => {
    expect(() => placeInPercentiles(3, [1, 2, 3], { integer: false })).toThrow(
      expect.objectContaining({ kind: 'unexpected' }),
    );
    expect(() => placeInPercentiles(3, [...table, 10], { integer: false })).toThrow(
      expect.objectContaining({ kind: 'unexpected' }),
    );
  });

  it('refuses a value that is not a number', () => {
    expect(() => placeInPercentiles(Number.NaN, table, { integer: false })).toThrow(
      expect.objectContaining({ kind: 'unexpected' }),
    );
  });
});

describe('median', () => {
  it('computes the median of an odd and of an even number of values', () => {
    expect(median([18, 10, 14, 12, 16])).toBe(14);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('handles a single value, repeated values and negative values', () => {
    expect(median([7])).toBe(7);
    expect(median([3, 3, 3, 3])).toBe(3);
    expect(median([-5, -1, -3])).toBe(-3);
  });

  it('leaves the list it is given untouched', () => {
    const values = [3, 1, 2];
    median(values);

    expect(values).toEqual([3, 1, 2]);
  });

  it('throws an unexpected error, without any value in the message, on an empty list', () => {
    expect(() => median([])).toThrow(expect.objectContaining({ kind: 'unexpected' }));
    // A non-empty message without any digit: no number of the data can be in it.
    expect(() => median([])).toThrow(/^\D+$/);
  });
});

describe('medianAbsoluteDeviation', () => {
  it('computes the median of the distances to the centre', () => {
    expect(medianAbsoluteDeviation([10, 12, 14, 16, 18], 14)).toBe(2);
  });

  it('uses the centre it is given, which need not be the median', () => {
    // Distances to 10: 0, 2, 4, 6, 8.
    expect(medianAbsoluteDeviation([10, 12, 14, 16, 18], 10)).toBe(4);
  });

  it('is 0 when every value equals the centre', () => {
    expect(medianAbsoluteDeviation([5, 5, 5], 5)).toBe(0);
  });

  it('throws an unexpected error on an empty list', () => {
    expect(() => medianAbsoluteDeviation([], 0)).toThrow(
      expect.objectContaining({ kind: 'unexpected' }),
    );
  });
});

describe('interpolate', () => {
  it('interpolates and refuses outside the points', () => {
    expect(
      interpolate(
        [
          [540, 6000],
          [720, 9000],
        ],
        600,
      ),
    ).toBe(7000);
    expect(
      interpolate(
        [
          [540, 6000],
          [720, 9000],
        ],
        720,
      ),
    ).toBe(9000);
    expect(
      interpolate(
        [
          [540, 6000],
          [720, 9000],
        ],
        800,
      ),
    ).toBeNull();
  });

  it('returns the value of the first point and refuses below it', () => {
    const points = [
      [540, 6000],
      [720, 9000],
    ] as const;

    expect(interpolate(points, 540)).toBe(6000);
    expect(interpolate(points, 539)).toBeNull();
  });

  it('picks the pair of points that surrounds x among many', () => {
    const points = [
      [0, 0],
      [10, 100],
      [20, 100],
      [30, 40],
    ] as const;

    expect(interpolate(points, 5)).toBe(50);
    expect(interpolate(points, 15)).toBe(100);
    expect(interpolate(points, 25)).toBe(70);
  });

  it('works with a single point and refuses without any point', () => {
    expect(interpolate([[5, 9]], 5)).toBe(9);
    expect(interpolate([[5, 9]], 6)).toBeNull();
    expect(interpolate([], 5)).toBeNull();
  });
});

describe('normalCdf', () => {
  it('computes Φ', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 9);
    expect(normalCdf(0.75)).toBeCloseTo(0.773373, 6);
    expect(normalCdf(-1.96)).toBeCloseTo(0.024998, 6);
  });

  it('matches reference values of the normal distribution to nine digits', () => {
    expect(normalCdf(1)).toBeCloseTo(0.841344746, 9);
    expect(normalCdf(2)).toBeCloseTo(0.977249868, 9);
    expect(normalCdf(-3)).toBeCloseTo(0.00134989803, 9);
    expect(normalCdf(5)).toBeCloseTo(0.999999713, 9);
  });

  it('is symmetric around 0', () => {
    for (const z of [0.1, 0.5, 1, 1.96, 3, 6]) {
      expect(normalCdf(z) + normalCdf(-z)).toBeCloseTo(1, 12);
    }
  });

  it('increases with z', () => {
    const zs = [-6, -3, -1, -0.1, 0, 0.1, 1, 3, 6];
    const cdfs = zs.map(normalCdf);

    expect(cdfs.toSorted((first, second) => first - second)).toEqual(cdfs);
  });

  it('saturates in the tails, up to infinity', () => {
    expect(normalCdf(-12)).toBe(0);
    expect(normalCdf(12)).toBe(1);
    expect(normalCdf(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(normalCdf(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('propagates a value that is not a number', () => {
    expect(normalCdf(Number.NaN)).toBeNaN();
  });
});
