/**
 * Tests of the insights of a match: how a metric's two signals (its place in the rank, its gap with
 * the player's habits) become a score, which metrics are strengths or weaknesses, and which three of
 * each the summary keeps.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { present } from '../../../test/analysis-context';
import {
  confidenceOf,
  selectInsights,
  type Confidence,
  type Insight,
  type InsightCandidate,
} from './insights';
import {
  COMMUNITY_WEIGHT,
  CURVE_ABOVE_Z,
  CURVE_WELL_Z,
  INSIGHTS_PER_SIDE,
  MAD_SCALE,
  MIN_COHORT_MATCHES,
  MIN_PERSONAL_MATCHES,
  MIN_PHASE_MINUTES,
  PERSONAL_WEIGHT,
  PERSONAL_WINDOW,
  PERSONAL_Z_DIVISOR,
  SHORT_MATCH_S,
  STRENGTH_PERCENTILE,
  STRONG_Z,
  WEAKNESS_PERCENTILE,
} from './thresholds';

/** A match of a normal length, without a leaver: its confidence only depends on the references. */
const longMatch = { durationS: 1_800, hasLeaver: false };

/**
 * Build a candidate. By default it has no signal at all and is the one-metric group `kda`, so each
 * test only spells out what it exercises.
 *
 * @param overrides - The fields to set.
 * @returns The candidate.
 */
function cand(overrides: Partial<InsightCandidate> = {}): InsightCandidate {
  return {
    key: 'kda',
    group: 'kda',
    better: 'higher',
    communityPercentile: null,
    personalZ: null,
    ...overrides,
  };
}

/**
 * The keys of a list of insights, in order: what a test checks when only the selection and the
 * order matter.
 *
 * @param insights - The insights.
 * @returns Their metric keys.
 */
function keysOf(insights: readonly Insight[]): string[] {
  return insights.map((insight) => insight.key);
}

describe('thresholds', () => {
  it('pins every threshold', () => {
    expect({
      COMMUNITY_WEIGHT,
      PERSONAL_WEIGHT,
      STRENGTH_PERCENTILE,
      WEAKNESS_PERCENTILE,
      STRONG_Z,
      MAD_SCALE,
      PERSONAL_Z_DIVISOR,
      PERSONAL_WINDOW,
      MIN_PERSONAL_MATCHES,
      MIN_PHASE_MINUTES,
      MIN_COHORT_MATCHES,
      SHORT_MATCH_S,
      CURVE_ABOVE_Z,
      CURVE_WELL_Z,
      INSIGHTS_PER_SIDE,
    }).toEqual({
      COMMUNITY_WEIGHT: 0.6,
      PERSONAL_WEIGHT: 0.4,
      STRENGTH_PERCENTILE: 70,
      WEAKNESS_PERCENTILE: 30,
      STRONG_Z: 1,
      MAD_SCALE: 1.4826,
      PERSONAL_Z_DIVISOR: 2,
      PERSONAL_WINDOW: 20,
      MIN_PERSONAL_MATCHES: 5,
      MIN_PHASE_MINUTES: 3,
      MIN_COHORT_MATCHES: 200,
      SHORT_MATCH_S: 900,
      CURVE_ABOVE_Z: 0.5,
      CURVE_WELL_Z: 1,
      INSIGHTS_PER_SIDE: 3,
    });
  });
});

describe('selectInsights: scoring', () => {
  it('scores and classifies a strength', () => {
    // p 84 gives c 0.68 and z 1.349 gives s 0.6745, so the score is 0.6 × 0.68 + 0.4 × 0.6745.
    const result = selectInsights([cand({ communityPercentile: 84, personalZ: 1.349 })], longMatch);

    expect(result.weaknesses).toEqual([]);
    expect(result.strengths).toHaveLength(1);
    const strength = present(result.strengths[0]);
    expect(strength.key).toBe('kda');
    expect(strength.side).toBe('strength');
    expect(strength.score).toBeCloseTo(0.6778, 4);
  });

  it('scores a weakness with a negative score', () => {
    // p 10 gives c −0.8 and z −1.5 gives s −0.75: 0.6 × −0.8 + 0.4 × −0.75 = −0.78.
    const result = selectInsights([cand({ communityPercentile: 10, personalZ: -1.5 })], longMatch);

    expect(result.strengths).toEqual([]);
    const weakness = present(result.weaknesses[0]);
    expect(weakness.side).toBe('weakness');
    expect(weakness.score).toBeCloseTo(-0.78, 4);
  });

  it('lets the score decide when the signals disagree', () => {
    // p 75 (c 0.5) alone would make a strength and z −2 (s −1) alone a weakness; the score
    // 0.6 × 0.5 + 0.4 × −1 = −0.1 settles it: a weakness, not a strength.
    const result = selectInsights([cand({ communityPercentile: 75, personalZ: -2 })], longMatch);

    expect(result.strengths).toEqual([]);
    expect(result.weaknesses).toHaveLength(1);
    expect(present(result.weaknesses[0]).score).toBeCloseTo(-0.1, 4);
  });

  it('clamps the personal signal to [-1, 1]', () => {
    const result = selectInsights(
      [
        cand({ key: 'accuracy', group: 'accuracy', communityPercentile: 50, personalZ: 10 }),
        cand({ key: 'denies', group: 'denies', communityPercentile: 50, personalZ: -10 }),
      ],
      longMatch,
    );

    // c 0, s ±1: the score is 0.4 × ±1.
    expect(present(result.strengths[0]).score).toBeCloseTo(0.4, 4);
    expect(present(result.weaknesses[0]).score).toBeCloseTo(-0.4, 4);
  });

  it('makes no insight when the score is exactly 0, whichever signal is strong', () => {
    // p 70 gives c 0.4 and z −1.2 gives s −0.6: 0.6 × 0.4 and 0.4 × −0.6 cancel out. The percentile
    // reaches the strength bar and the z-score reaches the weakness bar, but neither side has a
    // score of the right sign.
    const result = selectInsights([cand({ communityPercentile: 70, personalZ: -1.2 })], longMatch);

    expect(result).toEqual({ strengths: [], weaknesses: [] });
  });

  it('makes no insight when neither signal is strong enough', () => {
    // p 60 and z 0.5 give a positive score (0.6 × 0.2 + 0.4 × 0.25 = 0.22), under both bars.
    const result = selectInsights([cand({ communityPercentile: 60, personalZ: 0.5 })], longMatch);

    expect(result).toEqual({ strengths: [], weaknesses: [] });
  });

  it('makes no insight without any signal', () => {
    const result = selectInsights([cand()], longMatch);

    expect(result).toEqual({ strengths: [], weaknesses: [] });
  });

  it('makes no insight from no candidate', () => {
    expect(selectInsights([], longMatch)).toEqual({ strengths: [], weaknesses: [] });
  });
});

describe('selectInsights: orientation', () => {
  it('orients a lower-is-better metric', () => {
    // Deaths: p 15 means few deaths among the community, p' 85, which is a strength of 0.7.
    const result = selectInsights(
      [cand({ key: 'deaths', group: 'deaths', better: 'lower', communityPercentile: 15 })],
      longMatch,
    );

    expect(result.weaknesses).toEqual([]);
    const strength = present(result.strengths[0]);
    expect(strength.key).toBe('deaths');
    expect(strength.score).toBeCloseTo(0.7, 4);
  });

  it('orients the habits of a lower-is-better metric too', () => {
    // Fewer deaths than usual (z −2) is z' 2, so s 1; with p 15 (p' 85, c 0.7): 0.42 + 0.4 = 0.82.
    const result = selectInsights(
      [
        cand({
          key: 'deaths',
          group: 'deaths',
          better: 'lower',
          communityPercentile: 15,
          personalZ: -2,
        }),
      ],
      longMatch,
    );

    expect(present(result.strengths[0]).score).toBeCloseTo(0.82, 4);
  });

  it('makes a weakness of a lower-is-better metric that is high', () => {
    // p 90 means many deaths, p' 10, a weakness of −0.8.
    const result = selectInsights(
      [cand({ key: 'deaths', group: 'deaths', better: 'lower', communityPercentile: 90 })],
      longMatch,
    );

    expect(result.strengths).toEqual([]);
    expect(present(result.weaknesses[0]).score).toBeCloseTo(-0.8, 4);
  });

  it('leaves a higher-is-better metric as it is', () => {
    // The same p 15 that is a strength for deaths is a weakness for a higher-is-better metric.
    const result = selectInsights([cand({ communityPercentile: 15 })], longMatch);

    expect(result.strengths).toEqual([]);
    expect(present(result.weaknesses[0]).score).toBeCloseTo(-0.7, 4);
  });
});

describe('selectInsights: one signal alone', () => {
  it('uses the community signal alone, unweighted', () => {
    // p 90 gives c 0.8: not 0.6 × 0.8.
    const result = selectInsights([cand({ communityPercentile: 90 })], longMatch);

    expect(present(result.strengths[0]).score).toBeCloseTo(0.8, 4);
  });

  it('uses the personal signal alone, unweighted', () => {
    // z 3 gives s 1 (clamped): not 0.4 × 1.
    const result = selectInsights([cand({ personalZ: 3 })], longMatch);

    expect(present(result.strengths[0]).score).toBeCloseTo(1, 4);
  });

  it('uses a negative personal signal alone as a weakness', () => {
    const result = selectInsights([cand({ personalZ: -1.5 })], longMatch);

    expect(result.strengths).toEqual([]);
    expect(present(result.weaknesses[0]).score).toBeCloseTo(-0.75, 4);
  });
});

describe('selectInsights: classification edges', () => {
  it.each([
    { name: 'p 70 is a strength', percentile: 70, expected: 'strength' },
    { name: 'p just under 70 is neither', percentile: 69.9, expected: 'none' },
    { name: 'p 30 is a weakness', percentile: 30, expected: 'weakness' },
    { name: 'p just over 30 is neither', percentile: 30.1, expected: 'none' },
  ] as const)('the community alone: $name', ({ percentile, expected }) => {
    const result = selectInsights([cand({ communityPercentile: percentile })], longMatch);

    expect({
      strengths: result.strengths.length,
      weaknesses: result.weaknesses.length,
    }).toEqual({
      strengths: expected === 'strength' ? 1 : 0,
      weaknesses: expected === 'weakness' ? 1 : 0,
    });
  });

  it.each([
    { name: 'z 1 is a strength', z: 1, expected: 'strength' },
    { name: 'z just under 1 is neither', z: 0.99, expected: 'none' },
    { name: 'z -1 is a weakness', z: -1, expected: 'weakness' },
    { name: 'z just over -1 is neither', z: -0.99, expected: 'none' },
  ] as const)('the habits alone: $name', ({ z, expected }) => {
    const result = selectInsights([cand({ personalZ: z })], longMatch);

    expect({
      strengths: result.strengths.length,
      weaknesses: result.weaknesses.length,
    }).toEqual({
      strengths: expected === 'strength' ? 1 : 0,
      weaknesses: expected === 'weakness' ? 1 : 0,
    });
  });

  it('applies the percentile bars after the orientation', () => {
    // For a lower-is-better metric, p 30 is p' 70 (a strength) and p 70 is p' 30 (a weakness).
    const strong = selectInsights([cand({ better: 'lower', communityPercentile: 30 })], longMatch);
    const weak = selectInsights([cand({ better: 'lower', communityPercentile: 70 })], longMatch);

    expect(strong.strengths).toHaveLength(1);
    expect(weak.weaknesses).toHaveLength(1);
  });

  it('reaches a strength through either signal', () => {
    // p 60 is under the percentile bar but z 2 reaches the z bar; the score is 0.12 + 0.4 = 0.52.
    const result = selectInsights([cand({ communityPercentile: 60, personalZ: 2 })], longMatch);

    expect(present(result.strengths[0]).score).toBeCloseTo(0.52, 4);
  });
});

describe('selectInsights: selection', () => {
  it('keeps one insight per group and side', () => {
    // Two ways to say the same thing about souls: only the stronger (0.7) is shown.
    const result = selectInsights(
      [
        cand({ key: 'souls_per_min', group: 'souls', communityPercentile: 75 }),
        cand({ key: 'souls_at_10min', group: 'souls', communityPercentile: 85 }),
      ],
      longMatch,
    );

    expect(keysOf(result.strengths)).toEqual(['souls_at_10min']);
    expect(present(result.strengths[0]).score).toBeCloseTo(0.7, 4);
  });

  it('keeps the stronger of a group whichever comes first', () => {
    const result = selectInsights(
      [
        cand({ key: 'souls_at_10min', group: 'souls', communityPercentile: 85 }),
        cand({ key: 'souls_per_min', group: 'souls', communityPercentile: 75 }),
      ],
      longMatch,
    );

    expect(keysOf(result.strengths)).toEqual(['souls_at_10min']);
  });

  it('keeps the first of a group when two are equally strong', () => {
    const result = selectInsights(
      [
        cand({ key: 'souls_per_min', group: 'souls', communityPercentile: 85 }),
        cand({ key: 'souls_at_10min', group: 'souls', communityPercentile: 85 }),
      ],
      longMatch,
    );

    expect(keysOf(result.strengths)).toEqual(['souls_per_min']);
  });

  it('keeps one weakness per group too', () => {
    const result = selectInsights(
      [
        cand({ key: 'souls_per_min', group: 'souls', communityPercentile: 25 }),
        cand({ key: 'souls_at_10min', group: 'souls', communityPercentile: 5 }),
      ],
      longMatch,
    );

    expect(keysOf(result.weaknesses)).toEqual(['souls_at_10min']);
  });

  it('shows a weakness and a strength of the same group', () => {
    // The groups are deduplicated per side: souls can be both a strength (the pace) and a
    // weakness (the early lead) of one match.
    const result = selectInsights(
      [
        cand({ key: 'souls_per_min', group: 'souls', communityPercentile: 90 }),
        cand({ key: 'souls_at_10min', group: 'souls', communityPercentile: 10 }),
      ],
      longMatch,
    );

    expect(keysOf(result.strengths)).toEqual(['souls_per_min']);
    expect(keysOf(result.weaknesses)).toEqual(['souls_at_10min']);
  });

  it('keeps a group whose stronger metric is on the other side', () => {
    // The weakness of souls_at_10min (|−0.8|) does not hide the strength of souls_per_min (0.6):
    // the dedupe looks at one side at a time.
    const result = selectInsights(
      [
        cand({ key: 'souls_at_10min', group: 'souls', communityPercentile: 10 }),
        cand({ key: 'souls_per_min', group: 'souls', communityPercentile: 80 }),
      ],
      longMatch,
    );

    expect(keysOf(result.strengths)).toEqual(['souls_per_min']);
    expect(keysOf(result.weaknesses)).toEqual(['souls_at_10min']);
  });

  it('keeps the top 3 by |score|', () => {
    // Five strengths of five groups, in no particular order: c 0.6, 0.98, 0.7, 0.9, 0.8.
    const result = selectInsights(
      [
        cand({ key: 'kda', group: 'kda', communityPercentile: 80 }),
        cand({ key: 'accuracy', group: 'accuracy', communityPercentile: 99 }),
        cand({ key: 'last_hits', group: 'farm', communityPercentile: 85 }),
        cand({ key: 'denies', group: 'denies', communityPercentile: 95 }),
        cand({ key: 'deaths', group: 'deaths', communityPercentile: 90 }),
      ],
      longMatch,
    );

    expect(keysOf(result.strengths)).toEqual(['accuracy', 'denies', 'deaths']);
    expect(result.strengths.map((insight) => insight.score)).toEqual(
      [...result.strengths.map((insight) => insight.score)].sort((a, b) => b - a),
    );
  });

  it('keeps the top 3 weaknesses by |score|, apart from the strengths', () => {
    const result = selectInsights(
      [
        cand({ key: 'kda', group: 'kda', communityPercentile: 20 }),
        cand({ key: 'accuracy', group: 'accuracy', communityPercentile: 1 }),
        cand({ key: 'last_hits', group: 'farm', communityPercentile: 95 }),
        cand({ key: 'denies', group: 'denies', communityPercentile: 10 }),
        cand({ key: 'deaths', group: 'deaths', communityPercentile: 5 }),
        cand({ key: 'boss_damage_per_min', group: 'boss', communityPercentile: 25 }),
      ],
      longMatch,
    );

    expect(keysOf(result.weaknesses)).toEqual(['accuracy', 'deaths', 'denies']);
    expect(keysOf(result.strengths)).toEqual(['last_hits']);
  });

  it('keeps the input order between equal scores', () => {
    const result = selectInsights(
      [
        cand({ key: 'kda', group: 'kda', communityPercentile: 85 }),
        cand({ key: 'accuracy', group: 'accuracy', communityPercentile: 85 }),
        cand({ key: 'denies', group: 'denies', communityPercentile: 85 }),
        cand({ key: 'last_hits', group: 'farm', communityPercentile: 85 }),
      ],
      longMatch,
    );

    expect(keysOf(result.strengths)).toEqual(['kda', 'accuracy', 'denies']);
  });

  it('counts the groups, not the metrics, against the limit of 3', () => {
    // The two soul metrics are one group: they take one place, not two, so the three places go
    // to three different groups.
    const result = selectInsights(
      [
        cand({ key: 'souls_per_min', group: 'souls', communityPercentile: 99 }),
        cand({ key: 'souls_at_10min', group: 'souls', communityPercentile: 98 }),
        cand({ key: 'accuracy', group: 'accuracy', communityPercentile: 95 }),
        cand({ key: 'denies', group: 'denies', communityPercentile: 90 }),
        cand({ key: 'kda', group: 'kda', communityPercentile: 85 }),
      ],
      longMatch,
    );

    expect(keysOf(result.strengths)).toEqual(['souls_per_min', 'accuracy', 'denies']);
  });
});

describe('confidenceOf', () => {
  const both = cand({ communityPercentile: 80, personalZ: 1.5 });

  it('is high with both references and a normal match', () => {
    expect(confidenceOf(both, longMatch)).toBe('high');
  });

  it.each([
    { name: 'the community reference is missing', candidate: cand({ personalZ: 1.5 }) },
    { name: 'the habits are missing', candidate: cand({ communityPercentile: 80 }) },
    { name: 'both references are missing', candidate: cand() },
  ])('is medium when $name', ({ candidate }) => {
    expect(confidenceOf(candidate, longMatch)).toBe('medium');
  });

  it('is low for a match shorter than 900 s', () => {
    expect(confidenceOf(both, { durationS: 899, hasLeaver: false })).toBe('low');
  });

  it('is not low for a match of exactly 900 s', () => {
    expect(confidenceOf(both, { durationS: 900, hasLeaver: false })).toBe('high');
  });

  it('is low when there is a leaver', () => {
    expect(confidenceOf(both, { durationS: 1_800, hasLeaver: true })).toBe('low');
  });

  it('is low rather than medium when a short match also lacks a reference', () => {
    expect(confidenceOf(cand({ personalZ: 1.5 }), { durationS: 600, hasLeaver: false })).toBe(
      'low',
    );
  });
});

describe('selectInsights: confidence', () => {
  /**
   * The confidence of the only strength of a match.
   *
   * @param candidate - The candidate, strong enough to be a strength.
   * @param match - The match.
   * @returns The confidence the insight carries.
   */
  function confidenceOfOnlyStrength(
    candidate: InsightCandidate,
    match: { durationS: number; hasLeaver: boolean },
  ): Confidence {
    return present(selectInsights([candidate], match).strengths[0]).confidence;
  }

  it('carries the confidence of the candidate', () => {
    const both = cand({ communityPercentile: 90, personalZ: 2 });

    expect(confidenceOfOnlyStrength(both, longMatch)).toBe('high');
    expect(confidenceOfOnlyStrength(cand({ communityPercentile: 90 }), longMatch)).toBe('medium');
    expect(confidenceOfOnlyStrength(cand({ personalZ: 2 }), longMatch)).toBe('medium');
    expect(confidenceOfOnlyStrength(both, { durationS: 600, hasLeaver: false })).toBe('low');
    expect(confidenceOfOnlyStrength(both, { durationS: 1_800, hasLeaver: true })).toBe('low');
  });

  it('carries the confidence on a weakness too', () => {
    const weak = cand({ communityPercentile: 10, personalZ: -2 });

    expect(present(selectInsights([weak], longMatch).weaknesses[0]).confidence).toBe('high');
    expect(
      present(selectInsights([weak], { durationS: 600, hasLeaver: false }).weaknesses[0])
        .confidence,
    ).toBe('low');
  });
});
