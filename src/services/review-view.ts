/**
 * The view of the review of the player's last matches: what the review page shows, tab by tab.
 *
 * The review sets the player's last analysed matches against two references: the players of the
 * rank tier above theirs (the community), and the matches the player played just before (the
 * progress). Every point of it, a metric, the deaths of a phase, a resistance item, a place among
 * the players, is one {@link ReviewRow}: the player's figure over the last matches, the tier's figure
 * and the gap to it, in how many matches the point was weak or strong, how it moved since the
 * matches before, and the value of each match, so that the page can show which matches pull the
 * figure down.
 *
 * These types are the one contract between the pure modules that build the rows and the page:
 * `./review-row` sums up the judged matches of a point into its row, `./review-stats` judges the
 * metrics of the match page, `./review-deaths` the deaths of each phase, `./review-resistance` the
 * resistance items and `./review-players` the places among the players. What a reference cannot
 * tell is told in the row and never replaced by a number: a figure with too few matches behind it,
 * a point with no tier figure, a match whose tier data is not cached.
 *
 * It holds types only, so the modules that build the rows can import it without importing the module
 * that puts them together: `./review-build` builds the whole review from these types.
 *
 * @packageDocumentation
 */
import type { CohortRank } from '../core/analysis/cohort';
import type { MetricFamily, MetricKey, MetricUnit } from '../core/analysis/metric';
import type { Phase } from '../core/analysis/phases';
import type { Difference } from '../core/analysis/references';
import type { DamageShareRow } from '../core/analysis/review/damage-review';
import type { ResistanceKind } from '../core/analysis/review/resistance-items';
import type { ReviewMark, ReviewProgress } from '../core/analysis/review/review-rules';
import type { MatchId } from '../core/domain/match';
import type { PlaceStat } from '../core/match-detail/scoreboard';
import type { CommunityReference } from './community-placement';
import type { RecentMatch } from './metrics.repository';

/**
 * What the figures of a row count, which decides how they are formatted: the unit of a metric of the
 * match page, or one of the review's own points:
 *
 * - `deaths`: deaths in one match;
 * - `deaths_per_10_min`: deaths for every ten minutes of a phase (the late game, whose length varies
 *   from match to match);
 * - `minute`: a minute of the match (when an item was bought);
 * - `rate`: a share of the matches, from 0 to 1 (how often an item was bought, how often the player
 *   was in Valve's top three);
 * - `place`: a place among the players of a match, 1 for the best.
 */
export type ReviewUnit = MetricUnit | 'deaths' | 'deaths_per_10_min' | 'minute' | 'rate' | 'place';

/**
 * A resistance item of the review: the list of resistance items says which it is, its tier and what
 * it protects against, and the item catalogue names and shows it.
 *
 * An item whose class name the catalogue does not know keeps its class name, its tier and what it
 * protects against, and has `null` for its id, name and image: its row is still shown, as no point
 * of the review is ever hidden.
 */
export interface ResistanceItemView {
  /** The asset id of the item, or `null` when the catalogue does not know its class name. */
  readonly itemId: number | null;
  /** The class name of the item, which the list of resistance items is built on. */
  readonly className: string;
  /** The English name of the item, or `null` when the catalogue does not know it. */
  readonly name: string | null;
  /** The image of the item on the asset bucket, or `null` when it has none or is unknown. */
  readonly imageUrl: string | null;
  /**
   * The tier of the item in the shop, as the list of resistance items has it: it is the same whether
   * or not the catalogue knows the item.
   */
  readonly tier: number;
  /** The damage the item protects the player against. */
  readonly protects: ResistanceKind;
}

/**
 * The point a row of the review is about; it names the texts of the row.
 *
 * - `metric`: one of the 24 metrics of the match page.
 * - `phase_deaths`: the player's deaths in a phase of the match.
 * - `resistance_minute`: the minute the player buys a resistance item.
 * - `resistance_rate`: how often the player buys a resistance item.
 * - `first_resistance_minute`: the minute of the player's first resistance item, whichever it is.
 * - `deaths_before_resistance`: the player's deaths before their first resistance item.
 * - `place`: the player's place among the players of the match on a figure of the scoreboard.
 * - `valve_top_three`: how often the player is in Valve's top three of the match.
 * - `valve_top_three_place`: the player's place in Valve's top three, in the matches they are in it.
 */
export type ReviewSubject =
  | { readonly kind: 'metric'; readonly key: MetricKey }
  | { readonly kind: 'phase_deaths'; readonly phase: Phase }
  | { readonly kind: 'resistance_minute'; readonly item: ResistanceItemView }
  | { readonly kind: 'resistance_rate'; readonly item: ResistanceItemView }
  | { readonly kind: 'first_resistance_minute' }
  | { readonly kind: 'deaths_before_resistance' }
  | { readonly kind: 'place'; readonly stat: PlaceStat }
  | { readonly kind: 'valve_top_three' }
  | { readonly kind: 'valve_top_three_place' };

/** The value of a point in one of the last matches, and its verdict there. */
export interface ReviewMatchValue {
  /** The match. */
  readonly matchId: MatchId;
  /** Start of the match, in Unix seconds. */
  readonly startTime: number;
  /** The value of the point in the match, in the unit of the row. */
  readonly value: number;
  /**
   * Whether the match is weak or strong for the point; `null` when it is neither, and when no rule
   * could judge it (its tier data is not cached, or the point has no rule).
   */
  readonly mark: ReviewMark | null;
}

/** One point of the review, with everything the page shows on its line. */
export interface ReviewRow {
  /** The point. */
  readonly subject: ReviewSubject;
  /** What the figures of the row count. */
  readonly unit: ReviewUnit;
  /**
   * Which direction is an improvement, or `null` for a point that is neither better nor worse when
   * higher (a pick rate): such a row has no progress direction.
   */
  readonly better: 'higher' | 'lower' | null;
  /**
   * The player's figure over the last matches: the median or the mean of the values of
   * {@link ReviewRow.matches}, as the reference of the point is one or the other. `null` when fewer
   * than `MIN_PERSONAL_MATCHES` matches have a value: a centre of so few says too little.
   */
  readonly value: number | null;
  /** How many of the last matches have a value for the point: given even when `value` is `null`. */
  readonly count: number;
  /**
   * The player's figure the reference is compared with: over the matches compared with the tier, on
   * the stretch the tier's figure covers; it equals `value` when every match that has a value is
   * compared, and each on its whole span. It has the same centre as `value`, and is `null` with the
   * reference.
   */
  readonly comparedValue: number | null;
  /**
   * The figure of the tier above for the point, in the unit of the row: the centre of the tier's
   * figures of the matches compared with it, each for that match. `null` when the point has no tier
   * figure, or when fewer than `MIN_PERSONAL_MATCHES` matches were compared with the tier.
   */
  readonly reference: number | null;
  /**
   * How {@link ReviewRow.comparedValue} differs from the reference, as the point shows it: a share of
   * the reference, or an amount in the unit of the row. Not oriented: a positive difference is a
   * higher figure, not a better one. `null` when either figure is `null`.
   */
  readonly difference: Difference | null;
  /**
   * Where the player stands among the tier above: the median of the percentiles of the matches that
   * were placed among it, oriented so that higher is better (1 to 99). `null` when fewer than
   * `MIN_PERSONAL_MATCHES` matches were.
   */
  readonly percentile: number | null;
  /** In how many of the last matches the point was weak. */
  readonly weak: number;
  /** In how many of the last matches the point was strong. */
  readonly strong: number;
  /**
   * In how many of the last matches a rule could judge the point, weak, strong or neither: the
   * matches the shares of the summary are taken of.
   */
  readonly marked: number;
  /** The side of the summary the point is listed on, or `null` when it is on neither. */
  readonly side: 'weakness' | 'strength' | null;
  /** How the figure moved since the matches before the last ones. */
  readonly progress: ReviewProgress;
  /** The value of each of the last matches that has one, most recent first. */
  readonly matches: readonly ReviewMatchValue[];
}

/** The matches a window of the review covers. */
export interface ReviewWindow {
  /** How many matches the window holds. */
  readonly count: number;
  /** Start of the earliest match of the window, in Unix seconds; `null` for an empty window. */
  readonly firstStartTime: number | null;
  /** Start of the most recent match of the window, in Unix seconds; `null` for an empty window. */
  readonly lastStartTime: number | null;
}

/**
 * Where the comparison with the tier above stands.
 *
 * - `available`: some of the last matches are compared with the tier `rank`. `fallbackMatches` of
 *   them are compared with every rank instead, as the tier holds too few matches of their length;
 *   `missingMatches` have no tier data cached and are not compared at all. `stale` is set when any
 *   of the data used is a day old or more, and `fetchedAt` is when the oldest of it was downloaded
 *   (Unix ms).
 * - `missing`: none of the last matches has tier data cached.
 */
export type ReviewCommunity =
  | {
      readonly kind: 'available';
      readonly rank: CohortRank;
      readonly fallbackMatches: number;
      readonly missingMatches: number;
      readonly stale: boolean;
      readonly fetchedAt: number;
    }
  | { readonly kind: 'missing'; readonly rank: CohortRank };

/**
 * A part of the review that needs the item catalogue: its content, or the reason it has none (the
 * catalogue could not be read, so the items cannot be named or found).
 */
export type ReviewSection<T> =
  { readonly kind: 'ready'; readonly value: T } | { readonly kind: 'catalogue_unavailable' };

/** The rows of one resistance item: when the player buys it, and how often. */
export interface ResistanceItemReview {
  /** The item. */
  readonly item: ResistanceItemView;
  /** The minute the player buys it, against the tier's. */
  readonly minute: ReviewRow;
  /** How often the player buys it, against the tier's pick rate. */
  readonly rate: ReviewRow;
}

/** The resistance part of the deaths tab. */
export interface ResistanceReview {
  /** The minute of the player's first resistance item. */
  readonly firstMinute: ReviewRow;
  /** The player's deaths before their first resistance item. */
  readonly deathsBefore: ReviewRow;
  /** Every resistance item, in the order of the list, whether or not anything is known of it. */
  readonly items: readonly ResistanceItemReview[];
}

/** The metrics of one family, in the order they are shown. */
export interface ReviewFamily {
  /** The family. */
  readonly family: MetricFamily;
  /** The rows of its metrics. */
  readonly rows: readonly ReviewRow[];
}

/** The "Stats" tab: the 24 metrics of the match page. */
export interface ReviewStats {
  /** The 13 metrics of the whole match, by family, in the order of the match page. */
  readonly families: readonly ReviewFamily[];
  /** The 11 metrics of a phase. */
  readonly phases: readonly ReviewRow[];
}

/** The summary tab: the points flagged in a meaningful share of the matches. */
export interface ReviewSummary {
  /** The points that were weak often enough, the most often weak first. */
  readonly weaknesses: readonly ReviewRow[];
  /** The points that were strong often enough, the most often strong first. */
  readonly strengths: readonly ReviewRow[];
}

/** The deaths tab. */
export interface ReviewDeaths {
  /** The deaths of each phase. */
  readonly phases: readonly ReviewRow[];
  /** The resistance items and the deaths before the first one. */
  readonly resistance: ReviewSection<ResistanceReview>;
}

/** The players tab. */
export interface ReviewPlayers {
  /** The player's place among the players on each figure of the scoreboard. */
  readonly places: readonly ReviewRow[];
  /** How often the player is in Valve's top three. */
  readonly topThree: ReviewRow;
  /**
   * The player's average place in Valve's top three, over the matches they are in it. Getting into
   * the top three is judged by {@link ReviewPlayers.topThree}, so this row marks no match.
   */
  readonly topThreePlace: ReviewRow;
}

/** The review of the player's last matches. */
export interface Review {
  /** The last matches, which the review is about. */
  readonly recent: ReviewWindow;
  /** The matches before them, which the progress compares with. */
  readonly before: ReviewWindow;
  /** Where the comparison with the tier above stands. */
  readonly community: ReviewCommunity;
  /** The summary tab. */
  readonly summary: ReviewSummary;
  /** The stats tab. */
  readonly stats: ReviewStats;
  /** The deaths tab. */
  readonly deaths: ReviewDeaths;
  /** The damage by source over the last matches and the ones before; it has no tier figure. */
  readonly damage: ReviewSection<readonly DamageShareRow[]>;
  /** The players tab. */
  readonly players: ReviewPlayers;
}

/**
 * What the review page shows: `no_account` when no account is linked, `empty` when the player has no
 * analysed match yet, the review otherwise.
 */
export type ReviewView =
  | { readonly kind: 'no_account' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly review: Review };

/** One of the last matches, with the community data it is compared with. */
export interface ReviewMatch {
  /** The match and its stored values. */
  readonly match: RecentMatch;
  /**
   * The data of the tier above for the duration window of the match, or `null` when none is cached
   * (or it holds too few matches even over every rank): the match then gets no community mark.
   */
  readonly reference: CommunityReference | null;
}
