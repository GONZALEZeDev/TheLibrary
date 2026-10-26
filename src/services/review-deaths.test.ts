/**
 * Tests of the rows of the deaths tab of the review: the deaths of each phase against the tier above
 * ({@link deathRowsOf}) and the avoidable deaths ({@link avoidableDeathsRowOf}), on matches and
 * curves written by hand.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { durationWindowOf } from '../core/analysis/cohort';
import type { Phase } from '../core/analysis/phases';
import {
  AVOIDABLE_DEATHS_KEY,
  phaseDeathsKey,
  phaseDeathsWindowKey,
} from '../core/analysis/review/review-values';
import type { CurvePoint } from '../core/deadlock-api/performance-curve.schema';
import type { MatchId } from '../core/domain/match';
import { testMatchId } from '../test/test-data';
import type { CommunityReference } from './community-placement';
import type { RecentMatch } from './metrics.repository';
import { avoidableDeathsRowOf, deathRowsOf } from './review-deaths';
import type { ReviewMatch, ReviewRow } from './review-view';

/** The length of most matches of the tests, in seconds: a match of the 30–35 minute window. */
const DURATION_S = 1_800;

/** The length of the long matches of the tests, in seconds: a match of the 45 minute window. */
const LONG_DURATION_S = 2_800;

/** The id of the most recent match of the tests; the earlier ones count down from it. */
const LAST_MATCH_ID = 700_000;

/** The start of the most recent match of the tests, in Unix seconds. */
const LAST_START_TIME = 1_790_000_000;

/** The time between the starts of two matches of the tests, in seconds. */
const MATCH_GAP_S = 3_600;

/**
 * A point of the deaths curve of the tier.
 *
 * Only the deaths are read by the tests; every other counter holds a value of its own, far from the
 * deaths, so that a reference read on another counter would not give the expected figure.
 *
 * @param timeS - The time of the point, in seconds since the start of the match.
 * @param deathsAvg - The average of the deaths so far.
 * @param deathsStd - The deviation of the deaths so far.
 * @returns The point.
 */
function deathsPoint(timeS: number, deathsAvg: number, deathsStd: number): CurvePoint {
  return {
    timeS,
    avg: {
      net_worth: 5_555,
      player_damage: 1_111,
      boss_damage: 2_222,
      kills: 3_333,
      deaths: deathsAvg,
    },
    std: { net_worth: 555, player_damage: 111, boss_damage: 222, kills: 333, deaths: deathsStd },
  };
}

/**
 * The deaths of the tier. Over the early game it dies 3 times (a deviation of 1.5), over the mid game
 * 5 times (a deviation of 2), over the 25:00 to 30:00 stretch 3 times (a deviation of about 2.4) and
 * over the 25:00 to 45:00 stretch 12 times (a deviation of 6, so 0.3 a minute).
 */
const CURVE: readonly CurvePoint[] = [
  deathsPoint(600, 3, 1.5),
  deathsPoint(1_500, 8, 2.5),
  deathsPoint(1_800, 11, 3.5),
  deathsPoint(2_700, 20, 6.5),
];

/**
 * The tier's data for a match of a given length: the curve above, read for the match's own duration
 * window.
 *
 * @param durationS - The length of the match, in seconds.
 * @returns The reference.
 */
function referenceFor(durationS: number): CommunityReference {
  return { benchmark: new Map(), curve: CURVE, window: durationWindowOf(durationS) };
}

/** How a match of the tests differs from a match of 30 minutes compared with the tier. */
interface MatchOptions {
  /** The length of the match, in seconds. */
  readonly durationS?: number;
  /** The tier's data; the one of the match's window by default, `null` for none. */
  readonly reference?: CommunityReference | null;
}

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
 * One of the last matches, with the tier's data it is compared with.
 *
 * @param index - Its place from the most recent match.
 * @param values - The values stored for it, by key.
 * @param options - See {@link MatchOptions}.
 * @returns The match and its reference.
 */
function reviewMatch(
  index: number,
  values: Readonly<Record<string, number | null>>,
  options: MatchOptions = {},
): ReviewMatch {
  const durationS = options.durationS ?? DURATION_S;
  return {
    match: recentMatch(index, values, durationS),
    reference: options.reference === undefined ? referenceFor(durationS) : options.reference,
  };
}

/**
 * The stored deaths of a phase.
 *
 * @param phase - The phase.
 * @param whole - The deaths over the whole phase.
 * @param stretch - The deaths over the stretch of it the tier's data covers.
 * @returns The two values, by key.
 */
function phaseValues(phase: Phase, whole: number, stretch: number): Record<string, number> {
  return { [phaseDeathsKey(phase)]: whole, [phaseDeathsWindowKey(phase)]: stretch };
}

/**
 * The id of the match of the tests at a place.
 *
 * @param index - Its place from the most recent match.
 * @returns Its id.
 */
function matchIdAt(index: number): MatchId {
  return testMatchId(LAST_MATCH_ID - index);
}

describe('deathRowsOf', () => {
  it('gives one row for each phase, in the order of the match', () => {
    const rows = deathRowsOf([], []);

    expect(rows.map(({ subject, unit, better }) => [subject, unit, better])).toEqual([
      [{ kind: 'phase_deaths', phase: 'early' }, 'deaths', 'lower'],
      [{ kind: 'phase_deaths', phase: 'mid' }, 'deaths', 'lower'],
      [{ kind: 'phase_deaths', phase: 'late' }, 'deaths_per_10_min', 'lower'],
    ]);
    expect(
      rows.map(({ count, value, reference, matches }) => [count, value, reference, matches]),
    ).toEqual([
      [0, null, null, []],
      [0, null, null, []],
      [0, null, null, []],
    ]);
  });

  it('counts early deaths per match against the curve of the tier', () => {
    // The tier dies 3 times (a deviation of 1.5) over the first ten minutes: 6 deaths are two
    // deviations above, none two below, 3 are the tier's average.
    const recent = [
      ...[6, 0, 3, 3, 3, 3].map((deaths, index) =>
        reviewMatch(index, phaseValues('early', deaths, deaths)),
      ),
      // No tier data cached: the match is in the player's figure, with no mark and no comparison.
      reviewMatch(6, phaseValues('early', 5, 5), { reference: null }),
      // The death details of this match are incomplete: it has no value, and is not in the row.
      reviewMatch(7, {}),
    ];
    // The earlier matches: the figure before is their mean, 5 (their median is 4); a match without
    // death details is left out of it.
    const before = [4, 4, 4, 4, 4, 10].map((deaths, index) =>
      recentMatch(20 + index, phaseValues('early', deaths, deaths)),
    );

    const [early] = deathRowsOf(recent, [...before, recentMatch(30, {})]);

    expect(early).toMatchObject({
      subject: { kind: 'phase_deaths', phase: 'early' },
      unit: 'deaths',
      better: 'lower',
      // The mean of the seven deaths counts, not their median (3).
      value: 23 / 7,
      count: 7,
      // Six matches were compared: their deaths over the stretch, and the tier's.
      comparedValue: 3,
      weak: 1,
      strong: 1,
      marked: 6,
      side: null,
      progress: { before: 5, direction: 'better' },
    });
    expect(early?.reference).toBeCloseTo(3, 10);
    expect(early?.difference).toMatchObject({ kind: 'absolute' });
    expect(early?.difference?.kind === 'absolute' ? early.difference.amount : null).toBeCloseTo(
      0,
      10,
    );
    expect(early?.matches.map(({ matchId, value, mark }) => [matchId, value, mark])).toEqual([
      [matchIdAt(0), 6, 'weak'],
      [matchIdAt(1), 0, 'strong'],
      [matchIdAt(2), 3, null],
      [matchIdAt(3), 3, null],
      [matchIdAt(4), 3, null],
      [matchIdAt(5), 3, null],
      [matchIdAt(6), 5, null],
    ]);
  });

  it('counts mid deaths only in matches that reached 25:00', () => {
    // The tier dies 5 times (a deviation of 2) over the mid game. A match that ended at 23:20 never
    // finished it: its mid game is not counted, whatever the details say.
    const recent = [
      reviewMatch(0, phaseValues('mid', 9, 9)),
      reviewMatch(1, phaseValues('mid', 1, 1)),
      reviewMatch(2, phaseValues('mid', 5, 5)),
      // A match of exactly 25:00 has played its whole mid game.
      reviewMatch(3, phaseValues('mid', 5, 5), { durationS: 1_500 }),
      reviewMatch(4, phaseValues('mid', 5, 5), { durationS: 2_400 }),
      reviewMatch(5, phaseValues('mid', 7, 7), { durationS: 1_400 }),
    ];
    const before = [
      recentMatch(20, phaseValues('mid', 5, 5)),
      // The same rule for the earlier matches: 23:20 is not a whole mid game.
      recentMatch(21, phaseValues('mid', 20, 20), 1_400),
    ];

    const row = deathRowsOf(recent, before)[1];

    expect(row).toMatchObject({
      subject: { kind: 'phase_deaths', phase: 'mid' },
      value: 5,
      count: 5,
      comparedValue: 5,
      marked: 5,
      weak: 1,
      strong: 1,
      // One earlier match is under the five that make a figure.
      progress: { before: null, direction: null },
    });
    expect(row?.reference).toBeCloseTo(5, 10);
    expect(row?.matches.map(({ matchId, mark }) => [matchId, mark])).toEqual([
      [matchIdAt(0), 'weak'],
      [matchIdAt(1), 'strong'],
      [matchIdAt(2), null],
      [matchIdAt(3), null],
      [matchIdAt(4), null],
    ]);
  });

  it('compares the deaths of the player with the tier, above it and below it', () => {
    // The tier dies 3 times in the early game and 5 in the mid game of a 30-minute match, and 6 per
    // 10 minutes over the late game of a 45-minute one. Every match of a group is on the same side of
    // it, so the gap has a sign, and a mix-up of the two figures of the comparison would change it.
    const rowsOf = (
      earlyDeaths: number,
      midDeaths: number,
      lateWhole: number,
      lateStretch: number,
    ) =>
      deathRowsOf(
        [0, 1, 2, 3, 4].flatMap((index) => [
          reviewMatch(index, {
            ...phaseValues('early', earlyDeaths, earlyDeaths),
            ...phaseValues('mid', midDeaths, midDeaths),
          }),
          reviewMatch(10 + index, phaseValues('late', lateWhole, lateStretch), {
            durationS: LONG_DURATION_S,
          }),
        ]),
        [],
      );
    const amountOf = (row: ReviewRow | undefined): number | null =>
      row?.difference?.kind === 'absolute' ? row.difference.amount : null;

    // Above the tier: 5 early deaths against 3, 8 mid deaths against 5, and 18 deaths over the 20
    // minutes of the late stretch (9 per 10 minutes) against 6.
    const [early, mid, late] = rowsOf(5, 8, 20, 18);
    expect(early).toMatchObject({ value: 5, comparedValue: 5, weak: 5, strong: 0 });
    expect(early?.reference).toBeCloseTo(3, 10);
    expect(amountOf(early)).toBeCloseTo(2, 10);
    expect(mid).toMatchObject({ value: 8, comparedValue: 8, weak: 5, strong: 0 });
    expect(mid?.reference).toBeCloseTo(5, 10);
    expect(amountOf(mid)).toBeCloseTo(3, 10);
    expect(late).toMatchObject({ weak: 5, strong: 0 });
    // 20 deaths over the whole 21.7 minutes of the late game are 9.2 per 10 minutes, 18 over the 20
    // minutes the tier covers are 9.
    expect(late?.value).toBeCloseTo((20 / (1_300 / 60)) * 10, 8);
    expect(late?.comparedValue).toBeCloseTo(9, 10);
    expect(late?.reference).toBeCloseTo(6, 10);
    expect(amountOf(late)).toBeCloseTo(3, 10);

    // Below the tier: 1 early death, 2 mid deaths, 6 deaths over the late stretch (3 per 10 minutes).
    const [earlyBelow, midBelow, lateBelow] = rowsOf(1, 2, 8, 6);
    expect(earlyBelow).toMatchObject({ value: 1, comparedValue: 1, weak: 0, strong: 5 });
    expect(earlyBelow?.reference).toBeCloseTo(3, 10);
    expect(amountOf(earlyBelow)).toBeCloseTo(-2, 10);
    expect(midBelow).toMatchObject({ value: 2, comparedValue: 2, weak: 0, strong: 5 });
    expect(amountOf(midBelow)).toBeCloseTo(-3, 10);
    expect(lateBelow).toMatchObject({ weak: 0, strong: 5 });
    expect(lateBelow?.comparedValue).toBeCloseTo(3, 10);
    expect(lateBelow?.reference).toBeCloseTo(6, 10);
    expect(amountOf(lateBelow)).toBeCloseTo(-3, 10);
  });

  it('leaves out the deaths stored for a phase the match did not reach', () => {
    // A match of 23:20 holds a late game's deaths, which it cannot have played: they are not read.
    const recent = [
      ...[0, 1, 2, 3, 4].map((index) =>
        reviewMatch(index, phaseValues('late', 13, 12), { durationS: LONG_DURATION_S }),
      ),
      reviewMatch(5, phaseValues('late', 3, 3), { durationS: 1_400 }),
    ];
    const before = [recentMatch(20, phaseValues('late', 3, 3), 1_400)];

    const late = deathRowsOf(recent, before)[2];

    expect(late).toMatchObject({ count: 5, marked: 5 });
    expect(late?.matches.map(({ matchId }) => matchId)).not.toContain(matchIdAt(5));
  });

  it('gives late deaths per 10 minutes, over the whole phase and over the stretch of the tier', () => {
    // 45:00 matches: their late game runs from 25:00 to 46:40 (21.7 minutes), and the tier is read up
    // to 45:00 (20 minutes), where it died 12 times: 6 per 10 minutes (a deviation of 3).
    // Over that stretch, 24 deaths are two deviations above (12 per 10 minutes), none two below.
    const recent = [
      reviewMatch(0, phaseValues('late', 26, 24), { durationS: LONG_DURATION_S }),
      reviewMatch(1, phaseValues('late', 1, 0), { durationS: LONG_DURATION_S }),
      ...[2, 3, 4, 5].map((index) =>
        reviewMatch(index, phaseValues('late', 13, 12), { durationS: LONG_DURATION_S }),
      ),
      // A match that ended at 23:20 has no late game: it has no value.
      reviewMatch(6, phaseValues('mid', 5, 5), { durationS: 1_400 }),
    ];

    const late = deathRowsOf(recent, [])[2];

    expect(late).toMatchObject({
      subject: { kind: 'phase_deaths', phase: 'late' },
      unit: 'deaths_per_10_min',
      count: 6,
      weak: 1,
      strong: 1,
      marked: 6,
    });
    // 26 deaths over 21.7 minutes are 12 per 10 minutes, 13 are 6, 1 is 0.46: the figure of the
    // whole phase. The figure compared with the tier is the one of the 20 minutes it covers.
    expect(late?.value).toBeCloseTo((12 + 0.461_538_461_5 + 4 * 6) / 6, 8);
    expect(late?.comparedValue).toBeCloseTo((12 + 0 + 4 * 6) / 6, 10);
    expect(late?.reference).toBeCloseTo(6, 10);
    expect(late?.matches.map(({ value }) => value)).toEqual([
      expect.closeTo(12, 10),
      expect.closeTo(0.461_538_461_5, 8),
      expect.closeTo(6, 10),
      expect.closeTo(6, 10),
      expect.closeTo(6, 10),
      expect.closeTo(6, 10),
    ]);
    expect(late?.matches.map(({ mark }) => mark)).toEqual([
      'weak',
      'strong',
      null,
      null,
      null,
      null,
    ]);
  });

  it('counts a match it cannot compare with the tier without marking it', () => {
    const flat: CommunityReference = {
      ...referenceFor(DURATION_S),
      curve: [deathsPoint(600, 3, 0), deathsPoint(1_500, 8, 0)],
    };
    const recent = [
      // No tier data cached.
      reviewMatch(0, phaseValues('early', 6, 6), { reference: null }),
      // Tier data of another duration window than the one the stored deaths were counted for.
      reviewMatch(1, phaseValues('early', 6, 6), { reference: referenceFor(2_400) }),
      // A curve that does not reach the stretch.
      reviewMatch(2, phaseValues('early', 6, 6), {
        reference: { ...referenceFor(DURATION_S), curve: [] },
      }),
      // A curve with no spread to place the deaths on.
      reviewMatch(3, phaseValues('early', 6, 6), { reference: flat }),
      // Deaths over the whole phase only: the stretch the tier covers has no count.
      reviewMatch(4, { [phaseDeathsKey('early')]: 6 }),
    ];

    const early = deathRowsOf(recent, [])[0];

    expect(early).toMatchObject({
      value: 6,
      count: 5,
      marked: 0,
      weak: 0,
      strong: 0,
      comparedValue: null,
      reference: null,
      difference: null,
    });
    expect(early?.matches.map(({ mark }) => mark)).toEqual([null, null, null, null, null]);
  });
});

describe('avoidableDeathsRowOf', () => {
  /**
   * The last matches of the tests, with the avoidable deaths stored for each: the tier's data is
   * cached for all of them, to show that the row never reads it.
   *
   * @param counts - The avoidable deaths of each match, most recent first, `null` for a match that
   *   has no count.
   * @returns The matches.
   */
  function recentWithAvoidable(counts: readonly (number | null)[]): ReviewMatch[] {
    return counts.map((count, index) =>
      reviewMatch(index, count === null ? {} : { [AVOIDABLE_DEATHS_KEY]: count }),
    );
  }

  it('averages the avoidable deaths of the matches that have positions', () => {
    const row = avoidableDeathsRowOf(recentWithAvoidable([4, 1, 0, 1, 2, 0]), []);

    expect(row).toMatchObject({
      subject: { kind: 'avoidable_deaths' },
      unit: 'deaths',
      better: 'lower',
      // The mean counts (8 / 6), not the median (1).
      value: 8 / 6,
      count: 6,
    });
    expect(row.matches.map(({ matchId, value }) => [matchId, value])).toEqual([
      [matchIdAt(0), 4],
      [matchIdAt(1), 1],
      [matchIdAt(2), 0],
      [matchIdAt(3), 1],
      [matchIdAt(4), 2],
      [matchIdAt(5), 0],
    ]);
  });

  it('marks a match weak from two avoidable deaths and strong at none', () => {
    const row = avoidableDeathsRowOf(recentWithAvoidable([5, 2, 1, 0, 0, 3]), []);

    expect(row.matches.map(({ mark }) => mark)).toEqual([
      'weak',
      'weak',
      null,
      'strong',
      'strong',
      'weak',
    ]);
    // A match with one avoidable death is judged, and neither weak nor strong.
    expect(row).toMatchObject({ weak: 3, strong: 2, marked: 6, side: 'weakness' });
  });

  it('leaves out the matches without positions and counts the rest', () => {
    const row = avoidableDeathsRowOf(recentWithAvoidable([1, null, 0, null, 1, 1, 0]), []);

    // The two matches with no count are not in the row, and are not taken for zero.
    expect(row.count).toBe(5);
    expect(row.marked).toBe(5);
    expect(row.value).toBe(3 / 5);
    expect(row.matches.map(({ matchId }) => matchId)).toEqual([
      matchIdAt(0),
      matchIdAt(2),
      matchIdAt(4),
      matchIdAt(5),
      matchIdAt(6),
    ]);
  });

  it('has no tier figure', () => {
    const row = avoidableDeathsRowOf(recentWithAvoidable([3, 3, 3, 3, 3, 0]), []);

    expect(row).toMatchObject({
      comparedValue: null,
      reference: null,
      difference: null,
      gapWithinNoise: false,
    });
  });

  it('compares with the twenty matches before', () => {
    const recent = recentWithAvoidable([0, 1, 0, 1, 0]);
    // The matches before: the figure before is their mean, 3, and a match with no count is left out.
    const before = [4, 2, 3, 3, 3].map((count, index) =>
      recentMatch(20 + index, { [AVOIDABLE_DEATHS_KEY]: count }),
    );

    const row = avoidableDeathsRowOf(recent, [...before, recentMatch(25, {})]);

    // Fewer avoidable deaths than before is better.
    expect(row.value).toBe(0.4);
    expect(row.progress).toEqual({ before: 3, direction: 'better' });
  });
});
