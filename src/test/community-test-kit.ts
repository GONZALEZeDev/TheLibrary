/**
 * What the tests of the services that keep community data have in common (the cohorts of the match
 * analysis, the item statistics of the review): the service environment they run in, handlers that
 * change the answer of one endpoint of the fixture API, and readers of the requests that were sent
 * and of the lines that were logged.
 *
 * The community answers of the fixture API do not depend on the clock or on the history, so the
 * handlers built here fall back on a fixture API of their own unless a test gives its base.
 *
 * @packageDocumentation
 */
import {
  createFixtureApi,
  FixtureHttpClient,
  jsonResponse,
  type FixtureHandler,
} from '../adapters/dev/fixture-http-client.adapter';
import { MemoryLogger, type LogEntry } from '../adapters/dev/memory-logger.adapter';
import type { AccountId } from '../core/domain/account';
import { PAIGE_HERO_ID } from '../core/domain/hero';
import { AppError } from '../core/errors/app-error';
import type { AccountSource } from '../ports/account-source.port';
import type { Database } from '../ports/database.port';
import { ApiCacheRepository } from '../services/api-cache.repository';
import { COMMUNITY_LOG_SCOPE } from '../services/benchmark.service';
import { DeadlockApiService } from '../services/deadlock-api.service';
import { SyncStateRepository } from '../services/sync-state.repository';
import { createTestDatabase } from './test-data';

/** The path of the requests for the size of a cohort (the statistics of every hero). */
export const HERO_STATS_PATH = '/v1/analytics/hero-stats';

/** The time the fixture API of the handlers built here is made at: nothing community reads it. */
const BASE_FIXTURE_NOW = Date.UTC(2026, 9, 20, 15, 30, 0);

/**
 * The fixture API the handlers built here fall back on.
 *
 * @returns A fresh fixture API with a history of one match, which no community request reads.
 */
function communityFixtureApi(): FixtureHandler {
  return createFixtureApi({ now: BASE_FIXTURE_NOW, matchCount: 1 });
}

/**
 * A database whose statements fail when `fails` says so, as a locked file would.
 *
 * @param database - The database to wrap.
 * @param fails - Tells from the SQL of a statement whether it fails.
 * @returns The database.
 */
function failingWhen(database: Database, fails: (sql: string) => boolean): Database {
  const fail = (): Promise<never> => Promise.reject(new Error('database is locked'));
  return {
    execute: (sql, params) => (fails(sql) ? fail() : database.execute(sql, params)),
    select: (sql, params) => (fails(sql) ? fail() : database.select(sql, params)),
  };
}

/** What {@link setUpCommunity} accepts. */
export interface CommunityOptions {
  /** Answers the requests of deadlock-api; the fixture API by default. */
  readonly handler?: FixtureHandler;
  /** Makes the statements of the cache that match fail (the synchronisation state is not touched). */
  readonly cacheFails?: (sql: string) => boolean;
}

/** The environment a service of the community data runs in. */
export interface CommunityEnvironment {
  /** The deadlock-api service under the service tested, with the budgets and the pause. */
  readonly api: DeadlockApiService;
  /** The cache the service keeps its entries in (failing when the options say so). */
  readonly cache: ApiCacheRepository;
  /** The HTTP client, which records every request that was sent. */
  readonly http: FixtureHttpClient;
  /** The logger: the lines of the tested service and of the deadlock-api service. */
  readonly logger: MemoryLogger;
  /** The clock: set `now` to move time. */
  readonly clock: { now: number };
  /** The reading of the clock, for the services that take one. */
  readonly now: () => number;
  /** The answers of deadlock-api: set `handler` to change them. */
  readonly answer: { handler: FixtureHandler };
  /** The synchronisation state, where the pause of deadlock-api is kept. */
  readonly syncState: SyncStateRepository;
  /** The account source of the services: it follows `link`. */
  readonly accountSource: AccountSource;
  /** The linked account: set `accountId` to change it, or `failure` to make it unreadable. */
  readonly link: { accountId: AccountId | null; failure: AppError | null };
}

/**
 * Build the environment of a service of the community data, with a controllable clock, handler and
 * linked account. The account is linked unless a test unlinks it.
 *
 * @param start - The time the clock starts at (Unix ms).
 * @param linkedAccountId - The account that is linked at first.
 * @param options - See {@link CommunityOptions}.
 * @returns The environment: build the service from its parts.
 */
export function setUpCommunity(
  start: number,
  linkedAccountId: AccountId,
  options: CommunityOptions = {},
): CommunityEnvironment {
  const clock = { now: start };
  const now = (): number => clock.now;
  const answer: { handler: FixtureHandler } = {
    handler: options.handler ?? createFixtureApi({ now: start, matchCount: 1 }),
  };
  const link: { accountId: AccountId | null; failure: AppError | null } = {
    accountId: linkedAccountId,
    failure: null,
  };
  const accountSource: AccountSource = {
    currentAccountId: () =>
      link.failure === null ? Promise.resolve(link.accountId) : Promise.reject(link.failure),
  };
  const http = new FixtureHttpClient((request) => answer.handler(request));
  const logger = new MemoryLogger();
  const database = createTestDatabase();
  const syncState = new SyncStateRepository(database, logger, now);
  const api = new DeadlockApiService(http, syncState, logger, { appVersion: '0.1.0', now });
  const cacheFails = options.cacheFails;
  const cache = new ApiCacheRepository(
    cacheFails === undefined ? database : failingWhen(database, cacheFails),
  );
  return { api, cache, http, logger, clock, now, answer, syncState, accountSource, link };
}

/**
 * Build a handler that answers the requests for one path with its own answer, and the other
 * requests like the fixture API.
 *
 * @param path - The path of the requests to answer.
 * @param answer - Answers them, or throws.
 * @param base - Answers the other requests; a fixture API of the community by default.
 * @returns The handler.
 */
export function overriding(
  path: string,
  answer: FixtureHandler,
  base: FixtureHandler = communityFixtureApi(),
): FixtureHandler {
  return (request) => (new URL(request.url).pathname === path ? answer(request) : base(request));
}

/** How many matches of Paige the hero statistics hold, by kind of cohort. */
export interface SampleSizes {
  /** The matches of a tier cohort: the requests with a badge range. */
  readonly tier: number;
  /** The matches of an all-ranks cohort: the requests without a badge range. */
  readonly all: number;
}

/**
 * Build a handler that answers the hero statistics with a given number of matches of Paige: one
 * number for the requests with a badge range (a tier), another for the ones without (every rank).
 * The other requests are answered like the fixture API.
 *
 * @param sizes - The number of matches of a tier cohort, and of an all-ranks cohort.
 * @param base - Answers the other requests; a fixture API of the community by default.
 * @returns The handler.
 */
export function withSampleSizes(sizes: SampleSizes, base?: FixtureHandler): FixtureHandler {
  return overriding(
    HERO_STATS_PATH,
    (request) => {
      const ranked = new URL(request.url).searchParams.has('min_average_badge');
      return jsonResponse([{ hero_id: PAIGE_HERO_ID, matches: ranked ? sizes.tier : sizes.all }]);
    },
    base,
  );
}

/**
 * Build a handler for which the request to the given path fails like a network that dropped.
 *
 * @param path - The path of the requests that fail.
 * @param base - Answers the other requests; a fixture API of the community by default.
 * @returns The handler.
 */
export function failingAt(path: string, base?: FixtureHandler): FixtureHandler {
  return overriding(
    path,
    () => {
      throw new AppError('network', 'The request failed');
    },
    base,
  );
}

/**
 * The paths of the requests received, in order.
 *
 * @param http - The HTTP client.
 * @returns The path of each request, without its query.
 */
export function requestedPaths(http: FixtureHttpClient): string[] {
  return http.requests.map((request) => new URL(request.url).pathname);
}

/**
 * The query of a request, as an object.
 *
 * @param url - The URL of the request.
 * @returns The parameters by name.
 */
export function queryOf(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams);
}

/**
 * The lines the community services wrote; the deadlock-api service writes its own lines in the same
 * logger, under another scope.
 *
 * @param logger - The logger of the environment.
 * @returns The lines of the scope of the community data, oldest first.
 */
export function communityLines(logger: MemoryLogger): readonly LogEntry[] {
  return logger.entries.filter((entry) => entry.scope === COMMUNITY_LOG_SCOPE);
}
