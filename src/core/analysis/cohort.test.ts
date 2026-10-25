/**
 * Tests of the cohorts: the duration window and the rank a match is compared with, the rank above
 * the player's that the review compares with and how it relates to the player's own, the key of a
 * cohort and of a rank, and the part of a phase that the community data covers for a cohort.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { present } from '../../test/analysis-context';
import { RANK_TIER_NAMES } from '../domain/rank';
import {
  ANY_LENGTH_WINDOW,
  DURATION_WINDOWS,
  badgeBounds,
  cohortKey,
  cohortRankFor,
  cohortRankKey,
  communitySpan,
  durationWindowOf,
  guaranteedEndS,
  reviewCohortRank,
  reviewComparedWith,
  type ComparedWith,
} from './cohort';
import { PHASE_START_S, phaseSpans } from './phases';
import type { PhaseSpan } from './phases';

/**
 * Take the span of a phase of a match of the given length.
 *
 * @param durationS - The length of the match, in seconds.
 * @param phase - The phase.
 * @returns The span of the phase.
 */
function spanOf(durationS: number, phase: PhaseSpan['phase']): PhaseSpan {
  return present(phaseSpans(durationS).find((span) => span.phase === phase));
}

describe('durationWindowOf', () => {
  it('lists the seven windows of the community data, without a gap or an overlap', () => {
    expect(DURATION_WINDOWS).toEqual([
      { minS: 0, maxS: 1_199 },
      { minS: 1_200, maxS: 1_499 },
      { minS: 1_500, maxS: 1_799 },
      { minS: 1_800, maxS: 2_099 },
      { minS: 2_100, maxS: 2_399 },
      { minS: 2_400, maxS: 2_699 },
      { minS: 2_700, maxS: 7_000 },
    ]);
    DURATION_WINDOWS.slice(1).forEach((window, index) => {
      expect(window.minS).toBe(present(DURATION_WINDOWS[index]).maxS + 1);
    });
  });

  it('maps every duration to its window', () => {
    expect(durationWindowOf(1_199)).toEqual({ minS: 0, maxS: 1_199 });
    expect(durationWindowOf(1_200)).toEqual({ minS: 1_200, maxS: 1_499 });
    expect(durationWindowOf(9_000)).toEqual({ minS: 2_700, maxS: 7_000 });
  });

  it('maps both ends of every window to it', () => {
    for (const window of DURATION_WINDOWS) {
      expect(durationWindowOf(window.minS)).toEqual(window);
      expect(durationWindowOf(window.maxS)).toEqual(window);
    }
  });

  it('maps a match of no time at all to the first window, and a very long one to the last', () => {
    expect(durationWindowOf(0)).toEqual({ minS: 0, maxS: 1_199 });
    expect(durationWindowOf(7_001)).toEqual({ minS: 2_700, maxS: 7_000 });
  });
});

describe('ANY_LENGTH_WINDOW', () => {
  it('spans every match length of the community data, from the first window to the last', () => {
    expect(ANY_LENGTH_WINDOW).toEqual({ minS: 0, maxS: 7_000 });
    expect(ANY_LENGTH_WINDOW.minS).toBe(present(DURATION_WINDOWS[0]).minS);
    expect(ANY_LENGTH_WINDOW.maxS).toBe(present(DURATION_WINDOWS.at(-1)).maxS);
  });
});

describe('cohortRankFor', () => {
  it('chooses the rank of the cohort', () => {
    expect(cohortRankFor(43, 61)).toEqual({ kind: 'tier', tier: 4 });
    expect(cohortRankFor(null, 61)).toEqual({ kind: 'tier', tier: 6 });
    expect(cohortRankFor(null, 0)).toEqual({ kind: 'all' });
    expect(cohortRankFor(null, null)).toEqual({ kind: 'all' });
  });

  it('prefers the badge of the match to the current one, and skips a badge that is not set', () => {
    expect(cohortRankFor(116, 11)).toEqual({ kind: 'tier', tier: 11 });
    expect(cohortRankFor(0, 52)).toEqual({ kind: 'tier', tier: 5 });
    expect(cohortRankFor(0, 0)).toEqual({ kind: 'all' });
    expect(cohortRankFor(43, null)).toEqual({ kind: 'tier', tier: 4 });
  });

  it('compares with all ranks when the badge that counts has no tier', () => {
    // Badges 1 to 9 do not exist in practice. The first badge above 0 decides, so the current one
    // is not used as a fallback.
    expect(cohortRankFor(5, 61)).toEqual({ kind: 'all' });
    expect(cohortRankFor(null, 9)).toEqual({ kind: 'all' });
  });

  it('reads a number that is not a badge as no badge, never as a tier without a name', () => {
    // Past the last badge (tier 12 would have no name), negative or not a whole number: the match
    // badge is skipped for the current one, and a current one that is no badge leaves every rank.
    for (const notABadge of [117, 121, -43, 43.5, Number.NaN]) {
      expect(cohortRankFor(notABadge, 61), String(notABadge)).toEqual({ kind: 'tier', tier: 6 });
      expect(cohortRankFor(null, notABadge), String(notABadge)).toEqual({ kind: 'all' });
    }
  });
});

describe('reviewCohortRank', () => {
  it('gives the tier above, Eternus on its own tier and all ranks without a rank', () => {
    // A sub-rank does not matter: 44 is Sentinel 4 (tier 4), so the tier above is tier 5.
    expect(reviewCohortRank(44)).toEqual({ kind: 'tier', tier: 5 });
    // Eternus has no tier above: it stays on its own.
    expect(reviewCohortRank(116)).toEqual({ kind: 'tier', tier: 11 });
    // No rank at all: the placement matches (0), an unknown rank (null).
    expect(reviewCohortRank(0)).toEqual({ kind: 'all' });
    expect(reviewCohortRank(null)).toEqual({ kind: 'all' });
    // A badge below the first real rank is tier 0 (Obscurus): the tier above is tier 1.
    expect(reviewCohortRank(3)).toEqual({ kind: 'tier', tier: 1 });
    // 47 is no sub-rank the game gives, but it passes the badge check and its tier is 4.
    expect(reviewCohortRank(47)).toEqual({ kind: 'tier', tier: 5 });
  });

  it('goes up one tier, whatever the sub-rank, and stops at the last tier', () => {
    // [badge, tier above]: the first and the last sub-rank of a few tiers, up to the last two.
    const cases: readonly (readonly [number, number])[] = [
      [11, 2],
      [16, 2],
      [61, 7],
      [91, 10],
      [96, 10],
      [101, 11],
      [106, 11],
      [111, 11],
      [116, 11],
    ];
    for (const [badge, tier] of cases) {
      expect(reviewCohortRank(badge), String(badge)).toEqual({ kind: 'tier', tier });
    }
  });

  it('reads a number that is not a badge as no rank, never as a tier without a name', () => {
    // Past the last badge (tier 12 would have no name), negative or not a whole number.
    for (const notABadge of [117, 121, -44, 44.5, Number.NaN]) {
      expect(reviewCohortRank(notABadge), String(notABadge)).toEqual({ kind: 'all' });
    }
  });
});

describe('reviewComparedWith', () => {
  /** The highest tier: Eternus, which has no tier above. */
  const LAST_TIER = RANK_TIER_NAMES.length - 1;

  it('tells the tier above, the own tier of the highest tier and every rank apart', () => {
    expect(reviewComparedWith(44)).toBe('tier_above');
    // Ascendant (tier 10) is compared with Eternus, which is a tier above it.
    expect(reviewComparedWith(106)).toBe('tier_above');
    // Eternus has none above: it is compared with itself.
    expect(reviewComparedWith(111)).toBe('own_tier');
    expect(reviewComparedWith(116)).toBe('own_tier');
    // No rank at all: the placement matches (0), an unknown rank (null).
    expect(reviewComparedWith(0)).toBe('every_rank');
    expect(reviewComparedWith(null)).toBe('every_rank');
  });

  it('fits the rank the review compares with, for the first and last badge of every tier', () => {
    // Tier 0 holds the badges 1 to 9 (no sub-rank 0): its first badge is 1.
    for (let tier = 0; tier <= LAST_TIER; tier += 1) {
      const badges = [Math.max(tier * 10 + 1, 1), tier * 10 + 6];
      const expected: ComparedWith = tier === LAST_TIER ? 'own_tier' : 'tier_above';
      const comparedTier = Math.min(tier + 1, LAST_TIER);
      for (const badge of badges) {
        expect(reviewComparedWith(badge), `badge ${String(badge)}`).toBe(expected);
        expect(reviewCohortRank(badge), `badge ${String(badge)}`).toEqual({
          kind: 'tier',
          tier: comparedTier,
        });
      }
    }
  });

  it('reads a number that is not a badge as no rank, like the rank it fits', () => {
    for (const notABadge of [117, 121, -44, 44.5, Number.NaN]) {
      expect(reviewComparedWith(notABadge), String(notABadge)).toBe('every_rank');
      expect(reviewCohortRank(notABadge), String(notABadge)).toEqual({ kind: 'all' });
    }
  });
});

describe('badgeBounds', () => {
  it('gives the bracket of the badges of a tier', () => {
    expect(badgeBounds(4)).toEqual({ min: 41, max: 46 });
    expect(badgeBounds(1)).toEqual({ min: 11, max: 16 });
    expect(badgeBounds(11)).toEqual({ min: 111, max: 116 });
  });
});

describe('cohortRankKey', () => {
  it('names a rank key', () => {
    expect(cohortRankKey({ kind: 'tier', tier: 7 })).toBe('tier7');
    expect(cohortRankKey({ kind: 'tier', tier: 11 })).toBe('tier11');
    expect(cohortRankKey({ kind: 'all' })).toBe('all');
  });
});

describe('cohortKey', () => {
  it('names a cohort by its rank and its window', () => {
    const window = { minS: 1_500, maxS: 1_799 };
    expect(cohortKey({ rank: { kind: 'tier', tier: 4 }, window })).toBe('tier4.1500-1799');
    expect(cohortKey({ rank: { kind: 'all' }, window })).toBe('all.1500-1799');
    expect(
      cohortKey({ rank: { kind: 'tier', tier: 11 }, window: { minS: 2_700, maxS: 7_000 } }),
    ).toBe('tier11.2700-7000');
  });

  it('keeps the cohort keys of the match page', () => {
    // These keys name the entries of the cache of the community data: a change would orphan them.
    expect(
      cohortKey({ rank: { kind: 'tier', tier: 4 }, window: { minS: 1_500, maxS: 1_799 } }),
    ).toBe('tier4.1500-1799');
    expect(cohortKey({ rank: { kind: 'all' }, window: { minS: 0, maxS: 1_199 } })).toBe(
      'all.0-1199',
    );
  });

  it('is the key of the rank, a dot and the window', () => {
    for (const rank of [{ kind: 'tier', tier: 9 }, { kind: 'all' }] as const) {
      expect(cohortKey({ rank, window: ANY_LENGTH_WINDOW })).toBe(`${cohortRankKey(rank)}.0-7000`);
    }
  });
});

describe('guaranteedEndS', () => {
  it('is 12 minutes for the shortest window, and the lower bound of every other one', () => {
    expect(guaranteedEndS({ minS: 0, maxS: 1_199 })).toBe(720);
    expect(DURATION_WINDOWS.slice(1).map((window) => guaranteedEndS(window))).toEqual([
      1_200, 1_500, 1_800, 2_100, 2_400, 2_700,
    ]);
  });
});

describe('communitySpan', () => {
  it('stops the late phase of a 70-minute match at 45:00, where its cohort is surely there', () => {
    const late = spanOf(4_200, 'late');
    expect(communitySpan(late, durationWindowOf(4_200))).toEqual({ startS: 1_500, endS: 2_700 });
  });

  it('has no community span for the mid phase of a short match', () => {
    // Window [0, 1199] → guaranteed end 720 → 2 minutes of the mid phase.
    const mid = spanOf(1_100, 'mid');
    expect(communitySpan(mid, durationWindowOf(1_100))).toBeNull();
  });

  it('stops the mid phase of a 22-minute match at 20:00', () => {
    expect(communitySpan(spanOf(1_320, 'mid'), durationWindowOf(1_320))).toEqual({
      startS: 600,
      endS: 1_200,
    });
  });

  it('keeps the whole phase when the cohort surely reaches its end', () => {
    // A 9-minute match: the early phase ends with the match, before the 12 minutes of the window.
    expect(communitySpan(spanOf(540, 'early'), durationWindowOf(540))).toEqual({
      startS: 0,
      endS: 540,
    });
    expect(communitySpan(spanOf(1_320, 'early'), durationWindowOf(1_320))).toEqual({
      startS: 0,
      endS: 600,
    });
  });

  it('keeps the whole of an early or mid phase that was played to its end, in every window', () => {
    // The early game is over at 10:00 and the mid game at 25:00. Whatever the window of the match,
    // the cohort surely reaches these times (the first window is read up to 12:00, the others from
    // their start), so a phase that is over is compared whole: a figure counted over the whole phase
    // and one counted over the community span are the same.
    const completeFromS = { early: PHASE_START_S.mid, mid: PHASE_START_S.late } as const;
    const durations = [
      PHASE_START_S.mid,
      ...DURATION_WINDOWS.flatMap(({ minS, maxS }) => [minS, maxS]),
    ];
    const completePhases = durations.flatMap((durationS) =>
      (['early', 'mid'] as const)
        .filter((phase) => durationS >= completeFromS[phase])
        .map((phase) => ({ durationS, span: spanOf(durationS, phase) })),
    );

    expect(completePhases.length).toBeGreaterThan(durations.length);
    for (const { durationS, span } of completePhases) {
      expect(communitySpan(span, durationWindowOf(durationS))).toEqual({
        startS: span.startS,
        endS: span.endS,
      });
    }
  });

  it('has no community span for the late phase of a match of 25 to 30 minutes', () => {
    // Window [1500, 1799] → guaranteed end 1500, the very start of the phase.
    expect(communitySpan(spanOf(1_700, 'late'), durationWindowOf(1_700))).toBeNull();
  });

  it('keeps a span of exactly three minutes and drops a shorter one', () => {
    expect(communitySpan(spanOf(180, 'early'), durationWindowOf(180))).toEqual({
      startS: 0,
      endS: 180,
    });
    expect(communitySpan(spanOf(179, 'early'), durationWindowOf(179))).toBeNull();
  });
});
