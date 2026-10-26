/**
 * Test helpers: the application services built on the development adapters, a projection of the
 * archived matches outside a synchronisation, and a TanStack Query client suited to tests.
 *
 * @packageDocumentation
 */
import type { QueryClient } from '@tanstack/react-query';
import { DevDiagnostics } from '../adapters/dev/dev-diagnostics.adapter';
import {
  createFixtureApi,
  FixtureHttpClient,
  type FixtureHandler,
} from '../adapters/dev/fixture-http-client.adapter';
import { FixtureSignInGateway } from '../adapters/dev/fixture-sign-in-gateway.adapter';
import { FIXTURE_ACCOUNT_ID } from '../adapters/dev/fixtures/match-history.fixture';
import { LocalStorageSettingsStore } from '../adapters/dev/local-storage-settings-store.adapter';
import { MemoryArchiveStore } from '../adapters/dev/memory-archive-store.adapter';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import type { AccountId } from '../core/domain/account';
import type { Compressor } from '../ports/compressor.port';
import type { Database } from '../ports/database.port';
import type { Logger } from '../ports/logger.port';
import type { SettingsStore } from '../ports/settings-store.port';
import type { AppServices } from '../services/app-services';
import { ArchiveReaderService } from '../services/archive-reader.service';
import { createAppServices } from '../services/create-app-services';
import { LinkedAccountRepository } from '../services/linked-account.repository';
import { MatchDetailRepository } from '../services/match-detail.repository';
import { MetricsRepository } from '../services/metrics.repository';
import { ProjectionService, type ProjectionReport } from '../services/projection.service';
import { createQueryClient } from '../ui/app/query-client';
import { DirectCompressor } from './direct-compressor';
import { SeededDatabase } from './seeded-database';
import { createTestDatabase, testLinkedAccount } from './test-data';

/** Options of {@link createTestServices}. */
export interface TestServicesOptions {
  /** Where the settings are saved; jsdom's `localStorage` by default. */
  readonly settingsStore?: SettingsStore;
  /** Answers the requests to deadlock-api; the synthetic fixtures by default. */
  readonly handler?: FixtureHandler;
  /**
   * The linked account; the account of the fixtures by default.
   *
   * With an account id, it is written to the database before the first statement (see
   * {@link createTestServices}), replacing the link the database already holds, if any. With `null`
   * nothing is written: a fresh database holds no link, and a database passed in keeps the link it
   * holds.
   */
  readonly accountId?: AccountId | null;
  /**
   * The database; a fresh in-memory one by default. Pass the database of an earlier call to simulate
   * a restart of the app, or one of your own to make the storage fail.
   *
   * The database holds one link only. Services built on the same database share it, and the last
   * one to run its first statement decides it, since its seed rewrites the link; use `accountId:
   * null` to build services that leave the link as it is.
   */
  readonly database?: Database;
  /**
   * The gateway of the Steam sign-in; a {@link FixtureSignInGateway} that answers by itself on the
   * clock of the services by default.
   */
  readonly signInGateway?: FixtureSignInGateway;
  /**
   * Where the archives of the match details are kept; a fresh in-memory store by default. Pass the
   * store of an earlier call to simulate a restart of the app, or a subclass of your own to make the
   * files fail (`failNextWrite` already does it for a write).
   */
  readonly archiveStore?: MemoryArchiveStore;
  /** Compresses the archives; a {@link DirectCompressor} (no worker under jsdom) by default. */
  readonly compressor?: Compressor;
  /**
   * The clock the services start from (Unix ms); `Date.now` by default. The services read it plus
   * the time they skipped instead of waiting (see {@link TestServices.skippedMs}), so a test that
   * fixes it sees the time only move forward when the services wait.
   */
  readonly now?: () => number;
}

/** Services for a test, plus direct access to the adapters to inspect what happened. */
export interface TestServices {
  readonly services: AppServices;
  readonly logger: MemoryLogger;
  readonly http: FixtureHttpClient;
  /**
   * The account the services were built for: {@link TestServicesOptions.accountId}, or the account
   * of the fixtures when none was given; `null` when the services were built with `accountId: null`,
   * which links nothing (the database passed in may hold a link of its own, which this does not
   * tell).
   */
  readonly accountId: AccountId | null;
  /**
   * The database the services use: the one given in the options, or the fresh one, wrapped in a
   * {@link SeededDatabase} that links the account first when there is one. Statements of a test
   * run through it too, so they see the link.
   */
  readonly database: Database;
  /** The sign-in gateway the services use: the one given in the options, or the fresh one. */
  readonly signInGateway: FixtureSignInGateway;
  /**
   * The archive store the services use: the one given in the options, or the fresh one. Its test
   * helpers (`failNextWrite`, `addTemporaryFile`) and its `files` are available.
   */
  readonly archiveStore: MemoryArchiveStore;
  /**
   * The compressor the services use: the one given in the options, or the fresh
   * {@link DirectCompressor}. A test that reads or writes the archives itself needs the very codec
   * the services wrote them with.
   */
  readonly compressor: Compressor;
  /**
   * The time, in milliseconds, the services skipped so far instead of waiting: it is what the
   * services' clock is ahead of `TestServicesOptions.now`. It grows when the detail queue waits
   * for a request slot (5 per second), so a first synchronisation of a hundred details is
   * ahead by about twenty seconds. A test that compares a time the services wrote with its own
   * clock adds it.
   */
  readonly skippedMs: () => number;
}

/**
 * Build the application services on the development adapters: Web Storage settings, synthetic
 * deadlock-api, in-memory database and archive store, memory logger, and the zstd codec on the test
 * thread. jsdom's `localStorage` is cleared after each test (see `setup.ts`) and each call gets a
 * fresh database and archive unless some are given, so every test starts from a first launch.
 *
 * The account the services synchronise comes from the database, like in the app: unless `accountId`
 * is `null`, the database is wrapped so that the account is linked before the first statement
 * runs (see {@link SeededDatabase}), with the profile fetched at the services' current time.
 *
 * The services run on a virtual clock: when the detail queue must wait for the rate limit of
 * deadlock-api (5 requests per second), the wait is skipped, not slept, and the clock the services
 * read moves forward by that time. The limit is honoured in the services' time, and a first
 * synchronisation of about a hundred details takes no more of the test's time than the work itself.
 *
 * @param options - See {@link TestServicesOptions}.
 * @returns The services and their adapters.
 */
export function createTestServices(options: TestServicesOptions = {}): TestServices {
  const baseNow = options.now ?? Date.now;
  let skipped = 0;
  // The clock of every service: the base clock, moved forward by the waits that were skipped.
  const now = (): number => baseNow() + skipped;
  /**
   * Skip a wait: the clock moves forward by the delay and the wait ends at once.
   *
   * @param ms - The delay the service asked for.
   * @returns A promise already resolved.
   */
  const sleep = (ms: number): Promise<void> => {
    skipped += ms;
    return Promise.resolve();
  };
  const logger = new MemoryLogger();
  const http = new FixtureHttpClient(options.handler ?? createFixtureApi({ now: now() }));
  const baseDatabase = options.database ?? createTestDatabase();
  const accountId = options.accountId === undefined ? FIXTURE_ACCOUNT_ID : options.accountId;
  // The services read the account from the database, like in the app, so the link has to be there
  // before their first statement. The seed runs on the first statement (after the migrations) and
  // keeps this function synchronous. Without an account the database is left as it is: an app
  // that was never linked, or whose database the test wants to break.
  const database =
    accountId === null
      ? baseDatabase
      : new SeededDatabase(baseDatabase, (seeded) =>
          new LinkedAccountRepository(seeded, logger).setLinkedAccount(
            testLinkedAccount(accountId, { profileFetchedAt: now() }),
          ),
        );
  const archiveStore = options.archiveStore ?? new MemoryArchiveStore();
  const compressor = options.compressor ?? new DirectCompressor();
  const signInGateway = options.signInGateway ?? new FixtureSignInGateway({ now });
  const services = createAppServices(
    {
      logger,
      settingsStore: options.settingsStore ?? new LocalStorageSettingsStore(localStorage),
      http,
      database,
      signInGateway,
      archiveStore,
      compressor,
      diagnostics: new DevDiagnostics(),
    },
    { appVersion: '0.0.0-test', now, sleep },
  );
  return {
    services,
    logger,
    http,
    accountId,
    database,
    signInGateway,
    archiveStore,
    compressor,
    skippedMs: () => skipped,
  };
}

/** Options of {@link projectArchivedMatches}. */
export interface ProjectArchivedMatchesOptions {
  /**
   * The account whose matches are projected; the account the services were built for by default
   * ({@link TestServices.accountId}).
   */
  readonly accountId?: AccountId;
  /** The clock the projections are dated with (Unix ms); `Date.now` by default. */
  readonly now?: () => number;
}

/**
 * Project every archived match of a test's account that has no projection of the current version,
 * most recent first, so that each of them can be analysed at once. Every archived match is analysed
 * after each synchronisation already (a page analyses a match still missing as a fallback), so a
 * synchronisation leaves nothing for this to do. It is for the tests that need projections a
 * synchronisation did not make: matches the test archived itself, or whose projections it deleted
 * (they are then projected again, dated with the test's own clock). It builds one
 * {@link ProjectionService} on the adapters of the test, with the very compressor, archive store and
 * database the services use, and runs its catch-up. That instance does not wait for the projections
 * of the services, so call it while no synchronisation and no analysis is running.
 *
 * @param test - The services of the test, see {@link createTestServices}.
 * @param options - See {@link ProjectArchivedMatchesOptions}.
 * @returns How the run went; the projection itself never rejects, see
 *   {@link ProjectionService.catchUp}.
 * @throws Error when no account is given and the services were built without one (a mistake in the
 *   test).
 */
export async function projectArchivedMatches(
  test: TestServices,
  options: ProjectArchivedMatchesOptions = {},
): Promise<ProjectionReport> {
  const accountId = options.accountId ?? test.accountId;
  if (accountId === null) {
    throw new Error('projectArchivedMatches needs an account: the services were built without one');
  }
  const projection = new ProjectionService({
    reader: new ArchiveReaderService({
      archive: test.archiveStore,
      compressor: test.compressor,
      logger: test.logger,
    }),
    metrics: new MetricsRepository(test.database),
    details: new MatchDetailRepository(test.database),
    logger: test.logger,
    now: options.now ?? Date.now,
  });
  return projection.catchUp(accountId, 'run-0001');
}

/**
 * Create the TanStack Query client of the application, except that it never retries, so a failing
 * query fails immediately. It has the same defaults and logs failures like the one of the app, so
 * the tests exercise the real configuration.
 *
 * @param logger - Where failed queries and mutations are logged; a fresh memory logger by default.
 * @returns A fresh query client.
 */
export function createTestQueryClient(logger: Logger = new MemoryLogger()): QueryClient {
  const queryClient = createQueryClient({ logger });
  // `setDefaultOptions` replaces all the defaults: merge them with the existing ones to only
  // switch the retries off.
  const defaults = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    queries: { ...defaults.queries, retry: false },
    mutations: { ...defaults.mutations, retry: false },
  });
  return queryClient;
}
