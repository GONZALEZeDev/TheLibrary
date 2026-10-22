/**
 * Tests of the rows of the stats tab of the review ({@link statsRowsOf}), on matches, tables and
 * curves written by hand: the figure of the last matches, their marks against the tier above, the
 * tier's own figure, the progress against the matches before and the side of the summary.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { durationWindowOf } from '../core/analysis/cohort';
import type { MetricKey } from '../core/analysis/metric';
import { PHASE_METRICS } from '../core/analysis/metrics/phase.metric';
import { communityWindowKey } from '../core/analysis/registry';
import type { MetricBenchmark } from '../core/deadlock-api/metric-benchmark.schema';
import type { CurvePoint } from '../core/deadlock-api/performance-curve.schema';
import { testMatchId } from '../test/test-data';
import type { CommunityReference } from './community-placement';
import type { RecentMatch } from './metrics.repository';
import { statsRowsOf } from './review-stats';
import type { ReviewMatch, ReviewRow, ReviewStats } from './review-view';

/** The length of most matches of the tests, in seconds: a match of the 30–35 minute window. */
const DURATION_S = 1_800;

/** The length of the longer matches of the tests: a match of the 40–45 minute window. */
const LONG_DURATION_S = 2_400;

/** The id of the most recent match of the tests; the earlier ones count down from it. */
const LAST_MATCH_ID = 900_000;

/** The start of the most recent match of the tests, in Unix seconds. */
const LAST_START_TIME = 1_790_000_000;

/** The time between the starts of two matches of the tests, in seconds. */
const MATCH_GAP_S = 3_600;

/** The deaths of the tier at the nine percentile points, for the shorter matches: the median is 4. */
const DEATHS_TABLE = [0, 1, 2, 3, 4, 5, 6, 7, 8];

/** The deaths of the tier for the longer matches: the median is 6. */
const LONG_DEATHS_TABLE = [2, 3, 4, 5, 6, 7, 8, 9, 10];

/** The KDA of the tier at the nine percentile points: the median is 2.5. */
const KDA_TABLE = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5];

/**
 * A point of the curve of the tier.
 *
 * Only the souls (`net_worth`) are read by the tests; every other counter holds a value of its own,
 * far from the souls, so that a reference read on another counter would not give the expected
 * figure.
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
 * The tier's data for the shorter matches: 6 000 souls at 10:00 (600 per minute over the early
 * game) and 600 souls per minute over the mid game (10:00 to 25:00).
 */
const REFERENCE: CommunityReference = {
  benchmark: new Map([
    ['deaths', DEATHS_TABLE],
    ['kda', KDA_TABLE],
  ]) satisfies MetricBenchmark,
  curve: [curvePoint(600, 6_000, 600), curvePoint(1_500, 15_000, 1_200)],
  window: durationWindowOf(DURATION_S),
};

/**
 * The tier's data for the longer matches: 7 000 souls at 10:00 and 700 souls per minute over the
 * mid game.
 */
const LONG_REFERENCE: CommunityReference = {
  benchmark: new Map([['deaths', LONG_DEATHS_TABLE]]) satisfies MetricBenchmark,
  curve: [curvePoint(600, 7_000, 700), curvePoint(1_500, 17_500, 1_400)],
  window: durationWindowOf(LONG_DURATION_S),
};

/**
 * One of the player's matches, numbered from the most recent (0) back.
 *
 * @param index - Its place from the most recent match: its id and start count down with it.
 * @param values - The values stored for it, by key.
 * @param durationS - Its length, in seconds.
 * @returns The match.
 */
function recentMatch(
  index: number,
  values: Readonly<Record<string, number | null>>,
  durationS: number = DURATION_S,
): RecentMatch {
  return {
    matchId: testMatchId(LAST_MATCH_ID - index),
    startTime: LAST_START_TIME - index * MATCH_GAP_S,
    durationS,
    values: new Map(Object.entries(values)),
  };
}

/**
 * Matches that each hold one value of a metric, most recent first.
 *
 * @param key - The metric.
 * @param values - Its value in each match, the most recent first.
 * @param reference - The tier's data every match is compared with, or `null` for none.
 * @param firstIndex - The place of the first match from the most recent one.
 * @returns The matches with their reference.
 */
function matchesWith(
  key: MetricKey,
  values: readonly number[],
  reference: CommunityReference | null,
  firstIndex = 0,
): ReviewMatch[] {
  return values.map((value, offset) => ({
    match: recentMatch(firstIndex + offset, { [key]: value }),
    reference,
  }));
}

/**
 * The same matches without their reference: the matches before the last ones.
 *
 * @param key - The metric.
 * @param values - Its value in each match, the most recent first.
 * @param firstIndex - The place of the first match from the most recent one: past the last
 *   matches of the test.
 * @returns The matches.
 */
function earlierMatchesWith(
  key: MetricKey,
  values: readonly number[],
  firstIndex: number,
): RecentMatch[] {
  return values.map((value, offset) => recentMatch(firstIndex + offset, { [key]: value }));
}

/**
 * Find the row of a metric in the stats tab.
 *
 * @param stats - The tab.
 * @param key - The metric.
 * @returns Its row.
 * @throws Error when the tab has no row for it (a failure of the test).
 */
function rowOf(stats: ReviewStats, key: MetricKey): ReviewRow {
  const rows = [...stats.families.flatMap((family) => family.rows), ...stats.phases];
  const row = rows.find(
    (candidate) => candidate.subject.kind === 'metric' && candidate.subject.key === key,
  );
  if (row === undefined) {
    throw new Error(`The stats tab has no row for ${key}`);
  }
  return row;
}

/**
 * The key of a row of a metric.
 *
 * @param row - The row.
 * @returns The key of its metric, or `null` for a row about something else.
 */
function keyOf(row: ReviewRow): MetricKey | null {
  return row.subject.kind === 'metric' ? row.subject.key : null;
}

describe('statsRowsOf', () => {
  it('gives every metric a row, by family', () => {
    const stats = statsRowsOf([], []);

    expect(
      stats.families.map(({ family, rows }) => [family, rows.map((row) => keyOf(row))]),
    ).toEqual([
      ['combat', ['kda', 'player_damage_per_min', 'accuracy']],
      ['survival', ['deaths', 'damage_taken_per_min']],
      ['farm', ['souls_per_min', 'last_hits', 'denies']],
      ['support', ['teammate_healing', 'teammate_barriering']],
      ['objectives', ['boss_damage_per_min']],
      ['laning', ['souls_at_10min', 'lane_souls_diff_at_10min']],
    ]);
    expect(stats.phases.map((row) => keyOf(row))).toEqual(PHASE_METRICS.map(({ key }) => key));
    // With no match at all, every row is there, and says nothing.
    expect(rowOf(stats, 'deaths')).toEqual({
      subject: { kind: 'metric', key: 'deaths' },
      unit: 'count',
      better: 'lower',
      value: null,
      count: 0,
      comparedValue: null,
      reference: null,
      difference: null,
      percentile: null,
      weak: 0,
      strong: 0,
      marked: 0,
      side: null,
      progress: { before: null, direction: null },
      matches: [],
    });
    expect(rowOf(stats, 'souls_per_min_mid')).toMatchObject({ unit: 'per_min', better: 'higher' });
  });

  it('takes the median of the last matches', () => {
    const recent = [
      ...matchesWith('deaths', [3, 1, 4, 1, 5, 9, 2], null),
      // A match where the metric is unknown is left out, not counted as 0.
      { match: recentMatch(7, { deaths: null, kda: 2 }), reference: null },
      ...matchesWith('kda', [2, 3, 4], null, 8),
    ];

    const stats = statsRowsOf(recent, []);

    const deaths = rowOf(stats, 'deaths');
    expect(deaths).toMatchObject({ value: 3, count: 7, marked: 0, percentile: null });
    expect(deaths.matches).toEqual(
      [3, 1, 4, 1, 5, 9, 2].map((value, index) => ({
        matchId: testMatchId(LAST_MATCH_ID - index),
        startTime: LAST_START_TIME - index * MATCH_GAP_S,
        value,
        mark: null,
      })),
    );
    // Four values are too few for a figure, but the row still says how many there are.
    expect(rowOf(stats, 'kda')).toMatchObject({ value: null, count: 4, difference: null });
  });

  it('marks only the matches that have a reference', () => {
    // With the tier's data, 8 deaths are its 99th percentile (weak), none its 1st (strong), and 4
    // its median (neither); without it, the same 8 deaths get no mark at all.
    const recent = [
      ...matchesWith('deaths', [8, 0, 4], REFERENCE),
      ...matchesWith('deaths', [8, 8, 8], null, 3),
    ];

    const row = rowOf(statsRowsOf(recent, []), 'deaths');

    expect(row).toMatchObject({ count: 6, marked: 3, weak: 1, strong: 1 });
    expect(row.matches.map(({ mark }) => mark)).toEqual(['weak', 'strong', null, null, null, null]);
  });

  it('orients the percentile of a lower-is-better metric', () => {
    // 7 deaths and a KDA of 4 are both the tier's 95th percentile: few deaths are good, a high KDA
    // is good, so one is weak and the other strong.
    const recent = [
      ...matchesWith('deaths', [7, 7, 7, 7, 7], REFERENCE),
      ...matchesWith('kda', [4, 4, 4, 4, 4], REFERENCE, 5),
    ];

    const stats = statsRowsOf(recent, []);

    expect(rowOf(stats, 'deaths')).toMatchObject({ percentile: 5, weak: 5, strong: 0 });
    expect(rowOf(stats, 'kda')).toMatchObject({ percentile: 95, weak: 0, strong: 5 });
  });

  it('marks the lane gap by its own rule', () => {
    // No tier data: the lane gap has no tier figure, and its rule does not need any.
    const recent = matchesWith('lane_souls_diff_at_10min', [-600, 600, 0, -500, 500, 499], null);

    const row = rowOf(statsRowsOf(recent, []), 'lane_souls_diff_at_10min');

    expect(row.matches.map(({ mark }) => mark)).toEqual([
      'weak',
      'strong',
      null,
      'weak',
      'strong',
      null,
    ]);
    expect(row).toMatchObject({
      marked: 6,
      weak: 2,
      strong: 2,
      percentile: null,
      comparedValue: null,
      reference: null,
      difference: null,
    });
  });

  it('does not mark a match whose tier data lacks the metric', () => {
    const withoutKda: CommunityReference = {
      ...REFERENCE,
      benchmark: new Map([['deaths', DEATHS_TABLE]]) satisfies MetricBenchmark,
    };
    const recent = matchesWith('kda', [1, 2, 3, 4, 5], withoutKda);

    const row = rowOf(statsRowsOf(recent, []), 'kda');

    expect(row).toMatchObject({ value: 3, count: 5, marked: 0, weak: 0, strong: 0 });
    expect(row).toMatchObject({ percentile: null, reference: null, comparedValue: null });
    expect(row.matches.map(({ mark }) => mark)).toEqual([null, null, null, null, null]);
  });

  it('gives no tier figure under five compared matches', () => {
    // Six deaths values, enough for the player's figure, but only four of the matches compared with
    // the tier: the marks are counted, the tier's figures are not given. The KDA of five compared
    // matches has them.
    const recent = [
      ...matchesWith('deaths', [8, 0, 4, 4], REFERENCE),
      ...matchesWith('deaths', [5, 5], null, 4),
      ...matchesWith('kda', [2.5, 2.5, 2.5, 2.5, 2.5], REFERENCE, 6),
    ];

    const stats = statsRowsOf(recent, []);

    expect(rowOf(stats, 'deaths')).toMatchObject({
      value: 4.5,
      count: 6,
      marked: 4,
      weak: 1,
      strong: 1,
      comparedValue: null,
      reference: null,
      difference: null,
      percentile: null,
    });
    expect(rowOf(stats, 'kda')).toMatchObject({
      value: 2.5,
      marked: 5,
      comparedValue: 2.5,
      reference: 2.5,
      difference: { kind: 'relative', ratio: 0 },
      percentile: 50,
    });
  });

  it("compares with the median of the tier for each match's length", () => {
    // Four shorter matches and three longer ones, each compared with the tier's data of its own
    // window: the tier's figure is the median of the seven, not their mean. The souls are read on
    // the curve: the souls at 10:00 against the tier's souls at 10:00, the mid-game rate against the
    // tier's rate.
    const values = {
      deaths: 6,
      souls_at_10min: 6_600,
      [communityWindowKey('souls_at_10min')]: 660,
      souls_per_min_mid: 660,
      [communityWindowKey('souls_per_min_mid')]: 660,
    };
    const recent: ReviewMatch[] = [0, 1, 2, 3, 4, 5, 6].map((index) =>
      index < 4
        ? { match: recentMatch(index, values), reference: REFERENCE }
        : { match: recentMatch(index, values, LONG_DURATION_S), reference: LONG_REFERENCE },
    );
    // A match with no tier data counts in the player's figure, not in the tier's.
    recent.push({ match: recentMatch(7, values), reference: null });

    const stats = statsRowsOf(recent, []);

    // A median of 4 deaths in four windows and of 6 in the other three (a mean of 4.86); deaths
    // are compared in deaths.
    expect(rowOf(stats, 'deaths')).toMatchObject({
      value: 6,
      count: 8,
      marked: 7,
      comparedValue: 6,
      reference: 4,
      difference: { kind: 'absolute', amount: 2 },
    });
    // 6 000 souls at 10:00 four times and 7 000 three times: 6 600 is 10 % above their median.
    const early = rowOf(stats, 'souls_at_10min');
    expect(early).toMatchObject({
      value: 6_600,
      marked: 7,
      comparedValue: 6_600,
      reference: 6_000,
    });
    expect(early.difference?.kind === 'relative' ? early.difference.ratio : null).toBeCloseTo(
      0.1,
      10,
    );
    // 600 souls per minute over the mid game four times and 700 three times: 660 is 10 % above.
    const mid = rowOf(stats, 'souls_per_min_mid');
    expect(mid).toMatchObject({ value: 660, marked: 7, comparedValue: 660, reference: 600 });
    expect(mid.difference?.kind === 'relative' ? mid.difference.ratio : null).toBeCloseTo(0.1, 10);
  });

  it('compares the figure of the stretch the tier covers', () => {
    // 46:40 matches: their late game runs from 25:00 to 46:40, but the tier's curve of their window
    // (45 minutes and more) is read up to 45:00 only, where the tier earns 800 souls per minute
    // (a deviation of 80). The player earns 1 000 over the whole late game, 880 over that stretch.
    const durationS = 2_800;
    const lateReference: CommunityReference = {
      benchmark: new Map(),
      curve: [curvePoint(1_500, 15_000, 1_200), curvePoint(2_700, 31_000, 2_000)],
      window: durationWindowOf(durationS),
    };
    const recent = [0, 1, 2, 3, 4].map((index) => ({
      match: recentMatch(
        index,
        { souls_per_min_late: 1_000, [communityWindowKey('souls_per_min_late')]: 880 },
        durationS,
      ),
      reference: lateReference,
    }));

    const row = rowOf(statsRowsOf(recent, []), 'souls_per_min_late');

    // The player's figure is the whole late game; the gap is the one of the stretch, 10 % and not
    // 25 %, as the marks say (one deviation above the tier is strong).
    expect(row).toMatchObject({
      value: 1_000,
      comparedValue: 880,
      reference: 800,
      marked: 5,
      strong: 5,
    });
    expect(row.difference?.kind === 'relative' ? row.difference.ratio : null).toBeCloseTo(0.1, 10);
  });

  it('measures progress against the matches before', () => {
    const recent = [
      ...matchesWith('kda', [2.9, 3, 3.1, 3, 3], null),
      ...matchesWith('deaths', [6, 6, 7, 5, 6], null, 5),
      ...matchesWith('accuracy', [0.5, 0.6, 0.5, 0.6, 0.5], null, 10),
    ];
    // One odd match each before: the figure before is their median, not their mean (1.44 and 4).
    const before = [
      ...earlierMatchesWith('kda', [1, 1, 1, 1.2, 3], 20),
      ...earlierMatchesWith('deaths', [3, 3, 3, 2, 9], 25),
      // Four earlier values are too few to compare with.
      ...earlierMatchesWith('accuracy', [0.2, 0.2, 0.2, 0.2], 30),
    ];

    const stats = statsRowsOf(recent, before);

    // A higher KDA is better; more deaths are worse.
    expect(rowOf(stats, 'kda').progress).toEqual({ before: 1, direction: 'better' });
    expect(rowOf(stats, 'deaths').progress).toEqual({ before: 3, direction: 'worse' });
    expect(rowOf(stats, 'accuracy').progress).toEqual({ before: null, direction: null });
  });

  it('flags a recurring weakness', () => {
    // Twenty matches: 8 deaths (weak) in eight of them, none (strong) in two, the tier's median in
    // the other ten. The KDA is weak in four only, under a quarter of the matches.
    const deaths = [
      ...Array<number>(8).fill(8),
      ...Array<number>(2).fill(0),
      ...Array<number>(10).fill(4),
    ];
    const kda = [...Array<number>(4).fill(0.4), ...Array<number>(16).fill(2.5)];
    const recent = deaths.map((value, index) => ({
      match: recentMatch(index, { deaths: value, kda: kda[index] ?? null }),
      reference: REFERENCE,
    }));

    const stats = statsRowsOf(recent, []);

    expect(rowOf(stats, 'deaths')).toMatchObject({
      weak: 8,
      strong: 2,
      marked: 20,
      side: 'weakness',
    });
    expect(rowOf(stats, 'kda')).toMatchObject({ weak: 4, strong: 0, marked: 20, side: null });
  });
});
