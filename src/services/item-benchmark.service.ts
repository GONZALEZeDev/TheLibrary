/**
 * The item statistics of the review: in which minutes of a match the Paige players of a rank tier
 * buy some shop items (the resistance items), and how many matches that is, over the last 30 days
 * and kept for a day.
 *
 * The review compares the player's purchases with those of the tier above their own, over a series
 * of matches of any length, so the statistics are asked once per rank for every length of match
 * ({@link ANY_LENGTH_WINDOW}), not once per duration window as the community data of a single match.
 * They are downloaded when the review opens ({@link ItemBenchmarkService.refresh}), kept in the
 * database (`api_cache`, as JSON), and read back by the review ({@link ItemBenchmarkService.read})
 * even when they are stale or when the app is offline. The download costs two requests, or three
 * when a small tier falls back to every rank, within the budget of `DeadlockApiService`:
 * - the size of the cohort, and the choice of the cohort that is used, exactly as for the match
 *   analysis ({@link chooseCohort}): a tier that holds fewer matches than a comparison needs is
 *   replaced by every rank, and when that is too small as well the entry says so (`used: null`)
 *   without any further request;
 * - the purchases of every item by minute of the cohort that is used, of which only the asked items
 *   are kept.
 *
 * An entry is kept under the rank that was asked for, with the items that were asked for: asking
 * for an item it does not hold makes it stale for that call, and the next download replaces it. An
 * asked item that nobody bought is kept as no purchase at all, so that the entry stays complete.
 * An entry without a cohort (`used: null`) holds no item and is complete for any items.
 *
 * The data belongs to no player, but it is only stored while the account that asked for it is the
 * linked one: a download that ends after the account was unlinked or switched is thrown away. The
 * entries sit under the `analytics.` prefix, so the purge of the community data covers them.
 *
 * The statistics only ever make the review richer, so {@link ItemBenchmarkService.refresh} never
 * fails: whatever cannot be downloaded leaves the entry as it was and is answered `unavailable`. A
 * rank is refreshed by one run at a time: a call that comes while another is running for the same
 * rank shares its answer (and so its items) instead of downloading the data twice.
 *
 * The lines written here hold: the kind of an error and, when it has one, the template of its
 * endpoint; counts and a boolean (what a download brought); and the path and code of the first
 * problem of an unreadable entry (`issue`). None carries an account id or a value of the data.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import {
  ANY_LENGTH_WINDOW,
  cohortRankKey,
  type Cohort,
  type CohortRank,
} from '../core/analysis/cohort';
import type { ItemStatsRow } from '../core/deadlock-api/item-stats.schema';
import type { AccountId } from '../core/domain/account';
import { toAppError } from '../core/errors/app-error';
import { describeFirstIssue } from '../core/errors/first-issue';
import type { AccountSource } from '../ports/account-source.port';
import type { Logger } from '../ports/logger.port';
import type { ApiCacheRepository } from './api-cache.repository';
import {
  ANALYTICS_KEY_PREFIX,
  chooseCohort,
  COHORT_MAX_AGE_MS,
  cohortQuery,
  cohortRankSchema,
  COMMUNITY_LOG_SCOPE,
  communityPeriodStartS,
  isStale,
  unavailableContext,
  type CohortRefresh,
} from './benchmark.service';
import type { AnalyticsFetch, DeadlockApiService } from './deadlock-api.service';

/** The start of the cache keys of the item statistics: the rank key follows it. */
const ITEMS_KEY_PREFIX = `${ANALYTICS_KEY_PREFIX}items.`;

/** The message of the line about statistics that could not be fetched. */
const UNAVAILABLE = 'Item statistics unavailable';

/** When one item is bought during the matches of a cohort. */
export interface ItemTiming {
  /** How many times the cohort bought the item: the sum of {@link ItemTiming.minutes}. */
  readonly purchases: number;
  /**
   * The purchases by minute of the match: 14 stands for 14:00 to 14:59. A minute in which the item
   * was not bought is absent; the map is empty for an item nobody bought.
   */
  readonly minutes: ReadonlyMap<number, number>;
}

/** The item statistics of a rank, as the review reads them. */
export interface ItemBenchmarkData {
  /** The rank that was asked for: the tier above the player's own, or every rank. */
  readonly wanted: CohortRank;
  /**
   * The rank the data is of: `wanted`, or every rank when `wanted` is a tier too small to compare
   * with (a fallback). `null` when even that is too small: there is then nothing to compare with,
   * and `items` is empty.
   */
  readonly used: CohortRank | null;
  /**
   * How many matches of the hero the cohort used holds. When `used` is `null`, the size of the
   * last cohort that was tried (every rank for a tier, the cohort itself for every rank).
   */
  readonly sampleMatches: number;
  /** The timing of each asked item, by item id; empty when `used` is `null`. */
  readonly items: ReadonlyMap<number, ItemTiming>;
  /** When the data was downloaded (Unix ms). */
  readonly fetchedAt: number;
}

/** What {@link ItemBenchmarkService.read} found. */
export type ItemBenchmarkRead =
  /** The data of the rank, `stale` when it is a day old or more (or dated in the future). */
  | { readonly kind: 'cached'; readonly data: ItemBenchmarkData; readonly stale: boolean }
  /** Nothing usable is cached for the rank and the items: not cached, unreadable, or lacking an item. */
  | { readonly kind: 'missing' };

/** What {@link ItemBenchmarkService} needs. */
export interface ItemBenchmarkServiceDependencies {
  /** Downloads the item statistics, within the budgets of deadlock-api. */
  readonly api: DeadlockApiService;
  /** Where the item statistics are kept. */
  readonly cache: ApiCacheRepository;
  /** The linked account: data downloaded for an account that is no longer linked is not stored. */
  readonly accountSource: AccountSource;
  /** Structured logger. */
  readonly logger: Logger;
  /** Current time (Unix ms); `Date.now` by default. */
  readonly now?: () => number;
}

/** Schema of the JSON that is stored: what the rank asked for does not say, without the time. */
const storedDataSchema = z.object({
  used: cohortRankSchema.nullable(),
  sampleMatches: z.int().nonnegative(),
  // One pair per item: the item, then its purchases by minute as pairs of the minute and the count.
  items: z.array(
    z.tuple([z.int().positive(), z.array(z.tuple([z.int().nonnegative(), z.int().nonnegative()]))]),
  ),
});

/** The data of a rank once downloaded, before it is stored: everything but the time. */
type DownloadedData = Omit<ItemBenchmarkData, 'fetchedAt'>;

/** What reading the JSON of an entry gave: the data, or the first problem as `<path>: <code>`. */
type DecodedData =
  | { readonly kind: 'decoded'; readonly data: DownloadedData }
  | { readonly kind: 'unreadable'; readonly issue: string };

/**
 * The cache key of the item statistics of a rank.
 *
 * @param rank - The rank.
 * @returns The key: `analytics.items.tier7`, or `analytics.items.all`.
 */
function cacheKey(rank: CohortRank): string {
  return `${ITEMS_KEY_PREFIX}${cohortRankKey(rank)}`;
}

/**
 * Make the timing of an item out of its purchases by minute.
 *
 * @param minutes - The purchases by minute.
 * @returns The timing: the minutes, and their total.
 */
function timingOf(minutes: ReadonlyMap<number, number>): ItemTiming {
  let purchases = 0;
  for (const count of minutes.values()) {
    purchases += count;
  }
  return { purchases, minutes };
}

/**
 * Keep the ids of the asked items that an entry can hold: the positive whole numbers, which are the
 * ones the stored schema reads back. An id that is not one (a caller's mistake) is left out of
 * everything: nothing is stored for it, and an entry is not taken to lack it. Otherwise it would
 * be written, and the entry could never be read again.
 *
 * @param itemIds - The items as the caller asked for them.
 * @returns The ids that are positive whole numbers, in the order they were asked.
 */
function storableItemIds(itemIds: readonly number[]): number[] {
  return itemIds.filter((itemId) => Number.isSafeInteger(itemId) && itemId > 0);
}

/**
 * Keep the asked items out of the rows of the item statistics.
 *
 * @param rows - The rows of the answer, one per item and minute.
 * @param itemIds - The items to keep, as {@link storableItemIds} left them.
 * @returns The timing of each asked item, in the order they were asked. An item the rows do not
 *   mention was bought by nobody: it has no purchase.
 */
function keepAskedItems(
  rows: readonly ItemStatsRow[],
  itemIds: readonly number[],
): Map<number, ItemTiming> {
  const minutesByItem = new Map<number, Map<number, number>>(
    itemIds.map((itemId) => [itemId, new Map()]),
  );
  for (const row of rows) {
    // The parser gives one row per item and minute, so a minute is never set twice.
    minutesByItem.get(row.itemId)?.set(row.minute, row.purchases);
  }
  return new Map(
    [...minutesByItem].map(([itemId, minutes]) => [itemId, timingOf(minutes)] as const),
  );
}

/**
 * Write the data of a rank as the JSON that is stored.
 *
 * @param data - The data, without the time of its download.
 * @returns The JSON: the items as a list of pairs, their minutes as a list of pairs too. The rank
 *   asked for is not in it: it is the one of the key.
 */
function encodeData(data: DownloadedData): string {
  return JSON.stringify({
    used: data.used,
    sampleMatches: data.sampleMatches,
    items: [...data.items].map(([itemId, timing]) => [itemId, [...timing.minutes]]),
  });
}

/**
 * Read the JSON of an entry back, checking all of it.
 *
 * @param payloadJson - The JSON that was stored.
 * @param wanted - The rank of the key the entry was stored under.
 * @returns The data, or `unreadable` with the path and the code of the first problem (never a value
 *   of the JSON).
 */
function decodeData(payloadJson: string, wanted: CohortRank): DecodedData {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { kind: 'unreadable', issue: 'not_json' };
  }
  const stored = storedDataSchema.safeParse(payload);
  if (!stored.success) {
    return { kind: 'unreadable', issue: describeFirstIssue(stored.error) };
  }
  const { used, sampleMatches, items } = stored.data;
  return {
    kind: 'decoded',
    data: {
      wanted,
      used,
      sampleMatches,
      items: new Map(items.map(([itemId, minutes]) => [itemId, timingOf(new Map(minutes))])),
    },
  };
}

/** Keeps the item statistics of the rank tiers the review compares the player with. */
export class ItemBenchmarkService {
  readonly #api: DeadlockApiService;
  readonly #cache: ApiCacheRepository;
  readonly #accountSource: AccountSource;
  readonly #logger: Logger;
  readonly #now: () => number;
  /**
   * The keys of the entries already reported as unreadable. An entry that cannot be read stays so
   * until it is replaced, and the review reads it at every page: it is reported once, not at every
   * read. A key leaves the set when its entry is written again.
   */
  readonly #reportedKeys = new Set<string>();
  /**
   * The refreshes that are running, by cache key of their rank. A call for a rank that is being
   * refreshed gets the running promise, and the run leaves the map when it is over, however it ends.
   */
  readonly #refreshing = new Map<string, Promise<CohortRefresh>>();

  /**
   * @param dependencies - See {@link ItemBenchmarkServiceDependencies}.
   */
  constructor(dependencies: ItemBenchmarkServiceDependencies) {
    this.#api = dependencies.api;
    this.#cache = dependencies.cache;
    this.#accountSource = dependencies.accountSource;
    this.#logger = dependencies.logger;
    this.#now = dependencies.now ?? Date.now;
  }

  /**
   * Read the item statistics of a rank from the cache, whatever their age. Nothing is downloaded.
   *
   * @param rank - The rank the player is compared with.
   * @param itemIds - The items the review looks at. An id that is not a positive whole number is
   *   ignored: the entry holds nothing for it, so it is not required of the entry.
   * @returns The data, with whether it is stale; or `missing` when nothing is cached, when the
   *   entry lacks one of the items, or when it cannot be read (it is reported once, with the path
   *   and the code of its first problem and no value).
   * @throws AppError of kind `storage` when the database fails.
   */
  async read(rank: CohortRank, itemIds: readonly number[]): Promise<ItemBenchmarkRead> {
    const data = await this.#readEntry(rank, storableItemIds(itemIds));
    return data === null
      ? { kind: 'missing' }
      : { kind: 'cached', data, stale: isStale(data.fetchedAt, this.#now()) };
  }

  /**
   * Download the item statistics of a rank and store them, unless the cached ones are still fresh.
   *
   * - An entry less than a day old (and not dated in the future) that holds every asked item is
   *   fresh: nothing is requested.
   * - Otherwise the rank is sized, falls back to every rank when it is a small tier, and the item
   *   statistics of the cohort used are downloaded, over the period of the community data and every
   *   length of match (see the header of the module). Only the asked items are stored.
   * - Nothing is stored when the linked account is no longer `accountId` once the data is downloaded.
   * - When deadlock-api is paused or the budget is spent (both expected, and the cached data stays),
   *   a `debug` line tells which. When anything else fails (a request, the validation of an answer,
   *   the cache, the read of the account), the cached data stays and a `warn` line tells the kind of
   *   the problem.
   * - One refresh runs at a time for a rank: a call made while another one is running for the same
   *   rank gets the answer of that run, whichever account asks and whichever items (the check of
   *   the account is made once, inside the run).
   *
   * @param accountId - The account that asks.
   * @param rank - The rank the player is compared with.
   * @param itemIds - The items the review looks at. An id that is not a positive whole number is
   *   ignored: it is not stored, and it is not required of a cached entry.
   * @returns A promise that never rejects: `fresh`, `updated`, or `unavailable`.
   */
  refresh(
    accountId: AccountId,
    rank: CohortRank,
    itemIds: readonly number[],
  ): Promise<CohortRefresh> {
    const key = cacheKey(rank);
    const running = this.#refreshing.get(key);
    if (running !== undefined) {
      return running;
    }
    // The run is registered in the very turn it starts in, so that no call can slip in between.
    const run = this.#runRefresh(accountId, rank, storableItemIds(itemIds)).finally(() => {
      this.#refreshing.delete(key);
    });
    this.#refreshing.set(key, run);
    return run;
  }

  /**
   * Run a refresh, and turn whatever fails into `unavailable`, with a line in the log.
   *
   * @param accountId - The account that asks.
   * @param rank - The rank the player is compared with.
   * @param itemIds - The items the review looks at.
   * @returns A promise that never rejects.
   */
  async #runRefresh(
    accountId: AccountId,
    rank: CohortRank,
    itemIds: readonly number[],
  ): Promise<CohortRefresh> {
    try {
      return await this.#refresh(accountId, rank, itemIds);
    } catch (error) {
      this.#logger.log(
        'warn',
        COMMUNITY_LOG_SCOPE,
        UNAVAILABLE,
        unavailableContext(toAppError(error)),
      );
      return 'unavailable';
    }
  }

  /**
   * Do the refresh, and let anything that fails reach `#runRefresh`.
   *
   * @param accountId - The account that asks.
   * @param rank - The rank the player is compared with.
   * @param itemIds - The items the review looks at.
   * @returns The outcome, unless something throws.
   * @throws AppError when the cache or the linked account cannot be read or written, or when
   *   deadlock-api cannot be reached or answers an error or something invalid.
   */
  async #refresh(
    accountId: AccountId,
    rank: CohortRank,
    itemIds: readonly number[],
  ): Promise<CohortRefresh> {
    const now = this.#now();
    const cached = await this.#readEntry(rank, itemIds);
    if (cached !== null && !isStale(cached.fetchedAt, now)) {
      return 'fresh';
    }
    const download = await this.#download(rank, itemIds, communityPeriodStartS(now));
    if (download.kind !== 'fetched') {
      // deadlock-api is paused or the budget of the minute is spent: expected, and tried again
      // later, so it is not a warning (the rank service does the same).
      this.#logger.log('debug', COMMUNITY_LOG_SCOPE, UNAVAILABLE, { kind: download.kind });
      return 'unavailable';
    }
    // The downloads took time: the account may have been unlinked or switched meanwhile, and the
    // erasure of its data must not be followed by a write.
    if ((await this.#accountSource.currentAccountId()) !== accountId) {
      this.#logger.log(
        'debug',
        COMMUNITY_LOG_SCOPE,
        'Item statistics not stored, the account changed',
      );
      return 'unavailable';
    }
    const key = cacheKey(rank);
    await this.#cache.put(key, {
      payloadJson: encodeData(download.value),
      fetchedAt: now,
      expiresAt: now + COHORT_MAX_AGE_MS,
    });
    this.#reportedKeys.delete(key);
    this.#logDownload(download.value);
    return 'updated';
  }

  /**
   * Read and check the cached item statistics of a rank.
   *
   * @param rank - The rank.
   * @param itemIds - The items the caller needs.
   * @returns The data, or `null` when nothing is cached, when the entry cannot be read, or when it
   *   holds a cohort but lacks one of the items.
   * @throws AppError of kind `storage` when the database fails.
   */
  async #readEntry(
    rank: CohortRank,
    itemIds: readonly number[],
  ): Promise<ItemBenchmarkData | null> {
    const key = cacheKey(rank);
    const entry = await this.#cache.get(key);
    if (entry === null) {
      return null;
    }
    const decoded = decodeData(entry.payloadJson, rank);
    if (decoded.kind === 'unreadable') {
      if (!this.#reportedKeys.has(key)) {
        this.#reportedKeys.add(key);
        this.#logger.log('warn', COMMUNITY_LOG_SCOPE, 'Cached item statistics are unreadable', {
          issue: decoded.issue,
        });
      }
      return null;
    }
    const { data } = decoded;
    // An entry without a cohort holds no item by nature; any other lacks the items it was not
    // downloaded for, which is no damage: the next download will hold them.
    if (data.used !== null && !itemIds.every((itemId) => data.items.has(itemId))) {
      return null;
    }
    return { ...data, fetchedAt: entry.fetchedAt };
  }

  /**
   * Download the item statistics of a rank: the size of the cohort, then its purchases by minute.
   *
   * The requests are sent one after the other, so that a pause asked for by an answer stops the
   * next one.
   *
   * @param rank - The rank the player is compared with.
   * @param itemIds - The items to keep.
   * @param sinceUnixS - The start of the period (Unix s).
   * @returns The data, or why a request was not sent (a pause, or the budget).
   * @throws AppError when a request fails or its answer is invalid.
   */
  async #download(
    rank: CohortRank,
    itemIds: readonly number[],
    sinceUnixS: number,
  ): Promise<AnalyticsFetch<DownloadedData>> {
    const wanted: Cohort = { rank, window: ANY_LENGTH_WINDOW };
    const choice = await chooseCohort(this.#api, wanted, sinceUnixS);
    if (choice.kind !== 'fetched') {
      return choice;
    }
    const { used, sampleMatches } = choice.value;
    if (used === null) {
      return {
        kind: 'fetched',
        value: { wanted: rank, used: null, sampleMatches, items: new Map() },
      };
    }
    const stats = await this.#api.fetchItemStats(cohortQuery(used, sinceUnixS));
    if (stats.kind !== 'fetched') {
      return stats;
    }
    return {
      kind: 'fetched',
      value: {
        wanted: rank,
        used: used.rank,
        sampleMatches,
        items: keepAskedItems(stats.value, itemIds),
      },
    };
  }

  /**
   * Log what a download brought: counts and a flag, to tell afterwards whether the API still answers
   * what the app reads (a change of its answers would otherwise only show as missing comparisons).
   * A cohort in use that bought none of the items that were asked for is a warning.
   *
   * @param data - The data that was downloaded.
   */
  #logDownload(data: DownloadedData): void {
    const items = [...data.items.values()].filter((timing) => timing.purchases > 0).length;
    this.#logger.log('info', COMMUNITY_LOG_SCOPE, 'Item statistics downloaded', {
      items,
      sampleMatches: data.sampleMatches,
      fallback: data.used !== null && cohortRankKey(data.used) !== cohortRankKey(data.wanted),
    });
    if (data.used !== null && data.items.size > 0 && items === 0) {
      this.#logger.log('warn', COMMUNITY_LOG_SCOPE, 'Item statistics incomplete', {
        items,
        askedItems: data.items.size,
      });
    }
  }
}
