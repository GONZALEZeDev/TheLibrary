/**
 * Tests of the cohorts: the duration window and the rank a match is compared with, the key of a
 * cohort, and the part of a phase that the community data covers for a cohort.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { present } from '../../test/analysis-context';
import {
  DURATION_WINDOWS,
  RANK_TIER_NAMES,
  badgeBounds,
  cohortKey,
  cohortRankFor,
  communitySpan,
  durationWindowOf,
  guaranteedEndS,
} from './cohort';
import { phaseSpans } from './phases';
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

describe('badgeBounds', () => {
  it('gives the bracket of the badges of a tier', () => {
    expect(badgeBounds(4)).toEqual({ min: 41, max: 46 });
    expect(badgeBounds(1)).toEqual({ min: 11, max: 16 });
    expect(badgeBounds(11)).toEqual({ min: 111, max: 116 });
  });
});

describe('RANK_TIER_NAMES', () => {
  it('names the twelve tiers, indexed by tier', () => {
    expect(RANK_TIER_NAMES).toEqual([
      'Obscurus',
      'Initiate',
      'Seeker',
      'Acolyte',
      'Sentinel',
      'Mystic',
      'Ritualist',
      'Emissary',
      'Oracle',
      'Phantom',
      'Ascendant',
      'Eternus',
    ]);
    expect(RANK_TIER_NAMES[4]).toBe('Sentinel');
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
