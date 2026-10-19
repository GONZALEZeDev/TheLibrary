/**
 * Statistics helpers of the match analysis: median and median absolute deviation, linear
 * interpolation, the normal distribution, and the placement of a value among the percentiles of a
 * community table.
 *
 * Everything here is pure arithmetic on numbers. The callers decide what the numbers mean (a metric
 * per minute, a score at a time of the game…) and guard the cases where there is nothing to compute.
 *
 * @packageDocumentation
 */
import { AppError } from '../errors/app-error';

/**
 * The percentiles a community table gives a value for, in increasing order.
 *
 * Community data only holds these nine points: anything between two of them is interpolated and
 * anything outside p1..p99 is clamped, so a placement is always between 1 and 99.
 */
export const PERCENTILE_POINTS = [1, 5, 10, 25, 50, 75, 90, 95, 99] as const;

/**
 * The value of a metric at each of the {@link PERCENTILE_POINTS}, in that order: nine values,
 * normally increasing (a table that is not is made monotonic by {@link placeInPercentiles}).
 */
export type PercentileTable = readonly number[];

/** The placement of a value below the first point of a table (the lowest placement). */
const LOWEST_PLACEMENT = 1;

/** The placement of a value above the last point of a table (the highest placement). */
const HIGHEST_PLACEMENT = 99;

/**
 * Beyond this many standard deviations, {@link normalCdf} answers 0 or 1: the tail left out is
 * below 1e-15, which is the precision of the series itself. The cut-off also keeps the series
 * short and its terms far from overflowing.
 */
const NORMAL_CDF_CUTOFF = 8;

/** The square root of 2π: the normalisation of the standard normal density. */
const SQRT_TWO_PI = Math.sqrt(2 * Math.PI);

/**
 * Median of a list of numbers: the middle value, or the mean of the two middle values of a list
 * with an even length.
 *
 * @param values - The numbers, in any order. The list is not modified.
 * @returns The median.
 * @throws AppError of kind `unexpected` when the list is empty: callers check their data first.
 */
export function median(values: readonly number[]): number {
  const sorted = values.toSorted((first, second) => first - second);
  // For an odd length both indexes are the middle one; for an even length they are the two middles.
  const lower = sorted[Math.ceil(sorted.length / 2) - 1];
  const upper = sorted[Math.floor(sorted.length / 2)];
  if (lower === undefined || upper === undefined) {
    throw new AppError('unexpected', 'The median of an empty list is undefined');
  }
  return (lower + upper) / 2;
}

/**
 * Median absolute deviation: the median of the distances of the values to a centre.
 *
 * This is the raw MAD. Reading it as a standard deviation needs the usual scale factor, which is
 * left to the caller.
 *
 * @param values - The numbers, in any order.
 * @param center - The centre the distances are taken from, normally the median of `values`.
 * @returns The median of `|value - center|`.
 * @throws AppError of kind `unexpected` when the list is empty, as {@link median} does.
 */
export function medianAbsoluteDeviation(values: readonly number[], center: number): number {
  return median(values.map((value) => Math.abs(value - center)));
}

/**
 * Linear interpolation of a curve given by points.
 *
 * @param points - The `[x, y]` points of the curve, sorted by increasing `x`.
 * @param x - Where to read the curve.
 * @returns The `y` of the point at `x` when there is one, the linear interpolation between the two
 * points that surround `x` otherwise, and `null` outside the range of the points (or without any
 * point): the curve is never extrapolated.
 */
export function interpolate(
  points: readonly (readonly [x: number, y: number])[],
  x: number,
): number | null {
  // The first point at or after `x`: with the points sorted, the curve is read between it and the
  // point before it.
  const upperIndex = points.findIndex(([pointX]) => pointX >= x);
  const upper = points[upperIndex];
  // `x` is above the last point, or there is no point.
  if (upper === undefined) {
    return null;
  }
  const [upperX, upperY] = upper;
  if (upperX === x) {
    return upperY;
  }
  const lower = points[upperIndex - 1];
  // `x` is below the first point.
  if (lower === undefined) {
    return null;
  }
  const [lowerX, lowerY] = lower;
  // Multiplying before dividing keeps the exact result when the inputs are whole numbers.
  return lowerY + ((x - lowerX) * (upperY - lowerY)) / (upperX - lowerX);
}

/**
 * Cumulative distribution function of the standard normal distribution: the probability that a
 * standard normal variable is at most `z`.
 *
 * It sums the power series `Φ(z) = 1/2 + φ(z) · (z + z³/3 + z⁵/(3·5) + z⁷/(3·5·7) + …)`, where `φ`
 * is the normal density (G. Marsaglia, "Evaluating the Normal Distribution", Journal of
 * Statistical Software, vol. 11, 2004). All the terms of the sum have the sign of `z`, so nothing
 * cancels and the result is exact to about 1e-15, far below the 1e-6 the analysis needs. The usual
 * erf approximation of Abramowitz and Stegun (formula 7.1.26) would also do, but it is off by
 * 1e-9 at `z = 0`, where Φ is known exactly.
 *
 * @param z - A number of standard deviations from the mean.
 * @returns Φ(z), between 0 and 1. `NaN` stays `NaN`.
 */
export function normalCdf(z: number): number {
  if (z <= -NORMAL_CDF_CUTOFF) {
    return 0;
  }
  if (z >= NORMAL_CDF_CUTOFF) {
    return 1;
  }
  const zSquared = z * z;
  let term = z;
  let sum = z;
  // Each term is the previous one times z² / (2n + 1); stop once a term no longer changes the sum.
  for (let n = 1; Math.abs(term) > Number.EPSILON * Math.abs(sum); n += 1) {
    term *= zSquared / (2 * n + 1);
    sum += term;
  }
  return 0.5 + (sum * Math.exp(-zSquared / 2)) / SQRT_TWO_PI;
}

/**
 * Pair every value of a table with its percentile point, rounding and making it monotonic first.
 *
 * @param table - The table, one value per percentile point.
 * @param integer - Whether the metric counts whole units, so that the table values are rounded.
 * @returns The `[value, percentile]` points, with non-decreasing values.
 * @throws AppError of kind `unexpected` when the table does not hold one value per point.
 */
function monotonicPoints(
  table: PercentileTable,
  integer: boolean,
): (readonly [value: number, percentile: number])[] {
  if (table.length !== PERCENTILE_POINTS.length) {
    throw new AppError(
      'unexpected',
      `A percentile table holds ${String(PERCENTILE_POINTS.length)} values, not ${String(table.length)}`,
    );
  }
  // The running maximum: each value becomes the largest one seen so far (step 2 of the placement).
  let ceiling = Number.NEGATIVE_INFINITY;
  return table.flatMap((value, index): (readonly [number, number])[] => {
    const percentile = PERCENTILE_POINTS[index];
    // Cannot happen once the length is checked; it narrows the type without an assertion.
    if (percentile === undefined) {
      return [];
    }
    ceiling = Math.max(ceiling, integer ? Math.round(value) : value);
    return [[ceiling, percentile]];
  });
}

/**
 * Place a value among the percentiles of a community table.
 *
 * Community tables only hold nine points, and a count metric (kills, last hits…) has ties between
 * them, so the placement follows fixed rules:
 * 1. With `integer`, every table value is rounded: the player's own value is a whole number, but
 *    the community averages are not.
 * 2. The table is made monotonic: each value becomes the largest of itself and the ones before it.
 * 3. Below the first value the placement is 1, above the last value it is 99.
 * 4. A value equal to one or more table values goes in the middle of the percentile points of that
 *    tied range, `(first + last) / 2`: a 0 shared by p1 and p5 is placed at 3.
 * 5. Any other value is placed by linear interpolation between the two points that surround it.
 *
 * @param value - The player's value of the metric.
 * @param table - The community values at the {@link PERCENTILE_POINTS}. Not modified.
 * @param options - How to read the table.
 * @param options.integer - Whether the metric counts whole units (kills, last hits…), so that the
 * table values are rounded first.
 * @returns The percentile of the value, from 1 to 99.
 * @throws AppError of kind `unexpected` when the table does not hold one value per percentile
 * point, or when the value is not a number.
 */
export function placeInPercentiles(
  value: number,
  table: PercentileTable,
  options: { readonly integer: boolean },
): number {
  const points = monotonicPoints(table, options.integer);
  const tableValues = points.map(([tableValue]) => tableValue);
  if (value < Math.min(...tableValues)) {
    return LOWEST_PLACEMENT;
  }
  if (value > Math.max(...tableValues)) {
    return HIGHEST_PLACEMENT;
  }
  const tiedPercentiles = points
    .filter(([tableValue]) => tableValue === value)
    .map(([, percentile]) => percentile);
  if (tiedPercentiles.length > 0) {
    return (Math.min(...tiedPercentiles) + Math.max(...tiedPercentiles)) / 2;
  }
  // The value is strictly inside the table and equal to no point: it has two distinct neighbours.
  // Only a value that is not a number (every comparison above is false for it) gets no placement.
  const placement = interpolate(points, value);
  if (placement === null) {
    throw new AppError('unexpected', 'The value cannot be placed among the percentiles');
  }
  return placement;
}
