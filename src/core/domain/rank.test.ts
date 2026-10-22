/**
 * Tests of the rank badges: their bounds, what counts as a badge, and how a badge is split and
 * named.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  BADGES_PER_TIER,
  MAX_BADGE,
  MIN_BADGE,
  RANK_TIER_NAMES,
  SUBRANKS_PER_TIER,
  badgeParts,
  isBadge,
  rankName,
} from './rank';

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

describe('badge bounds', () => {
  it('starts the badges at 1', () => {
    expect(MIN_BADGE).toBe(1);
  });

  it('ends the badges at sub-rank 6 of the last named tier', () => {
    // A badge is `tier × 10 + sub-rank`, the sub-rank from 1 to 6: a tier added to the names and not
    // to the bounds (or the reverse) fails here.
    expect(MAX_BADGE).toBe((RANK_TIER_NAMES.length - 1) * BADGES_PER_TIER + SUBRANKS_PER_TIER);
    expect(MAX_BADGE).toBe(116);
  });

  it('spans ten badges per tier, six of which are ranks', () => {
    expect(BADGES_PER_TIER).toBe(10);
    expect(SUBRANKS_PER_TIER).toBe(6);
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

describe('badgeParts', () => {
  it('splits a badge', () => {
    expect(badgeParts(44)).toEqual({ tier: 4, subRank: 4 });
    expect(badgeParts(116)).toEqual({ tier: 11, subRank: 6 });
    expect(badgeParts(11)).toEqual({ tier: 1, subRank: 1 });
  });

  it('splits the first and the last sub-rank of a tier', () => {
    expect(badgeParts(11)).toEqual({ tier: 1, subRank: 1 });
    expect(badgeParts(16)).toEqual({ tier: 1, subRank: 6 });
    expect(badgeParts(111)).toEqual({ tier: 11, subRank: 1 });
    expect(badgeParts(116)).toEqual({ tier: 11, subRank: 6 });
  });

  it('answers null for 0, 117, −1 and 4.5', () => {
    // 0 is a player with no rank yet (placement): there is nothing to split.
    for (const value of [0, 117, -1, 4.5]) {
      expect(badgeParts(value), String(value)).toBeNull();
    }
  });

  it('answers null for a sub-rank outside 1 to 6', () => {
    // 20 is sub-rank 0, 47 is sub-rank 7 and 109 is sub-rank 9: whole numbers inside the bounds of
    // `isBadge`, but not ranks the game gives (it has six sub-ranks per tier).
    for (const value of [20, 47, 109]) {
      expect(isBadge(value), String(value)).toBe(true);
      expect(badgeParts(value), String(value)).toBeNull();
    }
  });
});

describe('rankName', () => {
  it('names a badge', () => {
    expect(rankName(44)).toBe('Sentinel 4');
    expect(rankName(116)).toBe('Eternus 6');
    expect(rankName(11)).toBe('Initiate 1');
  });

  it('names the first and the last sub-rank of a tier', () => {
    expect(rankName(11)).toBe('Initiate 1');
    expect(rankName(16)).toBe('Initiate 6');
    expect(rankName(111)).toBe('Eternus 1');
    expect(rankName(116)).toBe('Eternus 6');
  });

  it('answers null for 0, 117, −1 and 4.5', () => {
    for (const value of [0, 117, -1, 4.5]) {
      expect(rankName(value), String(value)).toBeNull();
    }
  });

  it('answers null for a sub-rank outside 1 to 6', () => {
    // Never "Seeker 0" or "Sentinel 7": those are not ranks of the game.
    for (const value of [20, 47, 109]) {
      expect(rankName(value), String(value)).toBeNull();
    }
  });
});
