/**
 * Tests of the placement of a match among the community: the state told from what the cache holds
 * ({@link communityOf}), the cell of a metric ({@link communityCellOf}), the two figures it
 * compares ({@link communityComparisonOf}) and the stretch of the curve a phase is read on
 * ({@link curveStretchFor}), on tables, curves and values written by hand. The analysis of a whole
 * match through them is tested with the analysis service.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  durationWindowOf,
  type Cohort,
  type CohortRank,
  type DurationWindow,
} from '../core/analysis/cohort';
import { deathsMetric } from '../core/analysis/metrics/deaths.metric';
import { laneSoulsDiffAt10MinMetric } from '../core/analysis/metrics/lane-souls-diff-at-10min.metric';
import { soulsAt10MinMetric } from '../core/analysis/metrics/souls-at-10min.metric';
import { phaseSpans } from '../core/analysis/phases';
import { communityWindowKey, metricByKey } from '../core/analysis/registry';
import type { CurvePoint } from '../core/deadlock-api/performance-curve.schema';
import type { MetricBenchmark } from '../core/deadlock-api/metric-benchmark.schema';
import type { CohortData, CohortRead } from './benchmark.service';
import {
  communityCellOf,
  communityComparisonOf,
  communityOf,
  curveStretchFor,
  type CommunityReference,
  type PlacementBasis,
} from './community-placement';

/** The length of the match of the tests, in seconds: its early phase is 600 s long. */
const DURATION_S = 1_800;

/** The duration window of that match, the one of the cohort and of the stored rates. */
const WINDOW: DurationWindow = durationWindowOf(DURATION_S);

/** A tier cohort of that window. */
const TIER_COHORT: Cohort = { rank: { kind: 'tier', tier: 4 }, window: WINDOW };

/** The same window for every rank: what a tier too small falls back to. */
const ALL_RANKS_COHORT: Cohort = { rank: { kind: 'all' }, window: WINDOW };

/** The deaths of the community at the nine percentile points: the median is 4. */
const DEATHS_TABLE = [0, 1, 2, 3, 4, 5, 6, 7, 8];

/** The benchmark of the tests: the deaths only. */
const BENCHMARK: MetricBenchmark = new Map([['deaths', DEATHS_TABLE]]);

/**
 * The key under which the player's rate over the early stretch the curve covers is stored: the
 * metric of the tests that is read on the curve is the early souls.
 */
const EARLY_RATE_KEY = communityWindowKey(soulsAt10MinMetric.key);

/**
 * A point of the community curve.
 *
 * The souls (`net_worth`) are the counter the early souls are read on; every other counter holds a
 * value of its own, far from the souls and from the others, so that a placement that read another
 * counter would not give the expected cell.
 *
 * @param timeS - The time of the point, in seconds since the start of the match.
 * @param soulsAvg - The average of the souls.
 * @param soulsStd - The deviation of the souls.
 * @returns The point.
 */
function curvePoint(timeS: number, soulsAvg: number, soulsStd: number): CurvePoint {
  return {
    timeS,
    avg: {
      net_worth: soulsAvg,
      player_damage: 1_111,
      boss_damage: 2_222,
      kills: 3_333,
      deaths: 4_444,
    },
    std: { net_worth: soulsStd, player_damage: 111, boss_damage: 222, kills: 333, deaths: 444 },
  };
}

/**
 * The curve of the tests: 6 000 souls (deviation 600) after ten minutes, so that the community
 * earns 600 per minute over the early phase, with a deviation of 60.
 */
const CURVE: readonly CurvePoint[] = [
  curvePoint(600, 6_000, 600),
  curvePoint(1_200, 14_000, 1_400),
];

/** The reference of the tests: the benchmark and the curve of the tier cohort. */
const REFERENCE: CommunityReference = { benchmark: BENCHMARK, curve: CURVE, window: WINDOW };

/**
 * The community data of a cohort.
 *
 * @param overrides - What differs from a tier cohort that holds enough matches.
 * @returns The data.
 */
function cohortData(overrides: Partial<CohortData> = {}): CohortData {
  return {
    wanted: TIER_COHORT,
    used: TIER_COHORT,
    sampleMatches: 321,
    benchmark: BENCHMARK,
    curve: CURVE,
    fetchedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/**
 * The basis of the placement of the match of the tests.
 *
 * @param values - The stored values of the match, by key.
 * @param overrides - What differs from a match whose stored rates are of the cohort's window.
 * @returns The basis.
 */
function basisOf(
  values: readonly (readonly [string, number | null])[],
  overrides: Partial<PlacementBasis> = {},
): PlacementBasis {
  return {
    spans: phaseSpans(DURATION_S),
    ratesWindow: WINDOW,
    values: new Map(values),
    ...overrides,
  };
}

describe('communityOf', () => {
  it('says the data is missing when the cache holds nothing', () => {
    expect(communityOf({ kind: 'missing' })).toEqual({
      state: { kind: 'missing' },
      reference: null,
    });
  });

  it('says there is nothing to compare with when even every rank holds too few matches', () => {
    const read: CohortRead = {
      kind: 'cached',
      data: cohortData({ wanted: ALL_RANKS_COHORT, used: null, benchmark: new Map(), curve: [] }),
      stale: false,
    };

    expect(communityOf(read)).toEqual({ state: { kind: 'unavailable' }, reference: null });
  });

  it('gives the cohort that is used, its size and its date, and the data to compare with', () => {
    const read: CohortRead = { kind: 'cached', data: cohortData(), stale: false };

    expect(communityOf(read)).toEqual({
      state: {
        kind: 'available',
        used: TIER_COHORT,
        fallback: false,
        stale: false,
        sampleMatches: 321,
        fetchedAt: 1_700_000_000_000,
      },
      reference: REFERENCE,
    });
  });

  it('flags a fallback when every rank replaced the tier that was too small', () => {
    const read: CohortRead = {
      kind: 'cached',
      data: cohortData({ used: ALL_RANKS_COHORT }),
      stale: false,
    };

    const { state, reference } = communityOf(read);

    expect(state).toMatchObject({ kind: 'available', used: ALL_RANKS_COHORT, fallback: true });
    expect(reference?.window).toEqual(WINDOW);
  });

  it('does not flag a fallback when the wanted and the used ranks are the same kind', () => {
    const otherTier: CohortRank = { kind: 'tier', tier: 5 };
    const read: CohortRead = {
      kind: 'cached',
      data: cohortData({ used: { rank: otherTier, window: WINDOW } }),
      stale: false,
    };

    expect(communityOf(read).state).toMatchObject({ kind: 'available', fallback: false });
  });

  it('keeps the stale flag of the read', () => {
    const read: CohortRead = { kind: 'cached', data: cohortData(), stale: true };

    expect(communityOf(read).state).toMatchObject({ kind: 'available', stale: true });
  });
});

describe('communityCellOf', () => {
  it('is none for a metric the community has no reference for, whatever the data', () => {
    const basis = basisOf([]);

    expect(communityCellOf(laneSoulsDiffAt10MinMetric, 120, basis, REFERENCE)).toEqual({
      kind: 'none',
    });
    expect(communityCellOf(laneSoulsDiffAt10MinMetric, null, basis, null)).toEqual({
      kind: 'none',
    });
  });

  it('is missing when there is no community data', () => {
    expect(communityCellOf(deathsMetric, 4, basisOf([]), null)).toEqual({ kind: 'missing' });
  });

  it('is missing when the value of the match is unknown', () => {
    expect(communityCellOf(deathsMetric, null, basisOf([]), REFERENCE)).toEqual({
      kind: 'missing',
    });
  });

  it('places a value among the percentiles of the benchmark, not turned for lower is better', () => {
    // 4 deaths is the median of the table; deaths are better lower, and the cell stays raw.
    expect(communityCellOf(deathsMetric, 4, basisOf([]), REFERENCE)).toEqual({
      kind: 'percentile',
      percentile: 50,
    });
    expect(communityCellOf(deathsMetric, 9, basisOf([]), REFERENCE)).toEqual({
      kind: 'percentile',
      percentile: 99,
    });
  });

  it('rounds the table of a metric that counts whole units, and only that one', () => {
    // A median of 3.6 deaths: rounded it is 4, the very value of the match, which is then the median;
    // as it is, 4 deaths lie between the median (3.6) and the next point (5), a bit above the median.
    const fractional: CommunityReference = {
      ...REFERENCE,
      benchmark: new Map([['deaths', [0, 1, 2, 3, 3.6, 5, 6, 7, 8]]]),
    };
    const asCounted = communityCellOf(deathsMetric, 4, basisOf([]), fractional);
    const asMeasured = communityCellOf(
      { ...deathsMetric, integer: false },
      4,
      basisOf([]),
      fractional,
    );

    expect(asCounted).toEqual({ kind: 'percentile', percentile: 50 });
    expect(asMeasured.kind === 'percentile' ? asMeasured.percentile : null).toBeCloseTo(
      50 + (25 * (4 - 3.6)) / (5 - 3.6),
      5,
    );
  });

  it('is missing when the benchmark holds no table for the metric', () => {
    const withoutTable: CommunityReference = { ...REFERENCE, benchmark: new Map() };

    expect(communityCellOf(deathsMetric, 4, basisOf([]), withoutTable)).toEqual({
      kind: 'missing',
    });
  });

  it('places the stored rate on the community rate over the same stretch of the curve', () => {
    // The community earns 600 per minute over the early phase (deviation 60): 600 is its average.
    const average = communityCellOf(
      soulsAt10MinMetric,
      6_000,
      basisOf([[EARLY_RATE_KEY, 600]]),
      REFERENCE,
    );
    expect(average).toMatchObject({ kind: 'curve', label: 'around' });
    expect(average.kind === 'curve' ? average.percentile : null).toBeCloseTo(50, 5);

    // Two deviations above the average.
    const ahead = communityCellOf(
      soulsAt10MinMetric,
      7_200,
      basisOf([[EARLY_RATE_KEY, 720]]),
      REFERENCE,
    );
    expect(ahead).toMatchObject({ kind: 'curve', label: 'well_above' });
    expect(ahead.kind === 'curve' ? ahead.percentile : null).toBeGreaterThan(97);
  });

  it('is missing when the stored rate was computed for another duration window', () => {
    const otherWindow: DurationWindow = { minS: 1_200, maxS: 1_499 };

    expect(
      communityCellOf(
        soulsAt10MinMetric,
        6_000,
        basisOf([[EARLY_RATE_KEY, 600]], { ratesWindow: otherWindow }),
        REFERENCE,
      ),
    ).toEqual({ kind: 'missing' });
  });

  it('reads two windows with the same bounds as the same window', () => {
    const copy: DurationWindow = { minS: WINDOW.minS, maxS: WINDOW.maxS };

    expect(
      communityCellOf(
        soulsAt10MinMetric,
        6_000,
        basisOf([[EARLY_RATE_KEY, 600]], { ratesWindow: copy }),
        REFERENCE,
      ).kind,
    ).toBe('curve');
  });

  it('is missing when the match did not reach the phase of the metric', () => {
    expect(
      communityCellOf(
        soulsAt10MinMetric,
        6_000,
        basisOf([[EARLY_RATE_KEY, 600]], { spans: [] }),
        REFERENCE,
      ),
    ).toEqual({ kind: 'missing' });
  });

  it('is missing when the stored rate is unknown', () => {
    expect(
      communityCellOf(soulsAt10MinMetric, 6_000, basisOf([[EARLY_RATE_KEY, null]]), REFERENCE),
    ).toEqual({ kind: 'missing' });
    expect(communityCellOf(soulsAt10MinMetric, 6_000, basisOf([]), REFERENCE)).toEqual({
      kind: 'missing',
    });
  });

  it('is missing when the curve does not cover the stretch', () => {
    const emptyCurve: CommunityReference = { ...REFERENCE, curve: [] };

    expect(
      communityCellOf(soulsAt10MinMetric, 6_000, basisOf([[EARLY_RATE_KEY, 600]]), emptyCurve),
    ).toEqual({ kind: 'missing' });
  });

  it('is missing when the curve has no spread to place a rate on', () => {
    const flat: CommunityReference = {
      ...REFERENCE,
      curve: [curvePoint(600, 6_000, 0), curvePoint(1_200, 14_000, 0)],
    };

    expect(
      communityCellOf(soulsAt10MinMetric, 6_000, basisOf([[EARLY_RATE_KEY, 600]]), flat),
    ).toEqual({ kind: 'missing' });
  });
});

describe('communityComparisonOf', () => {
  it('compares the value of a percentile metric with the median of the community', () => {
    expect(communityComparisonOf(deathsMetric, 6, basisOf([]), REFERENCE)).toEqual({
      player: 6,
      community: 4,
    });
  });

  it('compares a rate over the stretch the curve covers, not over the whole phase', () => {
    // A 23:20 match: its mid game runs from 10:00 to 23:20, but the curve of its window (20 to 25
    // minutes) is read up to 20:00 only, where the community earns 800 souls per minute.
    const durationS = 1_400;
    const window = durationWindowOf(durationS);
    const basis = basisOf([[communityWindowKey('souls_per_min_mid'), 840]], {
      spans: phaseSpans(durationS),
      ratesWindow: window,
    });

    expect(
      communityComparisonOf(metricByKey('souls_per_min_mid'), 900, basis, {
        ...REFERENCE,
        window,
      }),
    ).toEqual({ player: 840, community: 800 });
  });

  it('compares what was earned over the stretch for a metric that is not a rate', () => {
    // 720 souls per minute against 600 over the first ten minutes: 7 200 souls at 10:00 against
    // 6 000.
    expect(
      communityComparisonOf(soulsAt10MinMetric, 7_200, basisOf([[EARLY_RATE_KEY, 720]]), REFERENCE),
    ).toEqual({ player: 7_200, community: 6_000 });
  });

  it('compares nothing when the stored rate was computed for another duration window', () => {
    const otherWindow: DurationWindow = { minS: 1_200, maxS: 1_499 };

    expect(
      communityComparisonOf(
        soulsAt10MinMetric,
        6_000,
        basisOf([[EARLY_RATE_KEY, 600]], { ratesWindow: otherWindow }),
        REFERENCE,
      ),
    ).toBeNull();
  });

  it('compares nothing when the benchmark holds no table for the metric', () => {
    const withoutTable: CommunityReference = { ...REFERENCE, benchmark: new Map() };

    expect(communityComparisonOf(deathsMetric, 4, basisOf([]), withoutTable)).toBeNull();
  });

  it('compares nothing whenever the placement is not made', () => {
    const flat: CommunityReference = {
      ...REFERENCE,
      curve: [curvePoint(600, 6_000, 0), curvePoint(1_200, 14_000, 0)],
    };
    const cases = [
      // No reference for the metric, no data, an unknown value.
      {
        definition: laneSoulsDiffAt10MinMetric,
        value: 120,
        basis: basisOf([]),
        reference: REFERENCE,
      },
      { definition: deathsMetric, value: 4, basis: basisOf([]), reference: null },
      { definition: deathsMetric, value: null, basis: basisOf([]), reference: REFERENCE },
      // An unknown rate, a phase the match did not reach, a curve without spread.
      { definition: soulsAt10MinMetric, value: 6_000, basis: basisOf([]), reference: REFERENCE },
      {
        definition: soulsAt10MinMetric,
        value: 6_000,
        basis: basisOf([[EARLY_RATE_KEY, 600]], { spans: [] }),
        reference: REFERENCE,
      },
      {
        definition: soulsAt10MinMetric,
        value: 6_000,
        basis: basisOf([[EARLY_RATE_KEY, 600]]),
        reference: flat,
      },
    ];

    for (const { definition, value, basis, reference } of cases) {
      expect(['none', 'missing']).toContain(
        communityCellOf(definition, value, basis, reference).kind,
      );
      expect(communityComparisonOf(definition, value, basis, reference)).toBeNull();
    }
  });
});

describe('curveStretchFor', () => {
  it('gives the stretch of a phase and the rate of a counter of the community over it', () => {
    // The community earns 6 000 souls (deviation 600) over the first ten minutes.
    expect(curveStretchFor('early', 'net_worth', basisOf([]), REFERENCE)).toEqual({
      minutes: 10,
      average: { rate: 600, sigma: 60 },
    });
  });

  it('reads the counter it is asked for', () => {
    // 4 444 deaths (deviation 444) after ten minutes: the counters of the tests are all different.
    const stretch = curveStretchFor('early', 'deaths', basisOf([]), REFERENCE);

    expect(stretch?.minutes).toBe(10);
    expect(stretch?.average.rate).toBeCloseTo(444.4, 8);
    expect(stretch?.average.sigma).toBeCloseTo(44.4, 8);
  });

  it('stops at the time every match of the window reaches', () => {
    // A 23:20 match: its mid game runs from 10:00 to 23:20, but the curve of its window (20 to 25
    // minutes) is read up to 20:00 only.
    const durationS = 1_400;
    const window = durationWindowOf(durationS);
    const basis = basisOf([], { spans: phaseSpans(durationS), ratesWindow: window });

    const stretch = curveStretchFor('mid', 'net_worth', basis, { ...REFERENCE, window });

    expect(stretch?.minutes).toBe(10);
    expect(stretch?.average.rate).toBe(800);
    expect(stretch?.average.sigma).toBeCloseTo(Math.sqrt(1_400 ** 2 - 600 ** 2) / 10, 8);
  });

  it('has no stretch when the stored rates were computed for another duration window', () => {
    const otherWindow: DurationWindow = { minS: 1_200, maxS: 1_499 };

    expect(
      curveStretchFor('early', 'net_worth', basisOf([], { ratesWindow: otherWindow }), REFERENCE),
    ).toBeNull();
  });

  it('reads two windows with the same bounds as the same window', () => {
    const copy: DurationWindow = { minS: WINDOW.minS, maxS: WINDOW.maxS };

    expect(
      curveStretchFor('early', 'net_worth', basisOf([], { ratesWindow: copy }), REFERENCE),
    ).not.toBeNull();
  });

  it('has no stretch for a phase the match did not reach', () => {
    expect(curveStretchFor('early', 'net_worth', basisOf([], { spans: [] }), REFERENCE)).toBeNull();
  });

  it('has no stretch when what the window covers of the phase is too short to compare', () => {
    // A 11:40 match: its mid game lasts 100 s, and its window is read up to 12:00.
    const durationS = 700;
    const window = durationWindowOf(durationS);
    const basis = basisOf([], { spans: phaseSpans(durationS), ratesWindow: window });

    expect(curveStretchFor('mid', 'net_worth', basis, { ...REFERENCE, window })).toBeNull();
  });

  it('has no stretch when the curve does not cover it', () => {
    // The curve of the tests ends at 20:00: the late game of the match (25:00 to 30:00) is past it.
    expect(curveStretchFor('late', 'net_worth', basisOf([]), REFERENCE)).toBeNull();
    expect(
      curveStretchFor('early', 'net_worth', basisOf([]), { ...REFERENCE, curve: [] }),
    ).toBeNull();
  });
});
