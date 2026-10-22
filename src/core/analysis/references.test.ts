/**
 * Tests of the references of the match analysis: the comparison of a match value with the player's
 * habits, and its placement on the community curve.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import type { CurvePoint } from '../deadlock-api/performance-curve.schema';
import { present } from '../../test/analysis-context';
import {
  comparePersonal,
  curveLabel,
  curvePoint,
  curveRate,
  differenceOf,
  placeOnCurve,
  type CurveLabel,
} from './references';

/**
 * A matcher for a number close to the expected one, to put inside a `toEqual` on an object.
 * Vitest types `expect.closeTo` as `any`, which the lint rejects when it is assigned to a field.
 *
 * @param expected - The number expected.
 * @param digits - How many decimal digits must agree.
 * @returns The asymmetric matcher.
 */
function closeTo(expected: number, digits: number): unknown {
  return expect.closeTo(expected, digits);
}

/**
 * Build a point of the community curve: the net worth is the stat under test, the damage, the boss
 * damage and the deaths get fixed values, each different from every other value of the point, so
 * that reading the wrong stat shows up in a test.
 *
 * @param timeS - The time of the point, in seconds.
 * @param netWorth - The average and the deviation of the net worth.
 * @param kills - The average and the deviation of the kills.
 * @returns The point.
 */
function testPoint(
  timeS: number,
  netWorth: readonly [avg: number, std: number],
  kills: readonly [avg: number, std: number] = [1, 1],
): CurvePoint {
  return {
    timeS,
    avg: {
      net_worth: netWorth[0],
      player_damage: 111,
      boss_damage: 222,
      kills: kills[0],
      deaths: 7,
    },
    std: { net_worth: netWorth[1], player_damage: 11, boss_damage: 22, kills: kills[1], deaths: 9 },
  };
}

/** A community curve: 6000 ± 800 at 9:00, 9000 ± 1200 at 12:00 and 25000 ± 3750 at 25:00. */
const curve: readonly CurvePoint[] = [
  testPoint(540, [6_000, 800], [4, 2]),
  testPoint(720, [9_000, 1_200], [6, 3]),
  testPoint(1_500, [25_000, 3_750], [12, 2]),
];

describe('comparePersonal', () => {
  it('compares with the habits', () => {
    const result = present(
      comparePersonal({
        value: 18,
        previous: [10, 12, 14, 16, 18],
        display: 'relative',
        scale: 1,
      }),
    );

    expect(result.count).toBe(5);
    expect(result.median).toBe(14);
    expect(result.z).toBeCloseTo(1.349, 4);
    expect(result.difference).toEqual({ kind: 'relative', ratio: closeTo(0.2857, 4) });
  });

  it('needs 5 earlier matches', () => {
    expect(
      comparePersonal({ value: 1, previous: [1, 2, 3, 4], display: 'relative', scale: 1 }),
    ).toBeNull();
    expect(comparePersonal({ value: 1, previous: [], display: 'relative', scale: 1 })).toBeNull();
  });

  it('compares with exactly 5 earlier matches and counts all the ones it is given', () => {
    const five = present(
      comparePersonal({ value: 3, previous: [1, 2, 3, 4, 5], display: 'absolute', scale: 1 }),
    );
    const twenty = present(
      comparePersonal({
        value: 3,
        previous: Array.from({ length: 20 }, (_, index) => index + 1),
        display: 'absolute',
        scale: 1,
      }),
    );

    expect(five.count).toBe(5);
    expect(twenty.count).toBe(20);
  });

  it('does not depend on the order of the earlier matches', () => {
    const sorted = comparePersonal({
      value: 18,
      previous: [10, 12, 14, 16, 18],
      display: 'relative',
      scale: 1,
    });
    const shuffled = comparePersonal({
      value: 18,
      previous: [16, 10, 18, 14, 12],
      display: 'relative',
      scale: 1,
    });

    expect(shuffled).toEqual(sorted);
  });

  it('gives no signal for a MAD of 0', () => {
    const result = present(
      comparePersonal({ value: 2, previous: [0, 0, 0, 0, 0], display: 'relative', scale: 1 }),
    );

    expect(result.z).toBeNull();
  });

  it('keeps the difference when the MAD is 0 but the median is not', () => {
    const result = present(
      comparePersonal({ value: 7, previous: [5, 5, 5, 5, 5], display: 'relative', scale: 1 }),
    );

    expect(result.z).toBeNull();
    expect(result.median).toBe(5);
    expect(result.difference).toEqual({ kind: 'relative', ratio: closeTo(0.4, 6) });
  });

  it('shows an absolute difference when the median is 0', () => {
    const result = present(
      comparePersonal({ value: 2, previous: [0, 0, 0, 0, 0], display: 'relative', scale: 1 }),
    );

    expect(result.median).toBe(0);
    expect(result.difference).toEqual({ kind: 'absolute', amount: 2 });
  });

  it('scales the absolute difference when the median is 0', () => {
    const result = present(
      comparePersonal({ value: 0.1, previous: [0, 0, 0, 0, 0], display: 'relative', scale: 30 }),
    );

    expect(result.difference).toEqual({ kind: 'absolute', amount: closeTo(3, 6) });
  });

  it('shows an absolute difference when the metric asks for one', () => {
    const result = present(
      comparePersonal({ value: 9, previous: [4, 5, 6, 7, 8], display: 'absolute', scale: 1 }),
    );

    expect(result.median).toBe(6);
    expect(result.difference).toEqual({ kind: 'absolute', amount: 3 });
  });

  it('divides a relative difference by the size of a negative median', () => {
    const result = present(
      comparePersonal({
        value: -500,
        previous: [-1_000, -900, -800, -700, -600],
        display: 'relative',
        scale: 1,
      }),
    );

    // The value is 300 above a median of -800: an improvement of 300 / 800, positive.
    expect(result.difference).toEqual({ kind: 'relative', ratio: closeTo(0.375, 6) });
  });

  it('signs the z-score and the difference below the habits', () => {
    const result = present(
      comparePersonal({
        value: 10,
        previous: [10, 12, 14, 16, 18],
        display: 'relative',
        scale: 1,
      }),
    );

    expect(result.z).toBeCloseTo(-1.349, 4);
    expect(result.difference).toEqual({ kind: 'relative', ratio: closeTo(-0.2857, 4) });
  });

  it('converts a per-minute difference back to the match', () => {
    // deaths/min previous [0.1,0.12,0.14,0.16,0.18], this match 0.2/min over 30 min
    const result = present(
      comparePersonal({
        value: 0.2,
        previous: [0.1, 0.12, 0.14, 0.16, 0.18],
        display: 'absolute',
        scale: 30,
      }),
    );

    expect(result.median).toBeCloseTo(4.2, 6);
    expect(result.difference).toEqual({ kind: 'absolute', amount: closeTo(1.8, 6) });
  });

  it('leaves the z-score and a relative ratio unscaled', () => {
    const unscaled = present(
      comparePersonal({ value: 18, previous: [10, 12, 14, 16, 18], display: 'relative', scale: 1 }),
    );
    const scaled = present(
      comparePersonal({
        value: 18,
        previous: [10, 12, 14, 16, 18],
        display: 'relative',
        scale: 30,
      }),
    );

    expect(scaled.z).toBe(unscaled.z);
    expect(scaled.difference).toEqual(unscaled.difference);
    expect(scaled.median).toBe(unscaled.median * 30);
  });

  it('does not modify the earlier matches', () => {
    const previous = [18, 10, 16, 12, 14];

    comparePersonal({ value: 18, previous, display: 'relative', scale: 1 });

    expect(previous).toEqual([18, 10, 16, 12, 14]);
  });
});

describe('differenceOf', () => {
  it('gives a share of the reference for a relative display', () => {
    expect(differenceOf(12, 10, 'relative')).toEqual({ kind: 'relative', ratio: closeTo(0.2, 6) });
    // -500 is 300 above a reference of -800: the share is of the size of the reference, positive.
    expect(differenceOf(-500, -800, 'relative')).toEqual({
      kind: 'relative',
      ratio: closeTo(0.375, 6),
    });
  });

  it('gives an amount for an absolute display', () => {
    expect(differenceOf(6, 4, 'absolute')).toEqual({ kind: 'absolute', amount: 2 });
    expect(differenceOf(4, 6, 'absolute')).toEqual({ kind: 'absolute', amount: -2 });
  });

  it('gives an amount for a relative display when the reference is 0', () => {
    expect(differenceOf(3, 0, 'relative')).toEqual({ kind: 'absolute', amount: 3 });
  });

  it('scales an amount, and only an amount', () => {
    // 0.2 more per minute over 30 minutes is 6 more over the match; the share is the same in both
    // units.
    expect(differenceOf(0.6, 0.4, 'absolute', 30)).toEqual({
      kind: 'absolute',
      amount: closeTo(6, 6),
    });
    expect(differenceOf(0.6, 0.4, 'relative', 30)).toEqual({
      kind: 'relative',
      ratio: closeTo(0.5, 6),
    });
    expect(differenceOf(0.1, 0, 'relative', 30)).toEqual({
      kind: 'absolute',
      amount: closeTo(3, 6),
    });
  });
});

describe('curvePoint', () => {
  it('reads the curve at 600 s', () => {
    expect(curvePoint(curve, 'net_worth', 600)).toEqual({
      avg: 7_000,
      std: closeTo(933.33, 2),
    });
  });

  it('reads the exact point of the curve', () => {
    expect(curvePoint(curve, 'net_worth', 720)).toEqual({ avg: 9_000, std: 1_200 });
    expect(curvePoint(curve, 'net_worth', 1_500)).toEqual({ avg: 25_000, std: 3_750 });
  });

  it('reads the stat that is asked for', () => {
    expect(curvePoint(curve, 'kills', 720)).toEqual({ avg: 6, std: 3 });
    expect(curvePoint(curve, 'player_damage', 720)).toEqual({ avg: 111, std: 11 });
    expect(curvePoint(curve, 'boss_damage', 720)).toEqual({ avg: 222, std: 22 });
  });

  it('implies a point at 0 s with an average and a deviation of 0', () => {
    expect(curvePoint(curve, 'net_worth', 0)).toEqual({ avg: 0, std: 0 });
    // Halfway between the implied start and the first point, 9:00.
    expect(curvePoint(curve, 'net_worth', 270)).toEqual({ avg: 3_000, std: 400 });
  });

  it('prefers a point of the curve at 0 s to the implied one', () => {
    const anchored = [testPoint(0, [100, 10]), ...curve];

    expect(curvePoint(anchored, 'net_worth', 0)).toEqual({ avg: 100, std: 10 });
    expect(curvePoint(anchored, 'net_worth', 270)).toEqual({
      avg: closeTo(3_050, 6),
      std: closeTo(405, 6),
    });
  });

  it('gives nothing before the start of the match', () => {
    expect(curvePoint(curve, 'net_worth', -1)).toBeNull();
  });

  it('gives nothing after the last point', () => {
    expect(curvePoint(curve, 'net_worth', 1_501)).toBeNull();
  });

  it('gives nothing for an empty curve, even at 0 s', () => {
    expect(curvePoint([], 'net_worth', 0)).toBeNull();
    expect(curvePoint([], 'net_worth', 600)).toBeNull();
  });
});

describe('curveRate', () => {
  it('computes a rate and its spread', () => {
    const mid = present(curveRate(curve, 'net_worth', 600, 1_500));

    expect(mid.rate).toBe(1_200);
    expect(mid.sigma).toBeCloseTo(242.13, 2);
  });

  it('computes the rate from the start of the match', () => {
    const early = present(curveRate(curve, 'net_worth', 0, 540));

    // 6000 souls in 9 minutes; nothing is known at the start, so the gain has the spread of the end.
    expect(early.rate).toBeCloseTo(666.67, 2);
    expect(early.sigma).toBeCloseTo(88.89, 2);
  });

  it('reads the stat that is asked for', () => {
    const kills = present(curveRate(curve, 'kills', 540, 720));

    expect(kills.rate).toBeCloseTo(2 / 3, 6);
  });

  it('keeps the spread of the end when it does not exceed the spread of the start', () => {
    // Kills: a deviation of 3 at 12:00 and of 2 at 25:00, over 13 minutes.
    const shrinking = present(curveRate(curve, 'kills', 720, 1_500));
    // Equal deviations (2 and 2): the end is not above the start, so the end's spread is kept too.
    const equal = present(
      curveRate(
        [testPoint(600, [1, 1], [5, 2]), testPoint(900, [2, 1], [8, 2])],
        'kills',
        600,
        900,
      ),
    );

    expect(shrinking.sigma).toBeCloseTo(2 / 13, 6);
    expect(equal.sigma).toBeCloseTo(2 / 5, 6);
  });

  it('gives nothing when the span is empty or backwards', () => {
    expect(curveRate(curve, 'net_worth', 600, 600)).toBeNull();
    expect(curveRate(curve, 'net_worth', 1_500, 600)).toBeNull();
  });

  it('gives nothing when an end of the span is off the curve', () => {
    expect(curveRate(curve, 'net_worth', 600, 1_800)).toBeNull();
    expect(curveRate(curve, 'net_worth', -60, 600)).toBeNull();
    expect(curveRate([], 'net_worth', 0, 600)).toBeNull();
  });
});

describe('curveLabel', () => {
  it('labels at each threshold', () => {
    const labels: readonly (readonly [z: number, label: CurveLabel])[] = [
      [1, 'well_above'],
      [0.5, 'above'],
      [0.49, 'around'],
      [-0.5, 'below'],
      [-1, 'well_below'],
    ];

    for (const [z, label] of labels) {
      expect(curveLabel(z)).toBe(label);
    }
  });

  it('labels the rest of the scale', () => {
    expect(curveLabel(3)).toBe('well_above');
    expect(curveLabel(0.99)).toBe('above');
    expect(curveLabel(0)).toBe('around');
    expect(curveLabel(-0.49)).toBe('around');
    expect(curveLabel(-0.99)).toBe('below');
    expect(curveLabel(-3)).toBe('well_below');
  });
});

describe('placeOnCurve', () => {
  it('places a rate on the curve', () => {
    expect(placeOnCurve(770, { rate: 700, sigma: 93.333 })).toEqual({
      z: closeTo(0.75, 3),
      percentile: closeTo(77.34, 2),
      label: 'above',
    });
  });

  it('places a rate below the average', () => {
    const result = present(placeOnCurve(630, { rate: 700, sigma: 70 }));

    expect(result.z).toBeCloseTo(-1, 6);
    expect(result.percentile).toBeCloseTo(15.87, 2);
    expect(result.label).toBe('well_below');
  });

  it('places the average at the 50th percentile', () => {
    expect(placeOnCurve(700, { rate: 700, sigma: 50 })).toEqual({
      z: 0,
      percentile: 50,
      label: 'around',
    });
  });

  it('keeps the percentile between 1 and 99', () => {
    expect(present(placeOnCurve(10_000, { rate: 700, sigma: 50 })).percentile).toBe(99);
    expect(present(placeOnCurve(-10_000, { rate: 700, sigma: 50 })).percentile).toBe(1);
  });

  it('gives no community signal for a σ of 0', () => {
    expect(placeOnCurve(1, { rate: 1, sigma: 0 })).toBeNull();
  });

  it('gives no community signal for a negative or a non-finite σ', () => {
    expect(placeOnCurve(1, { rate: 1, sigma: -1 })).toBeNull();
    expect(placeOnCurve(1, { rate: 1, sigma: Number.NaN })).toBeNull();
    expect(placeOnCurve(1, { rate: 1, sigma: Number.POSITIVE_INFINITY })).toBeNull();
  });
});
