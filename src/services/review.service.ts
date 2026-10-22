/**
 * The review of the player's last matches: what the review page reads, and the community data it
 * compares the matches with.
 *
 * The review sums up the last {@link REVIEW_MATCHES} analysed matches of the linked account, and sets
 * them against the 20 before (the progress) and against the players of the rank tier above the
 * player's current one (the community). This service reads everything the page is made of, and
 * `./review-build` puts it together:
 * - the player's matches with every value stored for them (`./metrics.repository`): the projections
 *   of the current version of the metrics, the last matches and the ones before in one listing;
 * - the current rank of the player (`./linked-account.repository`), which gives the tier above;
 * - the community data of that tier for the duration window of each of the last matches
 *   (`./benchmark.service`), and its item statistics (`./item-benchmark.service`), both as the cache
 *   holds them, whatever their age;
 * - the item catalogue (`./game-asset.service`), which names the resistance items and finds their
 *   ids, and the loadout of Paige in the hero catalogue (`./hero-catalog.service`), which classifies
 *   the damage by source. Both are kept in the database for a week. Reading the review needs both;
 *   downloading the community data only needs the ids of the items, so it reads the item catalogue
 *   alone.
 *
 * {@link ReviewService.getReview} only reads, so it is quick and works offline: what the cache does
 * not hold yet is told in the review, never replaced by a number. The community data is downloaded
 * apart, by {@link ReviewService.refreshCommunity}, which the page calls when it opens, then reads the
 * review again. One download serves a day.
 *
 * **The order of the downloads.** The refreshes follow one another, never side by side, so that the
 * budget of the analytics requests (30 a minute, `ANALYTICS_RATE_LIMIT`) is spent in an order that
 * can be told in advance: first the cohorts, one for each duration window the last matches are in,
 * the window that holds the most of them first (and, between two that hold as many, the one of the
 * more recent match), then the item statistics. A cohort costs three requests and the item statistics
 * two, so when the budget or a pause of deadlock-api stops the downloads, what the last matches
 * rest on most is what was downloaded.
 *
 * **An account change.** The linked account is looked at again before each download. Once it is no
 * longer the one the refresh started for, the refresh stops there: the budget is not spent for an
 * account that is gone. What was downloaded before stays (it is data of the community, of no
 * player), and what was left to download counts as unavailable.
 *
 * Nothing is logged on the normal path. One line is written at `info` level each time a catalogue
 * the call needs cannot be read (it is the state of the network, not a fault; once per call,
 * however many failed). It says which catalogue is missing (the items, the loadout of Paige) and,
 * when a request failed, holds the log context of the first failure, as `MatchBreakdownService`
 * logs it (`errorLogContext`: the kind and the context of the error, the message of its cause and
 * its stack). That is technical detail of the failure, never an account id or a value of a
 * catalogue.
 *
 * @packageDocumentation
 */
import {
  cohortKey,
  durationWindowOf,
  reviewCohortRank,
  type Cohort,
  type CohortRank,
} from '../core/analysis/cohort';
import { REVIEW_MATCHES } from '../core/analysis/insights/thresholds';
import { PROJECTION_VERSION } from '../core/analysis/registry';
import { RESISTANCE_ITEMS } from '../core/analysis/review/resistance-items';
import type { AccountId } from '../core/domain/account';
import { PAIGE_HERO_ID, type HeroLoadout } from '../core/domain/hero';
import { errorLogContext, toAppError } from '../core/errors/app-error';
import type { AccountSource } from '../ports/account-source.port';
import type { LogContext, Logger } from '../ports/logger.port';
import type { BenchmarkService, CohortRead, CohortRefresh } from './benchmark.service';
import type { GameAssetService, ItemCatalogue } from './game-asset.service';
import type { HeroCatalogService } from './hero-catalog.service';
import type { ItemBenchmarkRead, ItemBenchmarkService } from './item-benchmark.service';
import type { LinkedAccountRepository } from './linked-account.repository';
import type { MetricsRepository, RecentMatch } from './metrics.repository';
import { buildReview } from './review-build';
import type { ReviewView } from './review-view';

/** What {@link ReviewService} needs. */
export interface ReviewServiceDependencies {
  /** The linked account. The service works for it only, which it resolves itself. */
  readonly accountSource: AccountSource;
  /** Where the rank of the linked account is kept: the tier above it is what the review compares with. */
  readonly accounts: LinkedAccountRepository;
  /** Where the projections of the matches are kept: the values of the last matches. */
  readonly metrics: MetricsRepository;
  /** The community data of the cohorts: the duration windows of the tier above. */
  readonly benchmarks: BenchmarkService;
  /** The item statistics of the tier above. */
  readonly itemBenchmarks: ItemBenchmarkService;
  /** The game's catalogues: the item catalogue names the resistance items and the damage sources. */
  readonly assets: GameAssetService;
  /** The hero catalogue: the loadout of Paige, which tells the sources of her damage apart. */
  readonly heroes: HeroCatalogService;
  /** Structured logger. */
  readonly logger: Logger;
}

/**
 * What {@link ReviewService.refreshCommunity} did.
 *
 * - `fresh`: nothing was requested: everything the review compares with is less than a day old, or
 *   there is nothing to compare yet (no account, no analysed match);
 * - `updated`: new data was downloaded and stored, and all that was asked for could be had;
 * - `partial`: some of it could not be downloaded (the cached data, if any, stays as it was);
 * - `unavailable`: none of what had to be downloaded could be.
 */
export type ReviewCommunityRefresh = 'fresh' | 'updated' | 'partial' | 'unavailable';

/** The scope of the log line of this service. */
const LOG_SCOPE = 'review';

/** The message of the line about catalogues that cannot be read. */
const CATALOGUES_UNAVAILABLE = 'Review catalogues unavailable';

/** What the cache holds of the item statistics when they are not looked for: nothing. */
const NO_ITEM_STATS: ItemBenchmarkRead = { kind: 'missing' };

/** Where a review stands before anything beyond the player's matches is read. */
type ReviewSubject =
  /** No account is linked. */
  | { readonly kind: 'no_account' }
  /** An account is linked and none of its matches is analysed. */
  | { readonly kind: 'empty' }
  /** The matches of the linked account, most recent first, and the rank they are compared with. */
  | {
      readonly kind: 'matches';
      readonly accountId: AccountId;
      readonly recent: readonly RecentMatch[];
      readonly rank: CohortRank;
    };

/** What the review reads from the catalogues, each `null` when it could not be had. */
interface ReviewCatalogues {
  /** The items, abilities and weapons of the game, which name the resistance items. */
  readonly catalogue: ItemCatalogue | null;
  /** The weapon, the melee attack and the four signature abilities of Paige. */
  readonly loadout: HeroLoadout | null;
}

/**
 * List the cohorts the last matches are compared with, in the order they are refreshed in.
 *
 * Each match is compared with the cohort of its own duration window, so the cohorts are the
 * distinct windows of the matches ("distinct" is by `cohortKey`).
 *
 * @param lastMatches - The last matches, most recent first.
 * @param rank - The rank every cohort is made of.
 * @returns The distinct cohorts, the one that holds the most of the matches first. Between two that
 *   hold as many, the one of the more recent match comes first: the matches are listed most recent
 *   first, a cohort is listed where its first match is, and the sort keeps equal cohorts in the
 *   order they have.
 */
export function cohortsByCoverage(lastMatches: readonly RecentMatch[], rank: CohortRank): Cohort[] {
  const covered = new Map<string, { readonly cohort: Cohort; matches: number }>();
  for (const { durationS } of lastMatches) {
    const cohort: Cohort = { rank, window: durationWindowOf(durationS) };
    const key = cohortKey(cohort);
    const entry = covered.get(key);
    if (entry === undefined) {
      covered.set(key, { cohort, matches: 1 });
    } else {
      entry.matches += 1;
    }
  }
  return [...covered.values()]
    .toSorted((first, second) => second.matches - first.matches)
    .map(({ cohort }) => cohort);
}

/**
 * Tell what a series of refreshes amounts to.
 *
 * @param outcomes - The outcome of each refresh (the cohorts, then the item statistics).
 * @returns `fresh` when every one is fresh (also when there is none), `unavailable` when every one is
 *   unavailable, `partial` when some are and some are not, and `updated` otherwise.
 */
export function refreshOutcomeOf(outcomes: readonly CohortRefresh[]): ReviewCommunityRefresh {
  if (outcomes.every((outcome) => outcome === 'fresh')) {
    return 'fresh';
  }
  if (outcomes.every((outcome) => outcome === 'unavailable')) {
    return 'unavailable';
  }
  return outcomes.includes('unavailable') ? 'partial' : 'updated';
}

/**
 * Find the resistance items in the item catalogue.
 *
 * @param catalogue - The item catalogue.
 * @returns The id of each item of the list of resistance items that the catalogue knows, in list
 *   order. An item the catalogue does not know (a game patch renamed it) is left out.
 */
function resistanceItemIds(catalogue: ItemCatalogue): number[] {
  return RESISTANCE_ITEMS.flatMap(
    ({ className }) => catalogue.byClassName.get(className)?.id ?? [],
  );
}

/** Reads what the review page shows, and downloads the community data it compares the matches with. */
export class ReviewService {
  readonly #accountSource: AccountSource;
  readonly #accounts: LinkedAccountRepository;
  readonly #metrics: MetricsRepository;
  readonly #benchmarks: BenchmarkService;
  readonly #itemBenchmarks: ItemBenchmarkService;
  readonly #assets: GameAssetService;
  readonly #heroes: HeroCatalogService;
  readonly #logger: Logger;

  /**
   * @param dependencies - See {@link ReviewServiceDependencies}.
   */
  constructor(dependencies: ReviewServiceDependencies) {
    this.#accountSource = dependencies.accountSource;
    this.#accounts = dependencies.accounts;
    this.#metrics = dependencies.metrics;
    this.#benchmarks = dependencies.benchmarks;
    this.#itemBenchmarks = dependencies.itemBenchmarks;
    this.#assets = dependencies.assets;
    this.#heroes = dependencies.heroes;
    this.#logger = dependencies.logger;
  }

  /**
   * Read the review of the linked account, as it is stored: the last {@link REVIEW_MATCHES} analysed
   * matches against the same number before, each of the last ones compared with the community data of
   * the tier above for its duration window. Nothing is projected and nothing is downloaded but a
   * catalogue that was never or is no longer cached: the page asks for the community data with
   * {@link ReviewService.refreshCommunity}, and reads the review again.
   *
   * A catalogue that cannot be read does not fail the review: what needs it says so
   * (`catalogue_unavailable`), see `./review-view`.
   *
   * @returns What the page shows, see {@link ReviewView}. Without a linked account it is
   *   `no_account`; without a match projected with the current version of the metrics, `empty`.
   * @throws AppError of kind `storage` when the database fails (the matches, the rank, the community
   *   data). A failure of the catalogues never comes out, of whatever kind and database failures of
   *   their cache included. Any other error is a bug and is not hidden behind a state.
   */
  async getReview(): Promise<ReviewView> {
    const subject = await this.#subjectOf(2 * REVIEW_MATCHES);
    if (subject.kind !== 'matches') {
      return subject;
    }
    const { recent, rank } = subject;

    // Independent of each other: the cache of the cohorts and the catalogues are read at once.
    const [cohorts, { catalogue, loadout }] = await Promise.all([
      this.#readCohorts(cohortsByCoverage(recent.slice(0, REVIEW_MATCHES), rank)),
      this.#readCatalogues(),
    ]);
    // The item statistics are looked for by the ids the catalogue gives: the one read that waits.
    const itemIds = catalogue === null ? [] : resistanceItemIds(catalogue);
    const itemBenchmark =
      itemIds.length === 0 ? NO_ITEM_STATS : await this.#itemBenchmarks.read(rank, itemIds);
    return {
      kind: 'ready',
      review: buildReview({ recent, rank, cohorts, itemBenchmark, catalogue, loadout }),
    };
  }

  /**
   * Download the community data the review compares the matches with, unless the cache holds it still
   * fresh: a cohort for each duration window of the last matches, then the item statistics of the
   * tier above. The page calls it when the review opens, then reads the review again; one download
   * serves every opening for a day.
   *
   * The downloads follow one another, in this order: the cohorts, the one that holds the most of the
   * last matches first (the more recent match settling a tie), then the item statistics, which are
   * left out when the item catalogue cannot be read or knows none of the resistance items (there is
   * nothing to ask for). The hero catalogue is not read. See the header of the module for why the
   * order, and for what happens when the linked account changes in the middle.
   *
   * @returns `fresh` when nothing was requested: everything is less than a day old, or there is
   *   nothing to compare yet (no account, no analysed match). `updated` when new data was downloaded
   *   and stored. `partial` when some of what had to be downloaded could not be (a request failed, a
   *   pause or the budget stopped it, or the account changed and the rest was not downloaded),
   *   `unavailable` when none of it could (an account that changed before the first download
   *   included). The cached data, if any, stays as it was. A catalogue that cannot be read leaves the
   *   item statistics out of the count.
   * @throws AppError of kind `storage` when the database fails (the matches, the rank, the linked
   *   account). The downloads themselves never reject.
   */
  async refreshCommunity(): Promise<ReviewCommunityRefresh> {
    const subject = await this.#subjectOf(REVIEW_MATCHES);
    if (subject.kind !== 'matches') {
      return 'fresh';
    }
    const { accountId, recent, rank } = subject;
    const catalogue = await this.#readItemCatalogue();
    const itemIds = catalogue === null ? [] : resistanceItemIds(catalogue);

    // The downloads, in the order they are taken: the cohorts, then the item statistics.
    const steps = cohortsByCoverage(recent, rank).map(
      (cohort) => () => this.#benchmarks.refresh(accountId, cohort),
    );
    if (itemIds.length > 0) {
      steps.push(() => this.#itemBenchmarks.refresh(accountId, rank, itemIds));
    }

    // One after the other, so that the budget of the minute is spent in a predictable order.
    const outcomes: CohortRefresh[] = [];
    for (const step of steps) {
      // The account may have been switched or unlinked since the last step (or since it was read,
      // for the first one): what is left would be downloaded for nobody, and would spend the budget.
      if ((await this.#accountSource.currentAccountId()) !== accountId) {
        outcomes.push('unavailable');
        break;
      }
      outcomes.push(await step());
    }
    return refreshOutcomeOf(outcomes);
  }

  /**
   * Find where the review stands: the linked account, and its most recent analysed matches with the
   * rank they are compared with.
   *
   * @param limit - How many matches to list, at most.
   * @returns `no_account` without a linked account, `empty` when none of its matches is projected
   *   with the current version of the metrics, otherwise the matches (most recent first) and the
   *   tier above the current rank of the account, or every rank when it has none.
   * @throws AppError of kind `storage` when the database fails.
   */
  async #subjectOf(limit: number): Promise<ReviewSubject> {
    const accountId = await this.#accountSource.currentAccountId();
    if (accountId === null) {
      return { kind: 'no_account' };
    }
    const [recent, rank] = await Promise.all([
      this.#metrics.listRecent(accountId, PROJECTION_VERSION, limit),
      this.#accounts.getRank(accountId),
    ]);
    if (recent.length === 0) {
      return { kind: 'empty' };
    }
    // Only the current rank counts, as for the analysis of a match: the review looks at the player
    // as they are now, whatever rank each of the matches was played at.
    return { kind: 'matches', accountId, recent, rank: reviewCohortRank(rank?.badge ?? null) };
  }

  /**
   * Read what the cache holds of the community data of some cohorts.
   *
   * @param cohorts - The cohorts, each once.
   * @returns What the cache holds, by cohort key (`cohortKey`).
   * @throws AppError of kind `storage` when the database fails.
   */
  async #readCohorts(cohorts: readonly Cohort[]): Promise<Map<string, CohortRead>> {
    return new Map(
      await Promise.all(
        cohorts.map(
          async (cohort) => [cohortKey(cohort), await this.#benchmarks.read(cohort)] as const,
        ),
      ),
    );
  }

  /**
   * Read the two catalogues the review is built with: the items, which name the resistance items and
   * the damage sources, and the loadout of Paige in the hero catalogue. Both come from the cache when
   * it is fresh (and even when it is not, should the download fail); a catalogue is downloaded only
   * when it was never or is no longer cached.
   *
   * @returns The item catalogue and the loadout, each `null` when it cannot be had: when its
   *   catalogue cannot be read, whatever the failure (offline with nothing cached, a refused request,
   *   a spent budget, a pause, the cache itself), and for the loadout also when the hero catalogue
   *   gives Paige none (a partial loadout would classify the sources wrongly, so there is none). One
   *   line is logged at `info` level in that case, whatever the number of catalogues that failed.
   */
  async #readCatalogues(): Promise<ReviewCatalogues> {
    const failures: unknown[] = [];
    const keepFailure = (error: unknown): null => {
      failures.push(error);
      return null;
    };
    // Both are asked at once: they share the asset budget, and each shares its run among the calls
    // that overlap, so the page asking twice downloads each catalogue once.
    const [catalogue, heroes] = await Promise.all([
      this.#assets.getItemCatalogue().catch(keepFailure),
      this.#heroes.getHeroAssets().catch(keepFailure),
    ]);
    const loadout = heroes?.find((hero) => hero.id === PAIGE_HERO_ID)?.loadout ?? null;
    if (catalogue === null || loadout === null) {
      this.#logCataloguesUnavailable(failures, {
        itemsUnavailable: catalogue === null,
        loadoutUnavailable: loadout === null,
      });
    }
    return { catalogue, loadout };
  }

  /**
   * Read the item catalogue alone, which is all the download of the item statistics needs (it finds
   * the ids of the resistance items). It comes from the cache when it is fresh, and is downloaded
   * when it was never or is no longer cached, as in {@link ReviewService.getReview}.
   *
   * @returns The item catalogue, or `null` when it cannot be had, whatever the failure. One line is
   *   logged at `info` level in that case.
   */
  async #readItemCatalogue(): Promise<ItemCatalogue | null> {
    try {
      return await this.#assets.getItemCatalogue();
    } catch (error) {
      this.#logCataloguesUnavailable([error], { itemsUnavailable: true });
      return null;
    }
  }

  /**
   * Log, at `info` level, that a catalogue the review needs cannot be read: it is the state of the
   * network, not a fault.
   *
   * The catalogue services logged what a refresh that fell back on the cache could not do; this is
   * the one that has no cache to fall back on. The first failure tells the state of the network as
   * well as all of them would.
   *
   * @param failures - What the reads of the catalogues failed with, in the order they failed; none
   *   when the hero catalogue was read but gives Paige no loadout.
   * @param unavailable - Which catalogue is missing.
   */
  #logCataloguesUnavailable(failures: readonly unknown[], unavailable: LogContext): void {
    this.#logger.log('info', LOG_SCOPE, CATALOGUES_UNAVAILABLE, {
      ...(failures.length === 0 ? {} : errorLogContext(toAppError(failures[0]))),
      ...unavailable,
    });
  }
}
