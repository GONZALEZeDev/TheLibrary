/**
 * The cohorts a match is compared with: the players of the same hero, of the same rank, in matches
 * of about the same length.
 *
 * The community data is published per rank bracket and per duration window, so the app has to
 * decide, for one match, which rank and which window to ask for, how to name the answer in its
 * cache, and how much of each phase of the match the answer actually covers. The review of a series
 * of matches asks for the tier above the player's own instead, whatever the length of each match.
 *
 * @packageDocumentation
 */
import { BADGES_PER_TIER, MAX_BADGE, SUBRANKS_PER_TIER, isBadge } from '../domain/rank';
import { MIN_PHASE_MINUTES } from './insights/thresholds';
import type { PhaseSpan } from './phases';

/** A range of match lengths of the community data, both bounds included, in seconds. */
export interface DurationWindow {
  /** The shortest match of the window. */
  readonly minS: number;
  /** The longest match of the window. */
  readonly maxS: number;
}

/**
 * The rank a cohort is made of: the players of one tier, or the players of every rank (for a player
 * who has no rank to compare with, or whose tier has too few matches).
 */
export type CohortRank =
  { readonly kind: 'tier'; readonly tier: number } | { readonly kind: 'all' };

/** A cohort of the community data: a rank and a duration window. */
export interface Cohort {
  /** The ranks of the cohort. */
  readonly rank: CohortRank;
  /** The match lengths of the cohort. */
  readonly window: DurationWindow;
}

/** The last duration window: it holds every match from 45 minutes up, however long. */
const LONGEST_WINDOW: DurationWindow = { minS: 2_700, maxS: 7_000 };

/**
 * The duration windows of the community data, in increasing order: one for the matches under 20
 * minutes, five-minute windows from 20 to 45 minutes, and one for the longest matches. They leave no
 * gap: each starts one second after the previous one ends.
 */
export const DURATION_WINDOWS: readonly DurationWindow[] = [
  { minS: 0, maxS: 1_199 },
  { minS: 1_200, maxS: 1_499 },
  { minS: 1_500, maxS: 1_799 },
  { minS: 1_800, maxS: 2_099 },
  { minS: 2_100, maxS: 2_399 },
  { minS: 2_400, maxS: 2_699 },
  LONGEST_WINDOW,
];

/**
 * The window of a request that does not depend on the length of a match: from the shortest match
 * of the first window to the longest of the last one, so it holds the matches of every window at
 * once. It is the span of {@link DURATION_WINDOWS}, and a test ties the two.
 *
 * The review uses it for the figures it reads for a whole series of matches, such as the items the
 * players of a tier buy, which are asked once for the tier and not once per duration window.
 */
export const ANY_LENGTH_WINDOW: DurationWindow = { minS: 0, maxS: 7_000 };

/**
 * The tier of a badge, whatever its sub-rank.
 *
 * @param badge - A badge ({@link isBadge}).
 * @returns The badge divided by {@link BADGES_PER_TIER}, rounded down: 4 for 43 and for 47.
 */
function tierOf(badge: number): number {
  return Math.floor(badge / BADGES_PER_TIER);
}

/**
 * The highest tier: the tier of {@link MAX_BADGE} (Eternus, 11). It follows the bounds of the
 * badges, so a tier added by the game is one change in one place.
 */
const TOP_TIER = tierOf(MAX_BADGE);

/**
 * The time up to which a match of the shortest window is taken to have been played, in seconds
 * (12 minutes).
 *
 * That window starts at 0, which would leave no phase to compare. Matches that short are rare, and
 * 720 is the fourth point of the community curves (180, 360, 540, 720…): the one almost every match
 * of the window reaches, so the curves are read up to there.
 */
const SHORTEST_WINDOW_GUARANTEED_END_S = 720;

/**
 * Find the duration window of a match.
 *
 * @param durationS - The length of the match, in seconds: a whole number from 0, as the API reports
 *   it.
 * @returns The first window that ends at or after the match length. A match longer than the last
 *   window (more than 7,000 s) is in the last window: there is no longer one.
 */
export function durationWindowOf(durationS: number): DurationWindow {
  return DURATION_WINDOWS.find((window) => durationS <= window.maxS) ?? LONGEST_WINDOW;
}

/**
 * Choose the rank of the cohort a match is compared with.
 *
 * A ranked match is compared with the players of the rank the player had in it, so that a good
 * match at a low rank is not judged against the rank they have reached since. The first of the two
 * that is a badge ({@link isBadge}) decides: `0` (no rank yet) and a number that is no badge (past
 * the last one, negative, fractional) count as none, so no cohort is ever made of a tier that has no
 * name. With no badge at all, the cohort is every rank.
 *
 * @param matchBadge - The badge the player had in the match, or `null` for an unranked match.
 * @param currentBadge - The badge the player has now, or `null` when it is unknown.
 * @returns The tier of the badge that decides, or every rank when there is none or when its tier is
 *   0 (a badge from 1 to 9 does not exist in practice, so a tier 0 cohort would be an empty one).
 */
export function cohortRankFor(matchBadge: number | null, currentBadge: number | null): CohortRank {
  const badge = isBadge(matchBadge) ? matchBadge : isBadge(currentBadge) ? currentBadge : null;
  if (badge === null) {
    return { kind: 'all' };
  }
  const tier = tierOf(badge);
  return tier === 0 ? { kind: 'all' } : { kind: 'tier', tier };
}

/**
 * Choose the rank of the cohort the review compares the player with: the tier above their own.
 *
 * The review tells the player where to improve, so it compares them with the players a step ahead
 * of them, not with their peers. Only the current badge counts: the review looks at the player as
 * they are now, over their last matches, whatever rank each of them was played at. Like
 * {@link cohortRankFor}, it reads `0` (no rank yet) and a number that is no badge
 * ({@link isBadge}) as no rank, so no cohort is ever made of a tier that has no name.
 *
 * @param currentBadge - The badge the player has now, or `null` when it is unknown.
 * @returns The tier above the one of the badge, whatever its sub-rank; Eternus, which has no tier
 *   above, stays on its own tier; a badge of tier 0 (from 1 to 9, which the game does not give in
 *   practice) gives tier 1. With no badge, every rank.
 */
export function reviewCohortRank(currentBadge: number | null): CohortRank {
  if (!isBadge(currentBadge)) {
    return { kind: 'all' };
  }
  return { kind: 'tier', tier: Math.min(tierOf(currentBadge) + 1, TOP_TIER) };
}

/**
 * How the cohort the review compares the player with relates to the player's own rank:
 *
 * - `tier_above`: the players of the tier above the player's, the usual case;
 * - `own_tier`: the players of the player's own tier, because it is the highest and has none above;
 * - `every_rank`: the players of every rank, because the player has no rank to compare from.
 *
 * The rank of the cohort ({@link CohortRank}) cannot tell these apart by itself: the highest tier is
 * the tier above for a player one tier under it and the own tier of a player in it.
 */
export type ComparedWith = 'tier_above' | 'own_tier' | 'every_rank';

/**
 * Tell how the cohort the review compares the player with relates to the player's own rank.
 *
 * It is the companion of {@link reviewCohortRank}, which gives the cohort itself, and is worked out
 * from it, so that the two always fit: the cohort is the player's own tier exactly when the tier
 * above the player's would be past the highest tier.
 *
 * @param currentBadge - The badge the player has now, or `null` when it is unknown.
 * @returns `every_rank` when {@link reviewCohortRank} gives every rank (no badge, `0`, or a number
 *   that is no badge); `own_tier` when it gives the tier of the badge itself (Eternus); `tier_above`
 *   otherwise.
 */
export function reviewComparedWith(currentBadge: number | null): ComparedWith {
  const rank = reviewCohortRank(currentBadge);
  // `isBadge` is what `reviewCohortRank` tests too: here it only tells the compiler that there is a
  // badge to take the tier of.
  if (rank.kind === 'all' || !isBadge(currentBadge)) {
    return 'every_rank';
  }
  return rank.tier === tierOf(currentBadge) ? 'own_tier' : 'tier_above';
}

/**
 * The badges of a tier, as the community data filters them.
 *
 * @param tier - The tier, from 0 to 11.
 * @returns The lowest and the highest badge of the tier (`tier × 10 + 1` and `tier × 10 + 6`).
 */
export function badgeBounds(tier: number): { min: number; max: number } {
  return { min: tier * BADGES_PER_TIER + 1, max: tier * BADGES_PER_TIER + SUBRANKS_PER_TIER };
}

/**
 * Name a cohort rank, for the cache of the community data and the logs.
 *
 * @param rank - The rank of the cohort.
 * @returns `tier<N>` for a tier (`tier7`), or `all` for every rank.
 */
export function cohortRankKey(rank: CohortRank): string {
  return rank.kind === 'tier' ? `tier${String(rank.tier)}` : 'all';
}

/**
 * Name a cohort, for the cache of the community data and the logs.
 *
 * @param cohort - The cohort.
 * @returns `tier<N>.<minS>-<maxS>` for a tier (`tier4.1500-1799`), or `all.<minS>-<maxS>` for every
 *   rank: the key of its rank ({@link cohortRankKey}), then its window.
 */
export function cohortKey(cohort: Cohort): string {
  const { minS, maxS } = cohort.window;
  return `${cohortRankKey(cohort.rank)}.${String(minS)}-${String(maxS)}`;
}

/**
 * The time up to which every match of a duration window has been played, in seconds.
 *
 * The community curves give the average of the players still in a match at each time, so a curve is
 * only a fair reference up to a time that all the matches of its window reach: that is the start of
 * the window, which every match of it lasts at least. The first window starts at 0, so it is given
 * 12 minutes instead.
 *
 * @param window - The duration window.
 * @returns 720 for the window that starts at 0, else the start of the window.
 */
export function guaranteedEndS(window: DurationWindow): number {
  return window.minS === 0 ? SHORTEST_WINDOW_GUARANTEED_END_S : window.minS;
}

/**
 * The part of a phase that the community data of a window covers.
 *
 * The phase of a match is compared with the curve of the cohort over the same stretch of time. That
 * stretch stops at the phase end or at the time every match of the cohort reaches
 * ({@link guaranteedEndS}), whichever comes first: past it, the curve would be the average of the
 * longer matches only.
 *
 * @param span - The phase as played in the match.
 * @param window - The duration window of the cohort.
 * @returns The stretch of the phase to compare, or `null` when it is shorter than
 *   {@link MIN_PHASE_MINUTES}: there is then too little to compare.
 */
export function communitySpan(
  span: PhaseSpan,
  window: DurationWindow,
): { startS: number; endS: number } | null {
  const endS = Math.min(span.endS, guaranteedEndS(window));
  return (endS - span.startS) / 60 < MIN_PHASE_MINUTES ? null : { startS: span.startS, endS };
}
