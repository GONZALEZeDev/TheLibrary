/**
 * Tests of the rules every row of the review applies: the weak and strong marks of a match, the
 * placement of a buy minute among the purchases of a tier, the progress between the two windows and
 * the side of the summary a point falls on.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  DEATHS_BEFORE_RESISTANCE_WEAK,
  LANE_SOULS_CLEAR_GAP,
  MIN_PERSONAL_MATCHES,
  PLACE_STRONG_UP_TO,
  PLACE_WEAK_FROM,
  PROGRESS_MIN_Z,
  STRENGTH_PERCENTILE,
  WEAKNESS_PERCENTILE,
} from '../insights/thresholds';
import {
  flaggedSide,
  histogramMean,
  isInValveTopThree,
  isWithinNoise,
  markOfDeathsBeforeResistance,
  markOfLaneGap,
  markOfPercentile,
  markOfPlace,
  markOfValveRank,
  meanOf,
  placeInHistogram,
  progressOf,
} from './review-rules';

/** A tier that bought the item at the 10th minute twice, the 12th six times and the 14th twice. */
const HISTOGRAM = new Map([
  [10, 2],
  [12, 6],
  [14, 2],
]);

/**
 * Build a window of values from a shape that is easy to reason about: five values around a centre,
 * with a sample variance of 10 (the offsets 0, ±2 and ±4 square to 40, and 40 / 4 = 10).
 *
 * @param center - The mean of the window.
 * @returns Five values.
 */
function windowAround(center: number): readonly number[] {
  return [0, 2, -2, 4, -4].map((offset) => center + offset);
}

/** The standard error of the difference between two such windows: √(10 / 5 + 10 / 5). */
const WINDOW_STANDARD_ERROR = 2;

describe('markOfPercentile', () => {
  it('marks a percentile at the 30/70 bounds', () => {
    expect(markOfPercentile(WEAKNESS_PERCENTILE)).toBe('weak');
    expect(markOfPercentile(WEAKNESS_PERCENTILE - 1)).toBe('weak');
    expect(markOfPercentile(WEAKNESS_PERCENTILE + 1)).toBeNull();
    expect(markOfPercentile(STRENGTH_PERCENTILE)).toBe('strong');
    expect(markOfPercentile(STRENGTH_PERCENTILE + 1)).toBe('strong');
    expect(markOfPercentile(STRENGTH_PERCENTILE - 1)).toBeNull();
    expect(markOfPercentile(50)).toBeNull();
  });
});

describe('the marks of the other points', () => {
  it('marks places, the top three, deaths before resistance and the lane gap', () => {
    // A place among the twelve players: 10th to 12th is weak, 1st to 3rd is strong.
    expect(markOfPlace(PLACE_WEAK_FROM)).toBe('weak');
    expect(markOfPlace(PLACE_WEAK_FROM - 1)).toBeNull();
    expect(markOfPlace(12)).toBe('weak');
    expect(markOfPlace(PLACE_STRONG_UP_TO)).toBe('strong');
    expect(markOfPlace(PLACE_STRONG_UP_TO + 1)).toBeNull();
    expect(markOfPlace(1)).toBe('strong');

    // Valve's top three: any of its places is strong, outside it (0) is nothing.
    expect(markOfValveRank(1)).toBe('strong');
    expect(markOfValveRank(2)).toBe('strong');
    expect(markOfValveRank(3)).toBe('strong');
    expect(markOfValveRank(0)).toBeNull();
    expect(markOfValveRank(4)).toBeNull();

    // Deaths before the first resistance item: none is clean, three or more is a pattern.
    expect(markOfDeathsBeforeResistance(0)).toBe('strong');
    expect(markOfDeathsBeforeResistance(1)).toBeNull();
    expect(markOfDeathsBeforeResistance(DEATHS_BEFORE_RESISTANCE_WEAK - 1)).toBeNull();
    expect(markOfDeathsBeforeResistance(DEATHS_BEFORE_RESISTANCE_WEAK)).toBe('weak');
    expect(markOfDeathsBeforeResistance(DEATHS_BEFORE_RESISTANCE_WEAK + 4)).toBe('weak');

    // The lane gap in souls at 10 minutes: the clear gap itself already counts, on either side.
    expect(markOfLaneGap(-LANE_SOULS_CLEAR_GAP)).toBe('weak');
    expect(markOfLaneGap(-LANE_SOULS_CLEAR_GAP - 1)).toBe('weak');
    expect(markOfLaneGap(-LANE_SOULS_CLEAR_GAP + 1)).toBeNull();
    expect(markOfLaneGap(0)).toBeNull();
    expect(markOfLaneGap(LANE_SOULS_CLEAR_GAP - 1)).toBeNull();
    expect(markOfLaneGap(LANE_SOULS_CLEAR_GAP)).toBe('strong');
    expect(markOfLaneGap(LANE_SOULS_CLEAR_GAP + 1)).toBe('strong');
  });
});

describe('isInValveTopThree', () => {
  it('tells the ranks of the top three from the others', () => {
    // 1st to 3rd are in it; 0 is a match that has a top three without the player.
    expect(isInValveTopThree(1)).toBe(true);
    expect(isInValveTopThree(2)).toBe(true);
    expect(isInValveTopThree(3)).toBe(true);
    expect(isInValveTopThree(0)).toBe(false);
    expect(isInValveTopThree(4)).toBe(false);
    expect(isInValveTopThree(-1)).toBe(false);
  });

  it('is what marks a rank strong', () => {
    for (const rank of [-1, 0, 1, 2, 3, 4, 12]) {
      expect(markOfValveRank(rank) === 'strong').toBe(isInValveTopThree(rank));
    }
  });
});

describe('placeInHistogram', () => {
  it('places a buy minute in the histogram', () => {
    // The share of purchases before the minute, plus half of those at the same minute, times 100.
    expect(placeInHistogram(12, HISTOGRAM)).toBe(50);
    // A minute between two buckets has nothing at the same minute: only the earlier ones count.
    expect(placeInHistogram(11, HISTOGRAM)).toBe(20);
    expect(placeInHistogram(13, HISTOGRAM)).toBe(80);
    // Before every purchase the share is 0, after every purchase it is 1: both are clamped.
    expect(placeInHistogram(9, HISTOGRAM)).toBe(1);
    expect(placeInHistogram(20, HISTOGRAM)).toBe(99);
    // The first and the last bucket sit at half their own share from the end of the scale.
    expect(placeInHistogram(10, HISTOGRAM)).toBe(10);
    expect(placeInHistogram(14, HISTOGRAM)).toBe(90);
  });

  it('places a fractional minute in the bucket it falls in', () => {
    // The buckets are whole minutes: 12.3 is in the 12th minute, with the six purchases of it.
    expect(placeInHistogram(12.3, HISTOGRAM)).toBe(50);
    expect(placeInHistogram(12.99, HISTOGRAM)).toBe(50);
    // 11.9 is in the 11th minute, where nothing was bought: only the earlier purchases count.
    expect(placeInHistogram(11.9, HISTOGRAM)).toBe(20);
    expect(placeInHistogram(9.5, HISTOGRAM)).toBe(1);
  });

  it('answers null for an empty histogram', () => {
    expect(placeInHistogram(12, new Map())).toBeNull();
    expect(
      placeInHistogram(
        12,
        new Map([
          [10, 0],
          [12, 0],
        ]),
      ),
    ).toBeNull();
    expect(histogramMean(new Map())).toBeNull();
    expect(
      histogramMean(
        new Map([
          [10, 0],
          [12, 0],
        ]),
      ),
    ).toBeNull();
  });

  it('computes the mean minute at the middle of each bucket', () => {
    // (10.5 × 2 + 12.5 × 6 + 14.5 × 2) / 10.
    expect(histogramMean(HISTOGRAM)).toBe(12.5);
    expect(histogramMean(new Map([[5, 1]]))).toBe(5.5);
    // Each purchase weighs the same, wherever its bucket is.
    expect(
      histogramMean(
        new Map([
          [0, 3],
          [10, 1],
        ]),
      ),
    ).toBe(3);
  });
});

describe('meanOf', () => {
  it('averages the values and answers null for none', () => {
    expect(meanOf([1, 2, 3, 6])).toBe(3);
    expect(meanOf([7])).toBe(7);
    expect(meanOf([])).toBeNull();
  });
});

describe('progressOf', () => {
  it('calls a change smaller than its standard error stable', () => {
    const before = windowAround(10);
    // One point short of the smallest change that counts: within the noise of the two windows,
    // whichever way the figure improves.
    const near = windowAround(10 + PROGRESS_MIN_Z * WINDOW_STANDARD_ERROR - 1);
    expect(progressOf(near, before, 'mean', 'higher')).toEqual({ before: 10, direction: 'stable' });
    expect(progressOf(near, before, 'mean', 'lower')).toEqual({ before: 10, direction: 'stable' });
    const nearBelow = windowAround(10 - PROGRESS_MIN_Z * WINDOW_STANDARD_ERROR + 1);
    expect(progressOf(nearBelow, before, 'mean', 'higher').direction).toBe('stable');

    // A change that reaches the smallest change that counts, or goes beyond it, is not noise.
    const reaching = windowAround(10 + PROGRESS_MIN_Z * WINDOW_STANDARD_ERROR);
    expect(progressOf(reaching, before, 'mean', 'higher').direction).toBe('better');
    const beyond = windowAround(10 + 2 * PROGRESS_MIN_Z * WINDOW_STANDARD_ERROR);
    expect(progressOf(beyond, before, 'mean', 'higher').direction).toBe('better');
  });

  it('calls flat windows of the same fractional value stable, whatever their sizes', () => {
    // Seven times 0.1 and five times 0.1 add up to means that differ by rounding alone (the
    // standard error is about 0 on both sides): that is no change.
    const seven = Array.from({ length: 7 }, () => 0.1);
    const five = Array.from({ length: 5 }, () => 0.1);
    expect(progressOf(seven, five, 'mean', 'higher')).toEqual({ before: 0.1, direction: 'stable' });
    expect(progressOf(five, seven, 'mean', 'lower').direction).toBe('stable');
    expect(progressOf(seven, five, 'median', 'higher').direction).toBe('stable');
    // A window of the size of the review, against a shorter one.
    const twenty = Array.from({ length: 20 }, () => 0.7);
    const nine = Array.from({ length: 9 }, () => 0.7);
    expect(progressOf(twenty, nine, 'mean', 'higher').direction).toBe('stable');
    expect(progressOf(nine, twenty, 'mean', 'higher').direction).toBe('stable');

    // A change beyond the rounding of the sums is still a change, however small it is.
    const slightlyMore = Array.from({ length: 7 }, () => 0.1 + 1e-9);
    expect(progressOf(slightlyMore, five, 'mean', 'higher').direction).toBe('better');
  });

  it('tells better from worse by the direction of the point', () => {
    const before = windowAround(10);
    const higher = windowAround(30);
    const lower = windowAround(-10);

    // A rise is an improvement for a figure where higher is better, a regression where lower is.
    expect(progressOf(higher, before, 'mean', 'higher').direction).toBe('better');
    expect(progressOf(higher, before, 'mean', 'lower').direction).toBe('worse');
    expect(progressOf(lower, before, 'mean', 'higher').direction).toBe('worse');
    expect(progressOf(lower, before, 'mean', 'lower').direction).toBe('better');
  });

  it('gives back the centre of the earlier window, by the mean or by the median', () => {
    // One outlier pulls the mean (22) away from the median (3).
    const before = [1, 2, 3, 4, 100];
    const now = [3, 3, 3, 3, 3];
    expect(progressOf(now, before, 'mean', 'higher').before).toBe(22);
    expect(progressOf(now, before, 'median', 'higher').before).toBe(3);
  });

  it('measures the change between the centres the caller asked for', () => {
    // The mean of the last matches is 28, pulled up by one outlier, but their median is 10: the
    // earlier window is all 10s. The spread of the outlier gives a standard error of 18.
    const now = [10, 10, 10, 10, 100];
    const before = [10, 10, 10, 10, 10];
    expect(progressOf(now, before, 'median', 'higher')).toEqual({
      before: 10,
      direction: 'stable',
    });
    // The mean moved by 18 and the standard error of the difference is 18 too (the same formula
    // for both centres): the change is no longer smaller than its standard error.
    expect(progressOf(now, before, 'mean', 'higher')).toEqual({ before: 10, direction: 'better' });
  });

  it('gives no progress under five values', () => {
    const enough = windowAround(10);
    const short = windowAround(30).slice(0, MIN_PERSONAL_MATCHES - 1);

    // Too few earlier values: no centre to compare with, so nothing at all.
    expect(progressOf(enough, short, 'mean', 'higher')).toEqual({ before: null, direction: null });
    expect(progressOf(short, short, 'median', 'lower')).toEqual({ before: null, direction: null });
    // Too few recent values: the earlier centre is still known, but there is no direction.
    expect(progressOf(short, enough, 'mean', 'higher')).toEqual({ before: 10, direction: null });
    // Exactly the minimum on each side is enough.
    expect(progressOf(windowAround(30), enough, 'mean', 'higher').direction).toBe('better');
  });

  it('gives a direction to no neutral point', () => {
    const before = windowAround(10);
    const now = windowAround(30);
    // A figure that is neither better nor worse for being higher has no direction, only its centre.
    expect(progressOf(now, before, 'mean', null)).toEqual({ before: 10, direction: null });
    expect(progressOf(now, before, 'median', null)).toEqual({ before: 10, direction: null });
  });
});

describe('isWithinNoise', () => {
  it('weighs a gap against the standard error of the mean of the values', () => {
    // Five values of sample variance 10: the standard error of their mean is √(10 / 5) = √2.
    const values = windowAround(4);
    const standardError = Math.SQRT2;
    expect(isWithinNoise(0, values)).toBe(true);
    expect(isWithinNoise(-1, values)).toBe(true);
    expect(isWithinNoise(PROGRESS_MIN_Z * standardError * 0.99, values)).toBe(true);
    expect(isWithinNoise(-PROGRESS_MIN_Z * standardError * 0.99, values)).toBe(true);
    // A gap of the standard error or more is no longer noise, on either side.
    expect(isWithinNoise(PROGRESS_MIN_Z * standardError * 1.01, values)).toBe(false);
    expect(isWithinNoise(-2, values)).toBe(false);
  });

  it('has no noise to weigh against under two values or with no spread', () => {
    // One value has no spread to measure: there is no rule, and so no gap is called noise.
    expect(isWithinNoise(0, [4])).toBe(false);
    expect(isWithinNoise(0, [])).toBe(false);
    // Values that are all the same have no noise either: any gap at all is one.
    expect(isWithinNoise(0.1, [3, 3, 3, 3, 3])).toBe(false);
  });
});

describe('flaggedSide', () => {
  it('flags a weakness from a quarter of the marked matches', () => {
    // 5 of 20 is a quarter exactly: it counts. 4 of 20 is not enough.
    expect(flaggedSide(5, 0, 20)).toBe('weakness');
    expect(flaggedSide(4, 0, 20)).toBeNull();
    expect(flaggedSide(5, 2, 20)).toBe('weakness');
    // The mirror, for a strength.
    expect(flaggedSide(0, 5, 20)).toBe('strength');
    expect(flaggedSide(0, 4, 20)).toBeNull();
    expect(flaggedSide(2, 5, 20)).toBe('strength');
    // The share is of the matches that have a mark, not of the twenty: 2 of 8 is a quarter.
    expect(flaggedSide(2, 0, 8)).toBe('weakness');
    expect(flaggedSide(1, 0, 8)).toBeNull();
    // A side needs more matches than the other one: a tie flags nothing, however far above the share.
    expect(flaggedSide(6, 6, 20)).toBeNull();
    expect(flaggedSide(10, 0, 10)).toBe('weakness');
    // And it needs the share too: 4 weak against 3 strong of 20 wins the count but not the share.
    expect(flaggedSide(4, 3, 20)).toBeNull();
  });

  it('flags nothing from fewer marked matches than a figure needs', () => {
    // An item bought once, and weak that once, is one match and not a habit.
    expect(flaggedSide(1, 0, 1)).toBeNull();
    expect(flaggedSide(0, 1, 1)).toBeNull();
    // Four marked matches are one too few, however one-sided they are.
    const fewest = MIN_PERSONAL_MATCHES;
    expect(flaggedSide(fewest - 1, 0, fewest - 1)).toBeNull();
    expect(flaggedSide(0, fewest - 1, fewest - 1)).toBeNull();
    // Five are enough, and the other rules apply as usual.
    expect(flaggedSide(fewest, 0, fewest)).toBe('weakness');
    expect(flaggedSide(0, fewest, fewest)).toBe('strength');
    expect(flaggedSide(2, 0, fewest)).toBe('weakness');
    expect(flaggedSide(1, 0, fewest)).toBeNull();
  });
});

describe('the answers of the rules', () => {
  it('never returns NaN', () => {
    // Where a number is the answer it must be a finite one.
    const expectFinite = (value: number | null): void => {
      expect(Number.isFinite(value)).toBe(true);
    };

    // Empty inputs have no answer to give: null, never a number made of a division by zero.
    expect(meanOf([])).toBeNull();
    expect(histogramMean(new Map())).toBeNull();
    expect(placeInHistogram(0, new Map())).toBeNull();
    expect(flaggedSide(0, 0, 0)).toBeNull();
    expect(progressOf([], [], 'mean', 'higher')).toEqual({ before: null, direction: null });
    expect(progressOf([], [], 'median', null)).toEqual({ before: null, direction: null });

    // A single value has no spread to speak of, and no progress either.
    expectFinite(meanOf([4]));
    expect(progressOf([4], [4], 'mean', 'higher')).toEqual({ before: null, direction: null });

    // A spread of 0 on both sides gives a standard error of 0: no change is stable, and any
    // change at all is one, however small.
    const flat = [3, 3, 3, 3, 3];
    const slightlyHigher = [3.5, 3.5, 3.5, 3.5, 3.5];
    expect(progressOf(flat, flat, 'mean', 'higher')).toEqual({ before: 3, direction: 'stable' });
    expect(progressOf(flat, flat, 'median', 'lower')).toEqual({ before: 3, direction: 'stable' });
    expect(progressOf(slightlyHigher, flat, 'mean', 'higher')).toEqual({
      before: 3,
      direction: 'better',
    });
    expect(progressOf(slightlyHigher, flat, 'mean', 'lower')).toEqual({
      before: 3,
      direction: 'worse',
    });

    expectFinite(meanOf(flat));
    expectFinite(histogramMean(HISTOGRAM));
    expectFinite(placeInHistogram(12, HISTOGRAM));
    expectFinite(progressOf(flat, flat, 'mean', 'higher').before);
    expectFinite(progressOf(slightlyHigher, flat, 'median', 'higher').before);
  });
});
