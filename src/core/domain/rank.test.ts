/**
 * Tests of the rank badges: their bounds, and what counts as a badge.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { RANK_TIER_NAMES } from '../analysis/cohort';
import { MAX_BADGE, MIN_BADGE, isBadge } from './rank';

describe('badge bounds', () => {
  it('starts the badges at 1', () => {
    expect(MIN_BADGE).toBe(1);
  });

  it('ends the badges at sub-rank 6 of the last named tier', () => {
    // A badge is `tier × 10 + sub-rank`, the sub-rank from 1 to 6: a tier added to the names and not
    // to the bounds (or the reverse) fails here.
    expect(MAX_BADGE).toBe((RANK_TIER_NAMES.length - 1) * 10 + 6);
    expect(MAX_BADGE).toBe(116);
  });
});

describe('isBadge', () => {
  it('accepts every whole number from the first to the last badge', () => {
    for (const badge of [MIN_BADGE, 11, 43, 99, MAX_BADGE]) {
      expect(isBadge(badge), String(badge)).toBe(true);
    }
  });

  it('refuses 0, the player with no rank, and the numbers past the bounds', () => {
    for (const value of [0, -1, MAX_BADGE + 1, 1_000_000]) {
      expect(isBadge(value), String(value)).toBe(false);
    }
  });

  it('refuses what is not a whole number', () => {
    for (const value of [43.5, Number.NaN, Number.POSITIVE_INFINITY, '43', null, undefined, [43]]) {
      expect(isBadge(value), String(value)).toBe(false);
    }
  });
});
