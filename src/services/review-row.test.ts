/**
 * Tests of the row of a point of the review ({@link reviewRowOf}), of the basis a match is placed
 * from ({@link placementBasisOf}) and of the skeleton the tabs build their points on
 * ({@link pointRowOf}), on judged matches written by hand: the player's figure, the comparison with
 * the tier, the counts of weak and strong matches and the progress, each centred on the median or on
 * the mean, and each held back under five matches.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { durationWindowOf } from '../core/analysis/cohort';
import { phaseSpans } from '../core/analysis/phases';
import type { ReviewMark } from '../core/analysis/review/review-rules';
import { testMatchId } from '../test/test-data';
import type { CommunityComparison, CommunityReference } from './community-placement';
import type { RecentMatch } from './metrics.repository';
import {
  UNJUDGED,
  placeMatches,
  placeReviewMatches,
  placementBasisOf,
  pointMatchesOf,
  pointRowOf,
  reviewRowOf,
  type JudgedMatch,
  type PlacedMatch,
  type PlacedReviewMatch,
  type ReviewPoint,
  type ReviewRowInput,
  type Verdict,
} from './review-row';

/** The id of the most recent match of the tests; the earlier ones count down from it. */
const LAST_MATCH_ID = 800_000;

/** The start of the most recent match of the tests, in Unix seconds. */
const LAST_START_TIME = 1_790_000_000;

/** The time between the starts of two matches of the tests, in seconds. */
const MATCH_GAP_S = 3_600;

/** What a judged match of the tests says besides its value. */
interface Judgement {
  /** The value of the point in the match. */
  readonly value: number;
  /** Its mark; none by default. */
  readonly mark?: ReviewMark | null;
  /** Whether a rule judged the match. */
  readonly marked?: boolean;
  /** Its two figures of the comparison with the tier; none by default. */
  readonly comparison?: CommunityComparison | null;
}

/**
 * One of the last matches, judged on the point of the tests.
 *
 * @param index - Its place from the most recent match: its id and start count down with it.
 * @param judgement - What is known of the match; a match is not marked or compared by default.
 * @returns The judged match.
 */
function judgedMatch(index: number, judgement: Judgement): JudgedMatch {
  const { value, mark = null, marked = false, comparison = null } = judgement;
  return {
    entry: {
      matchId: testMatchId(LAST_MATCH_ID - index),
      startTime: LAST_START_TIME - index * MATCH_GAP_S,
      value,
      mark,
    },
    marked,
    comparison,
  };
}

/**
 * Judged matches that are all compared with the tier.
 *
 * @param pairs - The player's figure and the tier's figure of each match, the most recent first;
 *   the value of the match is the player's figure.
 * @returns The judged matches, marked by no rule.
 */
function comparedMatches(
  pairs: readonly (readonly [player: number, community: number])[],
): JudgedMatch[] {
  return pairs.map(([player, community], index) =>
    judgedMatch(index, { value: player, comparison: { player, community } }),
  );
}

/**
 * Sum up a point of the tests: a count of deaths, better lower, around the mean.
 *
 * @param overrides - What differs from that point with no match at all.
 * @returns The row.
 */
function rowOf(overrides: Partial<ReviewRowInput>): ReturnType<typeof reviewRowOf> {
  return reviewRowOf({
    subject: { kind: 'metric', key: 'deaths' },
    unit: 'count',
    better: 'lower',
    display: 'absolute',
    center: 'mean',
    judged: [],
    before: [],
    ...overrides,
  });
}

describe('reviewRowOf', () => {
  it('says nothing of a point no match has a value for', () => {
    expect(rowOf({})).toEqual({
      subject: { kind: 'metric', key: 'deaths' },
      unit: 'count',
      better: 'lower',
      value: null,
      count: 0,
      comparedValue: null,
      reference: null,
      difference: null,
      gapWithinNoise: false,
      weak: 0,
      strong: 0,
      marked: 0,
      side: null,
      progress: { before: null, direction: null },
      matches: [],
    });
  });

  it('centres the figure on the mean for a mean row and on the median for a median row', () => {
    // Four small values and a big one: the mean is 3, the median is 1.
    const judged = [1, 1, 1, 1, 11].map((value, index) => judgedMatch(index, { value }));

    expect(rowOf({ center: 'mean', judged })).toMatchObject({ value: 3, count: 5 });
    expect(rowOf({ center: 'median', judged })).toMatchObject({ value: 1, count: 5 });
  });

  it('centres both figures of the comparison like the row, whichever side is skewed', () => {
    // The player's figures are skewed (a mean of 3 against a median of 1), and so are the tier's
    // (a mean of 4 against a median of 2): a figure centred the other way gives another number.
    const judged = comparedMatches([
      [1, 2],
      [1, 2],
      [1, 2],
      [1, 2],
      [11, 12],
    ]);

    const mean = rowOf({ center: 'mean', judged });
    expect(mean).toMatchObject({ value: 3, comparedValue: 3, reference: 4 });
    expect(mean.difference).toEqual({ kind: 'absolute', amount: -1 });

    const median = rowOf({ center: 'median', judged });
    expect(median).toMatchObject({ value: 1, comparedValue: 1, reference: 2 });
    expect(median.difference).toEqual({ kind: 'absolute', amount: -1 });
  });

  it('takes the comparison of the matches compared with the tier only', () => {
    // Seven matches have a value, five are compared: the tier's figure and the figure it is compared
    // with are those of the five, the player's figure is the one of the seven.
    const judged = [
      ...comparedMatches([
        [2, 4],
        [2, 4],
        [2, 4],
        [2, 4],
        [12, 4],
      ]),
      judgedMatch(5, { value: 30 }),
      judgedMatch(6, { value: 30 }),
    ];

    expect(rowOf({ judged })).toMatchObject({
      value: (2 * 4 + 12 + 60) / 7,
      count: 7,
      comparedValue: 4,
      reference: 4,
      difference: { kind: 'absolute', amount: 0 },
    });
  });

  it('tells a gap within the noise of the compared matches from one outside it', () => {
    // The player's compared figures are 4, 6, 2, 8 and 0: a mean of 4 and a sample variance of 10,
    // so the standard error of that mean is √(10 / 5) = √2, about 1.41. The tier's figure counts as
    // exact.
    const player = [4, 6, 2, 8, 0];
    const against = (community: number) =>
      comparedMatches(player.map((value) => [value, community] as const));

    // A gap of 1 is within the noise, on either side of the tier.
    expect(rowOf({ judged: against(5) })).toMatchObject({
      difference: { kind: 'absolute', amount: -1 },
      gapWithinNoise: true,
    });
    expect(rowOf({ judged: against(3) }).gapWithinNoise).toBe(true);
    // A gap of 2 is outside it.
    expect(rowOf({ judged: against(6) })).toMatchObject({
      difference: { kind: 'absolute', amount: -2 },
      gapWithinNoise: false,
    });
    // The rule weighs the figures and not how the gap is shown: a share of the tier is weighed the
    // same way.
    expect(rowOf({ judged: against(5), display: 'relative' }).gapWithinNoise).toBe(true);
    expect(rowOf({ judged: against(6), display: 'relative' }).gapWithinNoise).toBe(false);
  });

  it('weighs the gap against the compared matches only, around the centre of the row', () => {
    // Two matches have a value but no comparison: their spread is not the comparison's.
    const judged = [
      ...comparedMatches([
        [4, 5],
        [6, 5],
        [2, 5],
        [8, 5],
        [0, 5],
      ]),
      judgedMatch(5, { value: 40 }),
      judgedMatch(6, { value: -40 }),
    ];
    expect(rowOf({ judged }).gapWithinNoise).toBe(true);
    // The median of the compared figures is 4 too, and the gap of 1 is still within the noise.
    expect(rowOf({ judged, center: 'median' }).gapWithinNoise).toBe(true);
  });

  it('calls no gap noise when there is no gap', () => {
    // Four compared matches give no tier figure, so there is no gap to weigh.
    const judged = comparedMatches([
      [4, 5],
      [6, 5],
      [2, 5],
      [8, 5],
    ]);
    expect(rowOf({ judged })).toMatchObject({ difference: null, gapWithinNoise: false });
  });

  it('shows the gap as a share of the tier when the display says so', () => {
    const judged = comparedMatches([
      [6, 4],
      [6, 4],
      [6, 4],
      [6, 4],
      [6, 4],
    ]);

    expect(rowOf({ judged, display: 'relative' }).difference).toEqual({
      kind: 'relative',
      ratio: 0.5,
    });
  });

  it('gives no figure under five values, but counts them', () => {
    const judged = comparedMatches([
      [2, 4],
      [3, 4],
      [4, 4],
      [5, 4],
    ]);

    expect(rowOf({ judged })).toMatchObject({
      value: null,
      count: 4,
      comparedValue: null,
      reference: null,
      difference: null,
    });
    expect(rowOf({ judged }).matches).toHaveLength(4);
  });

  it('gives no tier figure under five compared matches, whatever the number of values', () => {
    // Six matches have a value, four are compared: the player's figure is there, the comparison is
    // not (four matches say too little about the tier's figure and about the gap).
    const judged = [
      ...comparedMatches([
        [2, 4],
        [3, 4],
        [4, 4],
        [5, 4],
      ]),
      judgedMatch(4, { value: 6 }),
      judgedMatch(5, { value: 7 }),
    ];

    expect(rowOf({ judged })).toMatchObject({
      value: 27 / 6,
      count: 6,
      comparedValue: null,
      reference: null,
      difference: null,
    });
  });

  it('counts the weak and the strong matches among the ones a rule judged', () => {
    const judged = [
      judgedMatch(0, { value: 1, marked: true, mark: 'weak' }),
      judgedMatch(1, { value: 2, marked: true, mark: 'weak' }),
      judgedMatch(2, { value: 3, marked: true, mark: 'strong' }),
      judgedMatch(3, { value: 4, marked: true, mark: null }),
      judgedMatch(4, { value: 5, marked: true, mark: null }),
      // A match no rule judged is in the figures and in none of the counts.
      judgedMatch(5, { value: 6 }),
      judgedMatch(6, { value: 7 }),
    ];

    const row = rowOf({ judged });

    expect(row).toMatchObject({ weak: 2, strong: 1, marked: 5, count: 7, side: 'weakness' });
    expect(row.matches.map(({ value, mark }) => [value, mark])).toEqual([
      [1, 'weak'],
      [2, 'weak'],
      [3, 'strong'],
      [4, null],
      [5, null],
      [6, null],
      [7, null],
    ]);
  });

  it('lists the point on the side it is flagged on in a meaningful share of the matches', () => {
    const strongTwice = [
      judgedMatch(0, { value: 1, marked: true, mark: 'strong' }),
      judgedMatch(1, { value: 1, marked: true, mark: 'strong' }),
      ...[2, 3, 4, 5, 6, 7].map((index) => judgedMatch(index, { value: 1, marked: true })),
    ];
    const weakOnce = [
      judgedMatch(0, { value: 1, marked: true, mark: 'weak' }),
      ...[1, 2, 3, 4, 5, 6, 7].map((index) => judgedMatch(index, { value: 1, marked: true })),
    ];

    // Two of eight is a quarter, enough; one of eight is a few games, not a habit.
    expect(rowOf({ judged: strongTwice }).side).toBe('strength');
    expect(rowOf({ judged: weakOnce }).side).toBeNull();
  });

  it('measures progress around the same centre as the row', () => {
    const judged = [1, 1, 1, 1, 1].map((value, index) => judgedMatch(index, { value }));
    // One odd match before: the figure before is 3 around the mean, 1 around the median.
    const before = [1, 1, 1, 1, 11];

    expect(rowOf({ judged, before, center: 'mean' }).progress.before).toBe(3);
    expect(rowOf({ judged, before, center: 'median' }).progress.before).toBe(1);
  });

  it('reads the direction of the progress from which way is better', () => {
    const judged = [2, 2, 2, 2, 2].map((value, index) => judgedMatch(index, { value }));
    const before = [6, 6, 6, 6, 6];

    // Fewer deaths than before is better; the same figures for a point that is better higher are not.
    expect(rowOf({ judged, before, better: 'lower' }).progress).toEqual({
      before: 6,
      direction: 'better',
    });
    expect(rowOf({ judged, before, better: 'higher' }).progress).toEqual({
      before: 6,
      direction: 'worse',
    });
    // A point that is neither has no direction, but still its figure before.
    expect(rowOf({ judged, before, better: null }).progress).toEqual({
      before: 6,
      direction: null,
    });
  });

  it('gives no figure before under five earlier values', () => {
    const judged = [2, 2, 2, 2, 2].map((value, index) => judgedMatch(index, { value }));

    expect(rowOf({ judged, before: [6, 6, 6, 6] }).progress).toEqual({
      before: null,
      direction: null,
    });
  });
});

describe('placementBasisOf', () => {
  it('works out the phases and the duration window from the length the database holds', () => {
    const match: RecentMatch = {
      matchId: testMatchId(LAST_MATCH_ID),
      startTime: LAST_START_TIME,
      durationS: 1_800,
      values: new Map([['deaths', 5]]),
    };

    const basis = placementBasisOf(match);

    expect(basis.spans).toEqual(phaseSpans(1_800));
    expect(basis.ratesWindow).toEqual(durationWindowOf(1_800));
    expect(basis.ratesWindow).toEqual({ minS: 1_800, maxS: 2_099 });
    // The values are the ones of the match, not a copy that could drift from them.
    expect(basis.values).toBe(match.values);
  });
});

/**
 * One of the player's matches, numbered from the most recent (0) back, that stores a count of
 * deaths, or none.
 *
 * @param index - Its place from the most recent match: its id and start count down with it.
 * @param deaths - The deaths it stores, or `null` for a match that does not tell.
 * @returns The match.
 */
function deathsMatch(index: number, deaths: number | null): RecentMatch {
  return {
    matchId: testMatchId(LAST_MATCH_ID - index),
    startTime: LAST_START_TIME - index * MATCH_GAP_S,
    durationS: 1_800,
    values: new Map(deaths === null ? [] : [['deaths', deaths]]),
  };
}

/** The tier's data of the tests: nothing to read, as the judges of the tests ignore it. */
const REFERENCE: CommunityReference = {
  benchmark: new Map(),
  curve: [],
  window: durationWindowOf(1_800),
};

/** A point as a tab builds it, on last matches that are placed. */
type DeathsPoint = ReviewPoint<PlacedReviewMatch, PlacedMatch>;

/**
 * The point of the tests: the deaths a match stores, better lower, around the mean. A match is
 * strong from three deaths down and weak from six, and is compared with a tier that dies four times.
 *
 * @param overrides - What differs from that point.
 * @returns The point.
 */
function deathsPoint(overrides: Partial<DeathsPoint> = {}): DeathsPoint {
  return {
    subject: { kind: 'metric', key: 'deaths' },
    unit: 'count',
    better: 'lower',
    display: 'absolute',
    center: 'mean',
    valueIn: ({ match }) => match.values.get('deaths') ?? null,
    judge: (_placed, deaths): Verdict => ({
      mark: deaths >= 6 ? 'weak' : deaths <= 3 ? 'strong' : null,
      marked: true,
      comparison: { player: deaths, community: 4 },
    }),
    ...overrides,
  };
}

/**
 * The last matches of the tests, placed.
 *
 * @param deaths - The deaths each stores, the most recent first.
 * @returns The matches, each with the tier's data.
 */
function placedLast(deaths: readonly (number | null)[]): PlacedReviewMatch[] {
  return placeReviewMatches(
    deaths.map((count, index) => ({ match: deathsMatch(index, count), reference: REFERENCE })),
  );
}

describe('pointRowOf', () => {
  it('leaves out a match without a value, and asks the judge only about the others', () => {
    const asked: number[] = [];
    const point = deathsPoint({
      judge: (_placed, deaths) => {
        asked.push(deaths);
        return UNJUDGED;
      },
    });

    const row = pointRowOf(point, placedLast([3, null, 4, null, 5, 6, 7]), []);

    // Five of the seven matches tell; the others are neither counted nor taken for zero deaths.
    expect(asked).toEqual([3, 4, 5, 6, 7]);
    expect(row).toMatchObject({ count: 5, value: 5 });
    expect(row.matches.map(({ matchId }) => matchId)).toEqual(
      [0, 2, 4, 5, 6].map((index) => testMatchId(LAST_MATCH_ID - index)),
    );
  });

  it('reads the earlier matches with the same reader, and leaves out those without a value', () => {
    const before = placeMatches(
      [10, null, 10, 10, null, 10, 10].map((deaths, index) => deathsMatch(20 + index, deaths)),
    );

    const row = pointRowOf(deathsPoint(), placedLast([3, 4, 5, 6, 7]), before);

    // The five earlier values are 10; the two matches that do not tell are not zeros among them.
    expect(row.progress).toEqual({ before: 10, direction: 'better' });
  });

  it('centres the figure and the progress on the centre of the point', () => {
    const last = placedLast([1, 1, 1, 1, 1]);
    // One odd match before: 3 around the mean, 1 around the median.
    const before = placeMatches(
      [1, 1, 1, 1, 11].map((deaths, index) => deathsMatch(20 + index, deaths)),
    );

    expect(pointRowOf(deathsPoint({ center: 'mean' }), last, before).progress.before).toBe(3);
    expect(pointRowOf(deathsPoint({ center: 'median' }), last, before).progress.before).toBe(1);
  });

  it('passes the subject, the unit, the direction and the display of the point to the row', () => {
    const point = deathsPoint({
      subject: { kind: 'phase_deaths', phase: 'late' },
      unit: 'deaths_per_10_min',
      better: null,
      display: 'relative',
    });

    const row = pointRowOf(point, placedLast([2, 3, 4, 5, 6]), []);

    expect(row).toMatchObject({
      subject: { kind: 'phase_deaths', phase: 'late' },
      unit: 'deaths_per_10_min',
      better: null,
    });
    // Four deaths compared with the tier's four, as a share of it: the display of the point.
    expect(row.difference).toMatchObject({ kind: 'relative' });
  });

  it('passes the verdict of the judge through to the entry and to the counts', () => {
    const row = pointRowOf(deathsPoint(), placedLast([2, 7, 4, 5, 5, 6]), []);

    expect(row.matches.map(({ value, mark }) => [value, mark])).toEqual([
      [2, 'strong'],
      [7, 'weak'],
      [4, null],
      [5, null],
      [5, null],
      [6, 'weak'],
    ]);
    expect(row).toMatchObject({ weak: 2, strong: 1, marked: 6, side: 'weakness' });
    // Both figures of the comparison are the judge's: 29 / 6 against 4.
    expect(row.comparedValue).toBeCloseTo(29 / 6, 10);
    expect(row.reference).toBe(4);
    expect(row.difference).toEqual({ kind: 'absolute', amount: 29 / 6 - 4 });
  });

  it('counts a match no rule judged with its value, and without a mark or a comparison', () => {
    const point = deathsPoint({ judge: () => UNJUDGED });

    const row = pointRowOf(point, placedLast([2, 3, 4, 5, 6]), []);

    expect(row).toMatchObject({
      value: 4,
      count: 5,
      marked: 0,
      weak: 0,
      strong: 0,
      comparedValue: null,
      reference: null,
    });
    expect(row.matches.map(({ mark }) => mark)).toEqual([null, null, null, null, null]);
  });

  it('hands the judge the match with its tier data and its basis', () => {
    const seen: PlacedReviewMatch[] = [];
    const point = deathsPoint({
      judge: (placed) => {
        seen.push(placed);
        return UNJUDGED;
      },
    });

    pointRowOf(point, placedLast([5]), []);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.reference).toBe(REFERENCE);
    expect(seen[0]?.basis).toEqual(placementBasisOf(deathsMatch(0, 5)));
  });
});

describe('the placed matches', () => {
  it('places each match once, in the same order', () => {
    const matches = [deathsMatch(0, 3), deathsMatch(1, null)];

    const placed = placeMatches(matches);

    expect(placed.map(({ match }) => match)).toEqual(matches);
    expect(placed.map(({ basis }) => basis)).toEqual(
      matches.map((match) => placementBasisOf(match)),
    );
  });

  it('keeps the tier data of a last match, or its absence, and adds the basis', () => {
    const first = { match: deathsMatch(0, 3), reference: REFERENCE };
    const second = { match: deathsMatch(1, 4), reference: null };

    const placed = placeReviewMatches([first, second]);

    expect(placed.map(({ match, reference }) => [match, reference])).toEqual([
      [first.match, REFERENCE],
      [second.match, null],
    ]);
    expect(placed[0]?.basis).toEqual(placementBasisOf(first.match));
    expect(placed[1]?.basis).toEqual(placementBasisOf(second.match));
  });

  it('carries matches that are read from their values alone', () => {
    const matches = [deathsMatch(0, 3), deathsMatch(1, 4)];

    expect(pointMatchesOf(matches)).toEqual([{ match: matches[0] }, { match: matches[1] }]);
  });
});
