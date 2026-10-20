/**
 * Rank badges: how the game numbers a player's rank.
 *
 * A badge is `tier × 10 + sub-rank`, the sub-rank from 1 to 6: badge 43 is sub-rank 3 of tier 4
 * (Sentinel). The tiers go from 0 (Obscurus) to 11 (Eternus), and the API reports `0` for a player
 * who has no rank yet (placement matches), which is no badge.
 *
 * Every module that reads a badge (the match archive, the player rank of deadlock-api, the stored
 * rows, the cohort of the community data) takes its bounds from here, so that a tier added by the
 * game is one change in one place.
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

/**
 * Whether a value is a rank badge.
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
