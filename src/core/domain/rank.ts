/**
 * Rank badges: how the game numbers a player's rank.
 *
 * A badge is `tier × 10 + sub-rank`, the sub-rank from 1 to 6: badge 43 is sub-rank 3 of tier 4
 * (Sentinel). The tiers go from 0 (Obscurus) to 11 (Eternus), and the API reports `0` for a player
 * who has no rank yet (placement matches), which is no badge.
 *
 * Every module that reads a badge (the match archive, the player rank of deadlock-api, the stored
 * rows, the cohort of the community data) takes its bounds, its tier names and its way of splitting
 * and naming a badge from here, so that a tier added by the game is one change in one place.
 *
 * @packageDocumentation
 */

/**
 * The lowest badge: 1. Badges 1 to 9 would be tier 0 and do not occur in practice (the first rank
 * given is sub-rank 1 of tier 1, badge 11), but any whole number from 1 is a rank the player has.
 */
export const MIN_BADGE = 1;

/** The highest badge: sub-rank 6 of tier 11 (Eternus), `11 × 10 + 6`. */
export const MAX_BADGE = 116;

/** How many badges a tier spans: a badge is `tier × 10` plus a sub-rank from 1 to 6. */
export const BADGES_PER_TIER = 10;

/**
 * How many sub-ranks a tier has: 6, numbered from 1. The other numbers a tier spans (`tier × 10`, and
 * `tier × 10 + 7` to `tier × 10 + 9`) are not ranks of the game.
 */
export const SUBRANKS_PER_TIER = 6;

/** The first sub-rank of a tier: sub-ranks are numbered from 1, never from 0. */
const FIRST_SUBRANK = 1;

/**
 * The names of the rank tiers, in English like the game's, indexed by tier (tier 0 is a player who
 * has no rank yet). The last tier is the one of {@link MAX_BADGE}: a tier added here moves that bound
 * too, and a test ties the two.
 */
export const RANK_TIER_NAMES: readonly string[] = [
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
];

/**
 * Whether a value is a rank badge.
 *
 * This is the check of the bounds only: a badge such as 20 or 47 passes it although its sub-rank (0,
 * 7) is not one the game gives. {@link badgeParts} and {@link rankName} are the strict readers.
 *
 * @param value - The candidate, as read from a payload or a stored row.
 * @returns `true` when it is a whole number from {@link MIN_BADGE} to {@link MAX_BADGE}; `false` for
 *   `0` (no rank yet), for a number past the bounds, and for anything that is not a whole number.
 */
export function isBadge(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= MIN_BADGE && value <= MAX_BADGE
  );
}

/** A badge split into the two numbers it is made of. */
export interface BadgeParts {
  /** The tier, from 0 to 11: an index of {@link RANK_TIER_NAMES}. */
  readonly tier: number;
  /** The sub-rank within the tier, from 1 to {@link SUBRANKS_PER_TIER}. */
  readonly subRank: number;
}

/**
 * Split a badge into its tier and its sub-rank.
 *
 * @param badge - The candidate badge, as read from a payload or a stored row.
 * @returns The tier (`floor(badge / 10)`) and the sub-rank (`badge % 10`), or `null` unless the value
 *   is a real rank: a badge ({@link isBadge}) whose sub-rank is from 1 to {@link SUBRANKS_PER_TIER}.
 *   `null` for `0` (no rank yet), a number past the bounds, a number that is not whole, and a badge
 *   such as 20, 47 or 109 (sub-rank 0, 7, 9), which the game never gives.
 */
export function badgeParts(badge: number): BadgeParts | null {
  if (!isBadge(badge)) {
    return null;
  }
  const subRank = badge % BADGES_PER_TIER;
  // The game has six sub-ranks per tier, numbered from 1: the rest of the badge numbers are no ranks.
  if (subRank < FIRST_SUBRANK || subRank > SUBRANKS_PER_TIER) {
    return null;
  }
  return { tier: Math.floor(badge / BADGES_PER_TIER), subRank };
}

/**
 * Name a badge the way the game does, in English whatever the language of the interface.
 *
 * @param badge - The candidate badge, as read from a payload or a stored row.
 * @returns The tier name and the sub-rank (`Sentinel 4` for 44, `Eternus 6` for 116), or `null` when
 *   the value is no real rank ({@link badgeParts}) or its tier has no name.
 */
export function rankName(badge: number): string | null {
  const parts = badgeParts(badge);
  if (parts === null) {
    return null;
  }
  const tierName = RANK_TIER_NAMES[parts.tier];
  return tierName === undefined ? null : `${tierName} ${String(parts.subRank)}`;
}
