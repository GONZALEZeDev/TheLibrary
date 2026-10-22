/**
 * The resistance rows of the deaths tab of the review: the twelve resistance items, when the player
 * buys each of them and how often, and the deaths before the first one.
 *
 * Every row is a point judged match by match and summed up around the **mean** (`./review-row`), as
 * the tier's figures of these points are means: the mean minute an item is bought at, the share of
 * matches that buy it. The gap with the tier is an amount in the unit of the point.
 *
 * - **The minute of a resistance item.** The minute of the match the player first buys the item,
 *   placed among the purchases of the tier (a minute earlier is better), against the mean minute the
 *   tier buys it at.
 * - **The pick rate of a resistance item.** One in a match that bought the item, zero in one that did
 *   not, against the share of the tier's matches that bought it. Buying more of an item is neither
 *   better nor worse, so the rate has no mark and no direction.
 * - **The first resistance item.** The earliest purchase of the twelve in a match: its minute, which
 *   the tier has no figure for, and the player's deaths before it, which is judged by a fixed rule.
 *   A match that bought shop items but no resistance item has no first minute, and counts every
 *   death of the match as deaths before a resistance it never bought.
 *
 * What is not known is left out and never taken for zero: a match without the death details of the
 * archive has no deaths; a match with no shop purchase stored at all has unknown items (see
 * `hasShopPurchases`, `../core/analysis/review/review-values`), so it neither bought nor failed to
 * buy any item; and an item the catalogue does not know (it has no id) has no value in any match. A
 * match whose tier data is not cached is still counted, without a mark. Every item has its two rows,
 * known or not.
 *
 * No point here is placed from the length of the match: the points are read from the stored values
 * alone. The deaths of each phase, on the same tab of the page, have their own module
 * (`./review-deaths`).
 *
 * Nothing here reads a database, a file or the network, and nothing is logged.
 *
 * @packageDocumentation
 */
import { orientedPercentile } from '../core/analysis/insights/insights';
import { deathsMetric } from '../core/analysis/metrics/deaths.metric';
import {
  histogramMean,
  markOfDeathsBeforeResistance,
  markOfPercentile,
  placeInHistogram,
} from '../core/analysis/review/review-rules';
import {
  deathsBeforeItemKey,
  hasShopPurchases,
  itemBoughtAtKey,
} from '../core/analysis/review/review-values';
import type { ItemBenchmarkRead, ItemTiming } from './item-benchmark.service';
import type { RecentMatch } from './metrics.repository';
import { UNJUDGED, pointMatchesOf, pointRowOf, type ReviewPoint } from './review-row';
import type { ResistanceItemView, ResistanceReview, ReviewMatch } from './review-view';

/** How many seconds make a minute: the purchases are stored in seconds, the rows show minutes. */
const SECONDS_PER_MINUTE = 60;

/** A point of the tab, on last matches that carry their tier data. */
type ResistancePoint = ReviewPoint<ReviewMatch>;

/**
 * When a match first bought an item.
 *
 * @param match - The match.
 * @param itemId - The asset id of the item.
 * @returns The second of the purchase (0 for an item bought at the very start of the match), or
 *   `null` when no purchase of the item is stored: the match did not buy it, or its items are not
 *   known (see `hasShopPurchases`).
 */
function boughtAtS(match: RecentMatch, itemId: number): number | null {
  return match.values.get(itemBoughtAtKey(itemId)) ?? null;
}

/** The first resistance item a match bought. */
interface FirstResistance {
  /** The asset id of the item. */
  readonly itemId: number;
  /** The second it was first bought. */
  readonly boughtAtS: number;
}

/**
 * Find the first resistance item a match bought.
 *
 * @param match - The match.
 * @param itemIds - The asset ids of the resistance items the catalogue knows, in list order.
 * @returns The earliest purchase among them (the first of the list when two were bought in the same
 *   second), or `null` when the match bought none.
 */
function firstResistanceOf(match: RecentMatch, itemIds: readonly number[]): FirstResistance | null {
  let first: FirstResistance | null = null;
  for (const itemId of itemIds) {
    const at = boughtAtS(match, itemId);
    if (at !== null && (first === null || at < first.boughtAtS)) {
      first = { itemId, boughtAtS: at };
    }
  }
  return first;
}

/** What the tier's statistics say of an item, once they are known to be usable. */
interface TierItem {
  /** When the tier buys the item. */
  readonly timing: ItemTiming;
  /** How many matches of the tier the statistics hold. */
  readonly sampleMatches: number;
}

/**
 * Find what the tier's statistics say of an item.
 *
 * @param benchmark - What the cache holds of the tier's item statistics.
 * @param itemId - The asset id of the item, or `null` when the catalogue does not know it.
 * @returns The item's timing and the size of the tier, or `null` when there is nothing to compare
 *   with: nothing cached, a tier too small even over every rank, or an item the statistics lack.
 */
function tierItemOf(benchmark: ItemBenchmarkRead, itemId: number | null): TierItem | null {
  if (itemId === null || benchmark.kind !== 'cached' || benchmark.data.used === null) {
    return null;
  }
  const timing = benchmark.data.items.get(itemId);
  return timing === undefined ? null : { timing, sampleMatches: benchmark.data.sampleMatches };
}

/**
 * The point of the minute a resistance item is bought.
 *
 * @param item - The item.
 * @param tierItem - What the tier's statistics say of it, or `null` when they say nothing.
 * @returns The point.
 */
function minutePoint(item: ResistanceItemView, tierItem: TierItem | null): ResistancePoint {
  const { itemId } = item;
  // The mean minute of the tier is the same for every match; an item nobody bought has none.
  const tierMinutes = tierItem?.timing.minutes;
  const tierMean = tierMinutes === undefined ? null : histogramMean(tierMinutes);
  return {
    subject: { kind: 'resistance_minute', item },
    unit: 'minute',
    better: 'lower',
    display: 'absolute',
    center: 'mean',
    valueIn: ({ match }) => {
      const at = itemId === null ? null : boughtAtS(match, itemId);
      return at === null ? null : at / SECONDS_PER_MINUTE;
    },
    judge: (_reviewMatch, minute) => {
      const placement = tierMinutes === undefined ? null : placeInHistogram(minute, tierMinutes);
      if (placement === null || tierMean === null) {
        return UNJUDGED;
      }
      const percentile = orientedPercentile(placement, 'lower');
      return {
        mark: markOfPercentile(percentile),
        marked: true,
        percentile,
        comparison: { player: minute, community: tierMean },
      };
    },
  };
}

/**
 * The point of how often a resistance item is bought.
 *
 * @param item - The item.
 * @param tierItem - What the tier's statistics say of it, or `null` when they say nothing.
 * @returns The point.
 */
function ratePoint(item: ResistanceItemView, tierItem: TierItem | null): ResistancePoint {
  const { itemId } = item;
  // An item can be bought more than once in a match (bought, sold, bought again), so the tier's
  // purchases may outnumber its matches: the share of matches is capped at all of them.
  const tierRate =
    tierItem === null || tierItem.sampleMatches <= 0
      ? null
      : Math.min(1, tierItem.timing.purchases / tierItem.sampleMatches);
  return {
    subject: { kind: 'resistance_rate', item },
    unit: 'rate',
    better: null,
    display: 'absolute',
    center: 'mean',
    valueIn: ({ match }) => {
      // Not bought is only told in a match whose items are known: with none stored, it is unknown.
      if (itemId === null || !hasShopPurchases(match.values)) {
        return null;
      }
      return boughtAtS(match, itemId) === null ? 0 : 1;
    },
    judge: (_reviewMatch, bought) => ({
      ...UNJUDGED,
      comparison: tierRate === null ? null : { player: bought, community: tierRate },
    }),
  };
}

/**
 * The point of the minute of the first resistance item, whichever it is.
 *
 * @param itemIds - The asset ids of the resistance items the catalogue knows.
 * @returns The point: the tier has no figure for it, and no rule judges it.
 */
function firstMinutePoint(itemIds: readonly number[]): ResistancePoint {
  return {
    subject: { kind: 'first_resistance_minute' },
    unit: 'minute',
    better: 'lower',
    display: 'absolute',
    center: 'mean',
    valueIn: ({ match }) => {
      const first = firstResistanceOf(match, itemIds);
      return first === null ? null : first.boughtAtS / SECONDS_PER_MINUTE;
    },
    judge: () => UNJUDGED,
  };
}

/**
 * The point of the deaths before the first resistance item.
 *
 * @param itemIds - The asset ids of the resistance items the catalogue knows.
 * @returns The point: the tier has no figure for it, a fixed rule judges it.
 */
function deathsBeforePoint(itemIds: readonly number[]): ResistancePoint {
  return {
    subject: { kind: 'deaths_before_resistance' },
    unit: 'deaths',
    better: 'lower',
    display: 'absolute',
    center: 'mean',
    valueIn: ({ match }) => {
      const first = firstResistanceOf(match, itemIds);
      if (first !== null) {
        return match.values.get(deathsBeforeItemKey(first.itemId)) ?? null;
      }
      // A match that bought shop items but no resistance item died all its deaths before one it never
      // bought; a match whose items are unknown may have bought one.
      return hasShopPurchases(match.values) ? (match.values.get(deathsMetric.key) ?? null) : null;
    },
    judge: (_reviewMatch, deaths) => ({
      ...UNJUDGED,
      mark: markOfDeathsBeforeResistance(deaths),
      marked: true,
    }),
  };
}

/**
 * Build the resistance part of the deaths tab.
 *
 * @param recent - The last matches, most recent first.
 * @param before - The matches before them, which the progress compares with.
 * @param items - The resistance items as the catalogue names them, in the order they are shown.
 * @param benchmark - What the cache holds of the item statistics of the tier above.
 * @returns The minute and the pick rate of every item, in the order of `items`, whether or not
 *   anything is known of it, and the first resistance item of each match.
 */
export function resistanceReviewOf(
  recent: readonly ReviewMatch[],
  before: readonly RecentMatch[],
  items: readonly ResistanceItemView[],
  benchmark: ItemBenchmarkRead,
): ResistanceReview {
  const itemIds = items.flatMap(({ itemId }) => itemId ?? []);
  const earlier = pointMatchesOf(before);
  return {
    firstMinute: pointRowOf(firstMinutePoint(itemIds), recent, earlier),
    deathsBefore: pointRowOf(deathsBeforePoint(itemIds), recent, earlier),
    items: items.map((item) => {
      const tierItem = tierItemOf(benchmark, item.itemId);
      return {
        item,
        minute: pointRowOf(minutePoint(item, tierItem), recent, earlier),
        rate: pointRowOf(ratePoint(item, tierItem), recent, earlier),
      };
    }),
  };
}
