/**
 * Builds the application services from the adapters of an environment.
 *
 * This is the one place where services are wired together: the composition root (`src/main.tsx`)
 * calls it with the Tauri or the development adapters, and the tests with the development ones,
 * so both run exactly the same assembly.
 *
 * @packageDocumentation
 */
import type { ArchiveStore } from '../ports/archive-store.port';
import type { Compressor } from '../ports/compressor.port';
import type { Database } from '../ports/database.port';
import type { HttpClient } from '../ports/http-client.port';
import type { Logger } from '../ports/logger.port';
import type { SettingsStore } from '../ports/settings-store.port';
import type { SignInGateway } from '../ports/sign-in-gateway.port';
import { AccountDataService } from './account-data.service';
import { AccountService } from './account.service';
import { AnalysisService } from './analysis.service';
import { ApiCacheRepository } from './api-cache.repository';
import type { AppServices } from './app-services';
import { ArchiveReaderService } from './archive-reader.service';
import { BenchmarkService } from './benchmark.service';
import { DatabaseMaintenanceRepository } from './database-maintenance.repository';
import { DeadlockApiService } from './deadlock-api.service';
import { HeroCatalogService } from './hero-catalog.service';
import { LinkedAccountRepository } from './linked-account.repository';
import { MatchDetailRepository } from './match-detail.repository';
import { MatchDetailService } from './match-detail.service';
import { MatchesRepository } from './matches.repository';
import { MatchesService } from './matches.service';
import { MetricsRepository } from './metrics.repository';
import { PlayerRankService } from './player-rank.service';
import { ProjectionService } from './projection.service';
import { SettingsService } from './settings.service';
import { SteamProfileService } from './steam-profile.service';
import { SteamSignInService } from './steam-sign-in.service';
import { SyncStateRepository } from './sync-state.repository';
import { SyncService } from './sync.service';

/** The adapters of an environment: one implementation of each port. */
export interface AppAdapters {
  readonly logger: Logger;
  readonly settingsStore: SettingsStore;
  readonly http: HttpClient;
  readonly database: Database;
  /**
   * Runs the loopback listener and opens the system browser for the Steam sign-in. The account
   * itself is not an adapter: it is the link stored in `database`.
   */
  readonly signInGateway: SignInGateway;
  /** Where the archives of the match details are kept. */
  readonly archiveStore: ArchiveStore;
  /** Compresses the archives of the match details. */
  readonly compressor: Compressor;
}

/** Options of {@link createAppServices}. */
export interface AppServicesOptions {
  /** Version of the app, sent to deadlock-api in the User-Agent. */
  readonly appVersion: string;
  /** Current time (Unix ms); `Date.now` by default, controlled by tests. */
  readonly now?: () => number;
  /**
   * Wait for a delay in milliseconds when a match detail request has to wait for the next slot of
   * the rate limit; a timer by default, controlled by tests.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Build the application services.
 *
 * @param adapters - The adapters of the environment.
 * @param options - See {@link AppServicesOptions}.
 * @returns The services.
 */
export function createAppServices(adapters: AppAdapters, options: AppServicesOptions): AppServices {
  const { logger, settingsStore, http, database, signInGateway, archiveStore, compressor } =
    adapters;
  const now = options.now ?? Date.now;
  // The account the app works for is the link stored in the database, not an adapter: this one
  // instance is the `AccountSource` of every service, so they all see a link or an unlink at once.
  const linkedAccounts = new LinkedAccountRepository(database, logger);
  const syncState = new SyncStateRepository(database, logger, now);
  const matches = new MatchesRepository(database, now);
  // One API service for the whole app: the history, the heroes and the match details all go
  // through the same rate limit, the same in-flight limit and the same shared pause.
  const api = new DeadlockApiService(http, syncState, logger, {
    appVersion: options.appVersion,
    now,
    // Left out, not passed as `undefined`: the service then uses its own timer.
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  // One reader for the whole app: every service that works from the archives reads them through it,
  // so one set of rules says what an unreadable archive is and how it is logged.
  const reader = new ArchiveReaderService({ archive: archiveStore, compressor, logger });
  // The detail state of the matches is read and written by the detail queue and by the projection
  // (an archive that cannot be read puts its match back in the queue): the one repository for both.
  const detailRepository = new MatchDetailRepository(database);
  const details = new MatchDetailService({
    accountSource: linkedAccounts,
    api,
    repository: detailRepository,
    archive: archiveStore,
    compressor,
    reader,
    logger,
    now,
  });
  // The values of the metrics of every match are written by the projection and read by the
  // analysis: the one repository for both.
  const metrics = new MetricsRepository(database);
  // Turns the archived matches into the values of their metrics, from the very `reader` and
  // `detailRepository` of the detail queue.
  const projection = new ProjectionService({
    reader,
    metrics,
    details: detailRepository,
    logger,
    now,
  });
  // Keeps the rank of the linked account, through the one `api` (and so its rank budget and pause).
  const rank = new PlayerRankService({ api, accounts: linkedAccounts, logger, now });
  // The slow-changing API responses (the hero names and the community data) share one cache table.
  const apiCache = new ApiCacheRepository(database);
  // Keeps the community data the analysis compares the matches with, through the one `api` too.
  const benchmarks = new BenchmarkService({
    api,
    cache: apiCache,
    accountSource: linkedAccounts,
    logger,
    now,
  });
  // Compares a match with the community and with the habits of the player, from the projection the
  // synchronisation keeps up to date and from the very `reader` and `detailRepository` above.
  const analysis = new AnalysisService({
    accountSource: linkedAccounts,
    metrics,
    details: detailRepository,
    reader,
    benchmarks,
    accounts: linkedAccounts,
    logger,
  });
  // The synchronisation runs the detail queue after the history: it gets the one `details`, and
  // keeps the projection and the rank up to date inside its runs, which the suspension waits for.
  const sync = new SyncService({
    accountSource: linkedAccounts,
    api,
    details,
    matches,
    projection,
    rank,
    syncState,
    logger,
    now,
  });
  // Deletes the data of an account from the very instances the other services work with, so that
  // nothing of an account stays in a repository, the archive or the memory of the detail queue.
  const accountData = new AccountDataService({
    matches,
    metrics,
    syncState,
    archive: archiveStore,
    maintenance: new DatabaseMaintenanceRepository(database),
    details,
    logger,
  });
  // The only writer of the link: the other services only read it, through `linkedAccounts`.
  const account = new AccountService({
    accounts: linkedAccounts,
    signIn: new SteamSignInService({
      gateway: signInGateway,
      http,
      logger,
      appVersion: options.appVersion,
      now,
    }),
    profiles: new SteamProfileService({
      api,
      http,
      logger,
      appVersion: options.appVersion,
      now,
    }),
    data: accountData,
    sync,
    logger,
    now,
  });
  return {
    logger,
    settings: new SettingsService(settingsStore, logger),
    matches: new MatchesService(linkedAccounts, matches, now),
    heroes: new HeroCatalogService(linkedAccounts, api, apiCache, logger, now),
    details,
    sync,
    account,
    analysis,
  };
}
