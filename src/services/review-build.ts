/**
 * The assembly of the review of the player's last matches: {@link buildReview} puts together what
 * the services read (the player's matches, the community data of the tier above, the item statistics,
 * the item catalogue and the hero's loadout) into the {@link Review} the page shows.
 *
 * The rows are not built here: `./review-stats`, `./review-deaths`, `./review-resistance` and
 * `./review-players` each build the rows of their tab, and the types of the view are in
 * `./review-view`. What is done here is what ties them together:
 *
 * - **The two windows.** The listing holds the player's matches, most recent first: the first
 *   `REVIEW_MATCHES` are the last matches the review is about, and the rest are the matches before,
 *   which the progress compares with.
 * - **The tier's data of each match.** Each of the last matches is compared with the community data
 *   of its own duration window (`cohortKey`), when the cache holds some. A match with none is still
 *   counted, with no community mark, and the review says how many there are.
 * - **The state of the comparison.** How many matches fell back on every rank, how many have no data
 *   at all, whether the data used is stale and how old the oldest of it is.
 * - **The sections that need the item catalogue.** The resistance items and the damage by source
 *   cannot be built without it (the damage needs the hero's loadout as well); they say so instead.
 * - **The summary.** Every row of the tabs that is flagged as a weakness or a strength, most often
 *   flagged first, with no cut.
 *
 * Nothing here reads a database, a file or the network, and nothing is logged.
 *
 * @packageDocumentation
 */
import { cohortKey, durationWindowOf, type CohortRank } from '../core/analysis/cohort';
import { REVIEW_MATCHES } from '../core/analysis/insights/thresholds';
import { damageShares, type DamageShareRow } from '../core/analysis/review/damage-review';
import { RESISTANCE_ITEMS } from '../core/analysis/review/resistance-items';
import type { HeroLoadout } from '../core/domain/hero';
import type { CohortRead } from './benchmark.service';
import { communityOf, type CommunityState } from './community-placement';
import type { ItemCatalogue } from './game-asset.service';
import type { ItemBenchmarkRead } from './item-benchmark.service';
import type { RecentMatch } from './metrics.repository';
import { deathRowsOf } from './review-deaths';
import { playerRowsOf } from './review-players';
import { resistanceReviewOf } from './review-resistance';
import { statsRowsOf } from './review-stats';
import type {
  ResistanceItemView,
  ResistanceReview,
  Review,
  ReviewCommunity,
  ReviewDeaths,
  ReviewMatch,
  ReviewPlayers,
  ReviewRow,
  ReviewSection,
  ReviewStats,
  ReviewSummary,
  ReviewWindow,
} from './review-view';

/** What {@link buildReview} puts the review together from. */
export interface ReviewInputs {
  /**
   * The player's most recent analysed matches, most recent first: the first {@link REVIEW_MATCHES}
   * are the last matches the review is about, and the ones that follow are the matches before them.
   */
  readonly recent: readonly RecentMatch[];
  /** The rank of the cohort the player is compared with: the tier above theirs, or every rank. */
  readonly rank: CohortRank;
  /**
   * What the cache holds of the community data of the rank, by cohort key (`cohortKey`): one entry
   * for each duration window the last matches are in. A window with no entry has nothing cached.
   */
  readonly cohorts: ReadonlyMap<string, CohortRead>;
  /** What the cache holds of the item statistics of the rank. */
  readonly itemBenchmark: ItemBenchmarkRead;
  /** The item catalogue, or `null` when it could not be read. */
  readonly catalogue: ItemCatalogue | null;
  /** The loadout of the hero, or `null` when the hero catalogue does not give it. */
  readonly loadout: HeroLoadout | null;
}

/** What the cache holds for a cohort that has no entry: nothing. */
const NOT_CACHED: CohortRead = { kind: 'missing' };

/** One of the last matches, with the tier's data it is compared with and the state of that data. */
interface MatchWithCommunity {
  /** The match and its tier data, which the builders of the rows read. */
  readonly reviewMatch: ReviewMatch;
  /** Where the comparison of the match with the tier stands. */
  readonly state: CommunityState;
}

/**
 * Describe the matches of a window of the review.
 *
 * @param matches - The matches of the window.
 * @returns How many there are, and when the earliest and the latest started (`null` for none).
 */
function windowOf(matches: readonly RecentMatch[]): ReviewWindow {
  const starts = matches.map(({ startTime }) => startTime);
  return {
    count: matches.length,
    firstStartTime: starts.length === 0 ? null : Math.min(...starts),
    lastStartTime: starts.length === 0 ? null : Math.max(...starts),
  };
}

/**
 * Attach to each of the last matches the tier's data of its own duration window.
 *
 * @param lastMatches - The last matches.
 * @param rank - The rank the matches are compared with.
 * @param cohorts - What the cache holds of the community data, by cohort key.
 * @returns The matches in the same order, each with its tier data (`null` when the cache holds none
 *   for its window, or too few matches even over every rank) and the state of that comparison.
 */
function withCommunityOf(
  lastMatches: readonly RecentMatch[],
  rank: CohortRank,
  cohorts: ReadonlyMap<string, CohortRead>,
): MatchWithCommunity[] {
  return lastMatches.map((match) => {
    const window = durationWindowOf(match.durationS);
    const { state, reference } = communityOf(
      cohorts.get(cohortKey({ rank, window })) ?? NOT_CACHED,
    );
    return { reviewMatch: { match, reference }, state };
  });
}

/**
 * Tell how far the comparison with the tier goes, from the state of each of the last matches.
 *
 * @param rank - The rank the matches are compared with.
 * @param states - The community state of each of the last matches.
 * @returns `available` when some match is compared (with the matches that fell back on every rank,
 *   the ones with no data to compare with, whether the data used is stale, and when the oldest of it
 *   was downloaded), and `missing` when none is.
 */
function communityStateOf(rank: CohortRank, states: readonly CommunityState[]): ReviewCommunity {
  const used = states.filter((state) => state.kind === 'available');
  if (used.length === 0) {
    return { kind: 'missing', rank };
  }
  return {
    kind: 'available',
    rank,
    fallbackMatches: used.filter(({ fallback }) => fallback).length,
    missingMatches: states.length - used.length,
    stale: used.some(({ stale }) => stale),
    fetchedAt: Math.min(...used.map(({ fetchedAt }) => fetchedAt)),
  };
}

/**
 * Name the twelve resistance items from the item catalogue.
 *
 * @param catalogue - The item catalogue.
 * @returns A view of each item of the list of resistance items, in list order. The list gives the
 *   class name, the tier and what the item protects against; the catalogue only gives the id, the
 *   name and the image, which are `null` for a class name it does not know.
 */
function resistanceItemsOf(catalogue: ItemCatalogue): readonly ResistanceItemView[] {
  return RESISTANCE_ITEMS.map(({ className, protects, tier }) => {
    const entry = catalogue.byClassName.get(className);
    return {
      itemId: entry?.id ?? null,
      className,
      name: entry?.name ?? null,
      imageUrl: entry?.imageUrl ?? null,
      tier,
      protects,
    };
  });
}

/**
 * Build the resistance part of the deaths tab.
 *
 * @param catalogue - The item catalogue, or `null` when it could not be read.
 * @param reviewMatches - The last matches, most recent first, with their tier data.
 * @param earlierMatches - The matches before them.
 * @param itemBenchmark - What the cache holds of the item statistics of the tier.
 * @returns The rows of the twelve resistance items, or `catalogue_unavailable` without the
 *   catalogue, which finds the items.
 */
function resistanceSectionOf(
  catalogue: ItemCatalogue | null,
  reviewMatches: readonly ReviewMatch[],
  earlierMatches: readonly RecentMatch[],
  itemBenchmark: ItemBenchmarkRead,
): ReviewSection<ResistanceReview> {
  if (catalogue === null) {
    return { kind: 'catalogue_unavailable' };
  }
  const items = resistanceItemsOf(catalogue);
  return {
    kind: 'ready',
    value: resistanceReviewOf(reviewMatches, earlierMatches, items, itemBenchmark),
  };
}

/**
 * Build the damage by source over the last matches and the ones before.
 *
 * @param catalogue - The item catalogue, or `null` when it could not be read.
 * @param loadout - The loadout of the hero, or `null` when it is not known.
 * @param lastMatches - The last matches.
 * @param earlierMatches - The matches before them.
 * @returns The share of each source, or `catalogue_unavailable` without the catalogue, which names
 *   the sources, or without the loadout, which classifies them.
 */
function damageSectionOf(
  catalogue: ItemCatalogue | null,
  loadout: HeroLoadout | null,
  lastMatches: readonly RecentMatch[],
  earlierMatches: readonly RecentMatch[],
): ReviewSection<readonly DamageShareRow[]> {
  if (catalogue === null || loadout === null) {
    return { kind: 'catalogue_unavailable' };
  }
  return {
    kind: 'ready',
    value: damageShares({
      now: lastMatches.map(({ values }) => values),
      before: earlierMatches.map(({ values }) => values),
      loadout,
      itemsByClassName: catalogue.byClassName,
    }),
  };
}

/**
 * Pick the rows of one side of the summary.
 *
 * @param rows - The rows of the review, in the order of the tabs.
 * @param side - The side.
 * @returns The rows listed on that side, the most often flagged first (the most often weak for the
 *   weaknesses, the most often strong for the strengths). At the same count the one that is less
 *   often flagged on the other side comes first, and at the same two counts the one that comes first
 *   in the tabs: the sort is stable, so equal rows keep the order they have in `rows`.
 */
function rowsOnSide(
  rows: readonly ReviewRow[],
  side: 'weakness' | 'strength',
): readonly ReviewRow[] {
  const [own, opposite] =
    side === 'weakness' ? (['weak', 'strong'] as const) : (['strong', 'weak'] as const);
  return rows
    .filter((row) => row.side === side)
    .toSorted((first, second) => {
      const byOwnCount = second[own] - first[own];
      return byOwnCount === 0 ? first[opposite] - second[opposite] : byOwnCount;
    });
}

/**
 * List the points that were flagged.
 *
 * @param stats - The stats tab.
 * @param deaths - The deaths tab.
 * @param players - The players tab.
 * @returns The weaknesses and the strengths: every row of the tabs that has a side, without a cut.
 *   The rows are the very rows of their tabs. The tab order that settles a tie is the stats (the
 *   families, then the phases), the deaths of each phase, the resistance rows (the first item, the
 *   deaths before it, then the minute and the rate of each item), the places, the top three and the
 *   place in it.
 */
function summaryOf(
  stats: ReviewStats,
  deaths: ReviewDeaths,
  players: ReviewPlayers,
): ReviewSummary {
  const resistance =
    deaths.resistance.kind === 'ready'
      ? [
          deaths.resistance.value.firstMinute,
          deaths.resistance.value.deathsBefore,
          ...deaths.resistance.value.items.flatMap(({ minute, rate }) => [minute, rate]),
        ]
      : [];
  const rows = [
    ...stats.families.flatMap(({ rows: familyRows }) => familyRows),
    ...stats.phases,
    ...deaths.phases,
    ...resistance,
    ...players.places,
    players.topThree,
    players.topThreePlace,
  ];
  return { weaknesses: rowsOnSide(rows, 'weakness'), strengths: rowsOnSide(rows, 'strength') };
}

/**
 * Put the review of the player's last matches together.
 *
 * @param inputs - See {@link ReviewInputs}.
 * @returns The review. The first {@link REVIEW_MATCHES} matches are the last ones and the rest the
 *   matches before. Each of the last matches is compared with the tier's data of its own duration
 *   window, when the cache holds some: a match with none is counted, with no community mark. The
 *   sections that need the item catalogue are unavailable without it (and the damage without the
 *   loadout either).
 */
export function buildReview(inputs: ReviewInputs): Review {
  const { rank, cohorts, itemBenchmark, catalogue, loadout } = inputs;
  const lastMatches = inputs.recent.slice(0, REVIEW_MATCHES);
  const earlierMatches = inputs.recent.slice(REVIEW_MATCHES);

  const matchesWithCommunity = withCommunityOf(lastMatches, rank, cohorts);
  const reviewMatches = matchesWithCommunity.map(({ reviewMatch }) => reviewMatch);

  const stats = statsRowsOf(reviewMatches, earlierMatches);
  const deaths: ReviewDeaths = {
    phases: deathRowsOf(reviewMatches, earlierMatches),
    resistance: resistanceSectionOf(catalogue, reviewMatches, earlierMatches, itemBenchmark),
  };
  const players = playerRowsOf(reviewMatches, earlierMatches);
  return {
    recent: windowOf(lastMatches),
    before: windowOf(earlierMatches),
    community: communityStateOf(
      rank,
      matchesWithCommunity.map(({ state }) => state),
    ),
    summary: summaryOf(stats, deaths, players),
    stats,
    deaths,
    damage: damageSectionOf(catalogue, loadout, lastMatches, earlierMatches),
    players,
  };
}
