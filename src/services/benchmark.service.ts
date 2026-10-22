/**
 * The community data of the match analysis: how the Paige players of a rank tier did in matches of
 * about the same length over the last 30 days (the percentiles of the metrics, the average course of
 * a match, deaths included, and how many matches that is), kept for a day.
 *
 * A match is compared with a {@link Cohort}. Its data is downloaded when a page of the analysis
 * opens ({@link BenchmarkService.refresh}), kept in the database (`api_cache`, as JSON), and read back
 * by the analysis ({@link BenchmarkService.read}) even when it is stale or when the app is offline.
 * The download costs three requests, or four when a small tier falls back to every rank, within the
 * budget of `DeadlockApiService`:
 * - the size of the cohort, i.e. how many matches of the hero it holds. A tier that holds fewer than
 *   {@link MIN_COHORT_MATCHES} is too small to mean anything, so the match is compared with every
 *   rank of the same duration window instead (a fallback, which costs a second request for its
 *   size); when that is too small as well, there is nothing to compare with and the entry says so
 *   (`used: null`) without any further request;
 * - the benchmark and the performance curve of the cohort that is used.
 *
 * The choice of the cohort ({@link chooseCohort}), the request of a cohort ({@link cohortQuery}), the
 * age at which an entry is stale ({@link isStale}) and the schema of a rank ({@link cohortRankSchema})
 * are shared with the item statistics of the review, which keeps its own entries the same way.
 *
 * The data belongs to no player, but it is only stored while the account that asked for it is the
 * linked one: a download that ends after the account was unlinked or switched is thrown away, so that
 * nothing is written once the data of an account was erased.
 *
 * Community data only ever makes the analysis richer, so {@link BenchmarkService.refresh} never
 * fails: whatever cannot be downloaded leaves the entry as it was and is answered `unavailable`. A
 * cohort is refreshed by one run at a time: a call that comes while another is running for the same
 * cohort shares its answer instead of downloading the data twice.
 *
 * The lines written here hold: the kind of an error and, when it has one, the template of its
 * endpoint; counts and a boolean (what a download brought); the path and code of the first problem
 * of an unreadable entry (`issue`); and, for a purge that failed, the log context of its error
 * (`errorLogContext`: kind, cause and stack). None carries an account id or a value of the data.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { badgeBounds, cohortKey, type Cohort } from '../core/analysis/cohort';
import { MIN_COHORT_MATCHES } from '../core/analysis/insights/thresholds';
import { PERCENTILE_POINTS } from '../core/analysis/statistics';
import type { CohortQuery } from '../core/deadlock-api/endpoints';
import { BENCHMARK_KEYS, type MetricBenchmark } from '../core/deadlock-api/metric-benchmark.schema';
import type { CurvePoint } from '../core/deadlock-api/performance-curve.schema';
import type { AccountId } from '../core/domain/account';
import { PAIGE_HERO_ID } from '../core/domain/hero';
import { RANK_TIER_NAMES } from '../core/domain/rank';
import { errorLogContext, toAppError, type AppError } from '../core/errors/app-error';
import { describeFirstIssue } from '../core/errors/first-issue';
import type { AccountSource } from '../ports/account-source.port';
import type { LogContext, Logger } from '../ports/logger.port';
import type { ApiCacheRepository } from './api-cache.repository';
import type { AnalyticsFetch, DeadlockApiService } from './deadlock-api.service';

/** How long the community data of a cohort is kept before it is downloaded again: a day, in ms. */
export const COHORT_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * How long an entry of the analytics is kept in the database, from its download: a week, in ms.
 * Entries are replaced when a cohort is refreshed, but a cohort that is never asked for again (a
 * window of a match long gone) would otherwise stay for good.
 */
export const ANALYTICS_PURGE_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * The start of the cache keys of every entry of the analytics: what the purge deletes from. The
 * entries of the other services of the community data (the item statistics) are kept under it, so
 * that the same purge covers them.
 */
export const ANALYTICS_KEY_PREFIX = 'analytics.';

/**
 * The start of the cache keys of the community data of a cohort.
 *
 * The version is part of it: the entries stored before the curve held the deaths sit under the
 * prefix without a version, which is never read again, so that no stored entry has to be told apart
 * by its content. They are deleted by the purge once a week old, like any entry of the analytics.
 */
const COHORT_KEY_PREFIX = `${ANALYTICS_KEY_PREFIX}cohort.v2.`;

/** The period the community is made of: the matches played in the last 30 days. */
const COMMUNITY_PERIOD_DAYS = 30;

/** Milliseconds in a day. */
const MS_PER_DAY = 86_400_000;

/** Seconds in a day. */
const SECONDS_PER_DAY = 86_400;

/** Scope of the log lines of the community data: this service's, and the item statistics'. */
export const COMMUNITY_LOG_SCOPE = 'community';

/** The message of the line about a cohort that could not be fetched. */
const UNAVAILABLE = 'Community data unavailable';

/**
 * The community data of a cohort, as the analysis reads it.
 *
 * Stored as JSON: the map of the benchmark becomes a list of entries, and the time of the download
 * is the one of the cache entry.
 */
export interface CohortData {
  /** The cohort that was asked for: the rank the match is compared with, and its duration window. */
  readonly wanted: Cohort;
  /**
   * The cohort the data is of: `wanted`, or every rank of the same window when `wanted` is a tier
   * too small to compare with (a fallback). `null` when even that is too small: there is then
   * nothing to compare the match with, and the benchmark and the curve are empty.
   */
  readonly used: Cohort | null;
  /**
   * How many matches of the hero the cohort used holds. When `used` is `null`, the size of the last
   * cohort that was tried (every rank for a tier, the cohort itself for every rank).
   */
  readonly sampleMatches: number;
  /** The percentiles of each metric the community could give; empty when `used` is `null`. */
  readonly benchmark: MetricBenchmark;
  /** The average course of a match in the cohort, by time; empty when `used` is `null`. */
  readonly curve: readonly CurvePoint[];
  /** When the data was downloaded (Unix ms). */
  readonly fetchedAt: number;
}

/** What {@link BenchmarkService.read} found. */
export type CohortRead =
  /** The data of the cohort, `stale` when it is a day old or more (or dated in the future). */
  | { readonly kind: 'cached'; readonly data: CohortData; readonly stale: boolean }
  /** Nothing is cached for the cohort, or what is cached cannot be read. */
  | { readonly kind: 'missing' };

/**
 * What {@link BenchmarkService.refresh} did: `fresh` when the cached data is less than a day old,
 * `updated` when new data was downloaded and stored, `unavailable` when it could not be (the
 * cached data, if any, stays as it was).
 */
export type CohortRefresh = 'fresh' | 'updated' | 'unavailable';

/** What {@link BenchmarkService} needs. */
export interface BenchmarkServiceDependencies {
  /** Downloads the community data, within the budgets of deadlock-api. */
  readonly api: DeadlockApiService;
  /** Where the community data is kept. */
  readonly cache: ApiCacheRepository;
  /** The linked account: data downloaded for an account that is no longer linked is not stored. */
  readonly accountSource: AccountSource;
  /** Structured logger. */
  readonly logger: Logger;
  /** Current time (Unix ms); `Date.now` by default. */
  readonly now?: () => number;
}

/** Schema of the name of a benchmark: one the app knows (the very list the parser reads). */
const benchmarkKeySchema = z.enum(BENCHMARK_KEYS);

/** Schema of a table of percentiles: one number per percentile point, never fewer. */
const percentileTableSchema = z.array(z.number()).length(PERCENTILE_POINTS.length);

/** Schema of the rank of a cohort. The tier is one of the tiers the app knows. */
export const cohortRankSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tier'),
    tier: z
      .int()
      .min(0)
      .max(RANK_TIER_NAMES.length - 1),
  }),
  z.object({ kind: z.literal('all') }),
]);

/** Schema of a cohort: a rank and a duration window. */
const cohortSchema = z.object({
  rank: cohortRankSchema,
  window: z.object({ minS: z.int().nonnegative(), maxS: z.int().nonnegative() }),
});

/**
 * Schema of the five counters of a point of the curve: a measure of each.
 *
 * @param measure - The schema of one value.
 * @returns The schema of the five values.
 */
function curveCounters(measure: z.ZodNumber) {
  return z.object({
    net_worth: measure,
    player_damage: measure,
    boss_damage: measure,
    kills: measure,
    deaths: measure,
  });
}

/** Schema of a point of the curve. `z.number()` refuses `NaN` and the infinite values. */
const curvePointSchema = z.object({
  timeS: z.int().nonnegative(),
  avg: curveCounters(z.number()),
  std: curveCounters(z.number().nonnegative()),
});

/** Schema of the JSON that is stored: the data of a cohort, without the time of its download. */
const storedDataSchema = z.object({
  wanted: cohortSchema,
  used: cohortSchema.nullable(),
  sampleMatches: z.int().nonnegative(),
  benchmark: z.array(z.tuple([benchmarkKeySchema, percentileTableSchema])),
  curve: z.array(curvePointSchema),
});

/** The data of a cohort once downloaded, before it is stored: everything but the time. */
type DownloadedData = Omit<CohortData, 'fetchedAt'>;

/** What reading the JSON of an entry gave: the data, or the first problem as `<path>: <code>`. */
type DecodedData =
  | { readonly kind: 'decoded'; readonly data: DownloadedData }
  | { readonly kind: 'unreadable'; readonly issue: string };

/**
 * The cache key of the community data of a cohort.
 *
 * @param cohort - The cohort.
 * @returns The key.
 */
function cacheKey(cohort: Cohort): string {
  return `${COHORT_KEY_PREFIX}${cohortKey(cohort)}`;
}

/**
 * Write the data of a cohort as the JSON that is stored.
 *
 * @param data - The data, without the time of its download.
 * @returns The JSON: the map of the benchmark as a list of entries.
 */
function encodeData(data: DownloadedData): string {
  return JSON.stringify({ ...data, benchmark: [...data.benchmark] });
}

/**
 * Read the JSON of an entry back, checking all of it.
 *
 * @param payloadJson - The JSON that was stored.
 * @returns The data, or `unreadable` with the path and the code of the first problem (never a value
 *   of the JSON).
 */
function decodeData(payloadJson: string): DecodedData {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { kind: 'unreadable', issue: 'not_json' };
  }
  const stored = storedDataSchema.safeParse(payload);
  return stored.success
    ? { kind: 'decoded', data: { ...stored.data, benchmark: new Map(stored.data.benchmark) } }
    : { kind: 'unreadable', issue: describeFirstIssue(stored.error) };
}

/**
 * Tell whether community data is too old to be trusted without a new download.
 *
 * Data dated in the future is: the clock moved backwards since, so its age cannot be told, and it
 * would otherwise stay fresh until the clock caught up.
 *
 * @param fetchedAt - When the data was downloaded (Unix ms).
 * @param now - The current time (Unix ms).
 * @returns `true` when the data is a day old or more (a day exactly is old), or dated in the future.
 */
export function isStale(fetchedAt: number, now: number): boolean {
  const age = now - fetchedAt;
  return age < 0 || age >= COHORT_MAX_AGE_MS;
}

/**
 * The start of the period the community is made of: 30 days before today's UTC midnight.
 *
 * deadlock-api rounds the date down to the hour, and a UTC midnight keeps the requests of a day the
 * same, so that the answers can be reused until the next day. Every community request of the app
 * asks for this period, so that they all describe the same matches.
 *
 * @param now - The current time (Unix ms).
 * @returns The start of the period (Unix s).
 */
export function communityPeriodStartS(now: number): number {
  return (Math.floor(now / MS_PER_DAY) - COMMUNITY_PERIOD_DAYS) * SECONDS_PER_DAY;
}

/**
 * The community request of a cohort. It holds the hero, the period, the duration window and the
 * badge range of the tier, nothing else.
 *
 * @param cohort - The cohort.
 * @param sinceUnixS - The start of the period (Unix s).
 * @returns The query.
 */
export function cohortQuery(cohort: Cohort, sinceUnixS: number): CohortQuery {
  return {
    heroId: PAIGE_HERO_ID,
    sinceUnixS,
    minDurationS: cohort.window.minS,
    maxDurationS: cohort.window.maxS,
    badge: cohort.rank.kind === 'tier' ? badgeBounds(cohort.rank.tier) : null,
  };
}

/** Which cohort a download is made of, once the sizes of the cohorts are known. */
export interface CohortChoice {
  /**
   * The cohort the data is of: the wanted one, or every rank of the same window when the wanted
   * one is a tier too small to compare with. `null` when even that is too small.
   */
  readonly used: Cohort | null;
  /**
   * How many matches of the hero the cohort used holds. When `used` is `null`, the size of the
   * last cohort that was tried (every rank for a tier, the cohort itself for every rank).
   */
  readonly sampleMatches: number;
}

/**
 * Decide which cohort the community data is downloaded for, by the size of the cohorts: the wanted
 * one if it holds {@link MIN_COHORT_MATCHES} matches, else (for a tier) every rank of the same window
 * if that does, else none. The sizes are requested one after the other, so that a pause asked for by
 * an answer stops the next request.
 *
 * @param api - Downloads the sizes, within the budgets of deadlock-api.
 * @param wanted - The cohort the data is wanted for.
 * @param sinceUnixS - The start of the period (Unix s).
 * @returns The cohort used (`null` for none) and its size (the size of the last cohort tried when
 *   there is none), or why a request was not sent.
 * @throws AppError when a request fails or its answer is invalid.
 */
export async function chooseCohort(
  api: DeadlockApiService,
  wanted: Cohort,
  sinceUnixS: number,
): Promise<AnalyticsFetch<CohortChoice>> {
  const wantedSize = await api.fetchHeroSample(cohortQuery(wanted, sinceUnixS));
  if (wantedSize.kind !== 'fetched') {
    return wantedSize;
  }
  if (wantedSize.value >= MIN_COHORT_MATCHES) {
    return { kind: 'fetched', value: { used: wanted, sampleMatches: wantedSize.value } };
  }
  if (wanted.rank.kind === 'all') {
    // There is no wider cohort to fall back to.
    return { kind: 'fetched', value: { used: null, sampleMatches: wantedSize.value } };
  }
  const allRanks: Cohort = { rank: { kind: 'all' }, window: wanted.window };
  const allRanksSize = await api.fetchHeroSample(cohortQuery(allRanks, sinceUnixS));
  if (allRanksSize.kind !== 'fetched') {
    return allRanksSize;
  }
  return {
    kind: 'fetched',
    value: {
      used: allRanksSize.value >= MIN_COHORT_MATCHES ? allRanks : null,
      sampleMatches: allRanksSize.value,
    },
  };
}

/**
 * What to log about an error that stopped a download: its kind and, when it carries one, the
 * template of its endpoint. Not its message nor its cause, which an error of the network can fill
 * with the URL it failed on.
 *
 * @param error - The error.
 * @returns The context of the line.
 */
export function unavailableContext(error: AppError): LogContext {
  const { endpoint } = error.context;
  return typeof endpoint === 'string' ? { kind: error.kind, endpoint } : { kind: error.kind };
}

/** Keeps the community data of the cohorts the matches are compared with. */
export class BenchmarkService {
  readonly #api: DeadlockApiService;
  readonly #cache: ApiCacheRepository;
  readonly #accountSource: AccountSource;
  readonly #logger: Logger;
  readonly #now: () => number;
  /**
   * The keys of the entries already reported as unreadable. An entry that cannot be read stays so
   * until it is replaced, and the analysis reads it at every page: it is reported once, not at
   * every read. A key leaves the set when its entry is written again.
   */
  readonly #reportedKeys = new Set<string>();
  /**
   * The refreshes that are running, by cache key of their cohort. A call for a cohort that is being
   * refreshed gets the running promise, and the run leaves the map when it is over, however it ends.
   */
  readonly #refreshing = new Map<string, Promise<CohortRefresh>>();

  /**
   * @param dependencies - See {@link BenchmarkServiceDependencies}.
   */
  constructor(dependencies: BenchmarkServiceDependencies) {
    this.#api = dependencies.api;
    this.#cache = dependencies.cache;
    this.#accountSource = dependencies.accountSource;
    this.#logger = dependencies.logger;
    this.#now = dependencies.now ?? Date.now;
  }

  /**
   * Read the community data of a cohort from the cache, whatever its age. Nothing is downloaded.
   *
   * @param cohort - The cohort the match is compared with.
   * @returns The data, with whether it is stale; or `missing` when nothing is cached, or when the
   *   entry cannot be read (it is reported once, with the path and the code of its first problem and
   *   no value).
   * @throws AppError of kind `storage` when the database fails.
   */
  async read(cohort: Cohort): Promise<CohortRead> {
    const data = await this.#readEntry(cohort);
    return data === null
      ? { kind: 'missing' }
      : { kind: 'cached', data, stale: isStale(data.fetchedAt, this.#now()) };
  }

  /**
   * Download the community data of a cohort and store it, unless the cached data is still fresh.
   *
   * - Data less than a day old (and not dated in the future) is fresh: nothing is requested.
   * - Otherwise the cohort is sized, falls back to every rank when it is a small tier, and the
   *   benchmark and the curve of the cohort used are downloaded (see the header of the module). The
   *   data is stored, then the entries of the analytics older than a week are deleted: a purge that
   *   fails is logged and does not undo the update.
   * - Nothing is stored when the linked account is no longer `accountId` once the data is downloaded.
   * - When deadlock-api is paused or the budget is spent (both expected, and the cached data stays),
   *   a `debug` line tells which. When anything else fails (a request, the validation of an answer,
   *   the cache, the read of the account), the cached data stays and a `warn` line tells the kind of
   *   the problem.
   * - One refresh runs at a time for a cohort: a call made while another one is running for the
   *   same cohort gets the answer of that run, whichever account asks (the check of the account
   *   is made once, inside the run).
   *
   * @param accountId - The account that asks.
   * @param cohort - The cohort the match is compared with.
   * @returns A promise that never rejects: `fresh`, `updated`, or `unavailable`.
   */
  refresh(accountId: AccountId, cohort: Cohort): Promise<CohortRefresh> {
    const key = cacheKey(cohort);
    const running = this.#refreshing.get(key);
    if (running !== undefined) {
      return running;
    }
    // The run is registered in the very turn it starts in, so that no call can slip in between.
    const run = this.#runRefresh(accountId, cohort).finally(() => {
      this.#refreshing.delete(key);
    });
    this.#refreshing.set(key, run);
    return run;
  }

  /**
   * Run a refresh, and turn whatever fails into `unavailable`, with a line in the log.
   *
   * @param accountId - The account that asks.
   * @param cohort - The cohort the match is compared with.
   * @returns A promise that never rejects.
   */
  async #runRefresh(accountId: AccountId, cohort: Cohort): Promise<CohortRefresh> {
    try {
      return await this.#refresh(accountId, cohort);
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
   * @param wanted - The cohort the match is compared with.
   * @returns The outcome, unless something throws.
   * @throws AppError when the cache or the linked account cannot be read or written, or when
   *   deadlock-api cannot be reached or answers an error or something invalid.
   */
  async #refresh(accountId: AccountId, wanted: Cohort): Promise<CohortRefresh> {
    const now = this.#now();
    const cached = await this.#readEntry(wanted);
    if (cached !== null && !isStale(cached.fetchedAt, now)) {
      return 'fresh';
    }
    const download = await this.#download(wanted, communityPeriodStartS(now));
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
        'Community data not stored, the account changed',
      );
      return 'unavailable';
    }
    const key = cacheKey(wanted);
    await this.#cache.put(key, {
      payloadJson: encodeData(download.value),
      fetchedAt: now,
      expiresAt: now + COHORT_MAX_AGE_MS,
    });
    this.#reportedKeys.delete(key);
    this.#logDownload(download.value);
    await this.#purge(now);
    return 'updated';
  }

  /**
   * Read and check the cached data of a cohort.
   *
   * @param cohort - The cohort.
   * @returns The data, or `null` when nothing is cached or the entry cannot be read.
   * @throws AppError of kind `storage` when the database fails.
   */
  async #readEntry(cohort: Cohort): Promise<CohortData | null> {
    const key = cacheKey(cohort);
    const entry = await this.#cache.get(key);
    if (entry === null) {
      return null;
    }
    const decoded = decodeData(entry.payloadJson);
    if (decoded.kind === 'unreadable') {
      if (!this.#reportedKeys.has(key)) {
        this.#reportedKeys.add(key);
        this.#logger.log('warn', COMMUNITY_LOG_SCOPE, 'Cached community data is unreadable', {
          issue: decoded.issue,
        });
      }
      return null;
    }
    return { ...decoded.data, fetchedAt: entry.fetchedAt };
  }

  /**
   * Download the community data of a cohort: its size, then its benchmark and its curve.
   *
   * The requests are sent one after the other, so that a pause asked for by an answer stops the
   * next ones.
   *
   * @param wanted - The cohort the match is compared with.
   * @param sinceUnixS - The start of the period (Unix s).
   * @returns The data, or why a request was not sent (a pause, or the budget).
   * @throws AppError when a request fails or its answer is invalid.
   */
  async #download(wanted: Cohort, sinceUnixS: number): Promise<AnalyticsFetch<DownloadedData>> {
    const choice = await chooseCohort(this.#api, wanted, sinceUnixS);
    if (choice.kind !== 'fetched') {
      return choice;
    }
    const { used, sampleMatches } = choice.value;
    if (used === null) {
      return {
        kind: 'fetched',
        value: { wanted, used, sampleMatches, benchmark: new Map(), curve: [] },
      };
    }
    const query = cohortQuery(used, sinceUnixS);
    const benchmark = await this.#api.fetchMetricBenchmark(query);
    if (benchmark.kind !== 'fetched') {
      return benchmark;
    }
    const curve = await this.#api.fetchPerformanceCurve(query);
    if (curve.kind !== 'fetched') {
      return curve;
    }
    return {
      kind: 'fetched',
      value: { wanted, used, sampleMatches, benchmark: benchmark.value, curve: curve.value },
    };
  }

  /**
   * Log what a download brought: counts and a flag, to tell afterwards whether the API still answers
   * what the app reads (a change of its answers would otherwise only show as missing comparisons).
   * A cohort in use whose benchmark or curve is empty is a warning.
   *
   * @param data - The data that was downloaded.
   */
  #logDownload(data: DownloadedData): void {
    const benchmarkKeys = data.benchmark.size;
    const curvePoints = data.curve.length;
    this.#logger.log('info', COMMUNITY_LOG_SCOPE, 'Community data downloaded', {
      benchmarkKeys,
      curvePoints,
      sampleMatches: data.sampleMatches,
      fallback: data.used !== null && cohortKey(data.used) !== cohortKey(data.wanted),
    });
    if (data.used !== null && (benchmarkKeys === 0 || curvePoints === 0)) {
      this.#logger.log('warn', COMMUNITY_LOG_SCOPE, 'Community data incomplete', {
        benchmarkKeys,
        curvePoints,
      });
    }
  }

  /**
   * Delete the entries of the analytics that were downloaded more than a week ago. A failure is
   * logged: the data just stored is good, and the purge is tried again at the next update.
   *
   * @param now - The current time (Unix ms).
   */
  async #purge(now: number): Promise<void> {
    try {
      await this.#cache.deleteOlderThan(ANALYTICS_KEY_PREFIX, now - ANALYTICS_PURGE_AGE_MS);
    } catch (error) {
      this.#logger.log(
        'warn',
        COMMUNITY_LOG_SCOPE,
        'Could not purge the old community data',
        errorLogContext(toAppError(error)),
      );
    }
  }
}
