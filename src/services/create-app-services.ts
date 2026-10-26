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
import type { Diagnostics } from '../ports/diagnostics.port';
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
import { GameAssetService } from './game-asset.service';
import { HeroCatalogService } from './hero-catalog.service';
import { ItemBenchmarkService } from './item-benchmark.service';
import { LinkedAccountRepository } from './linked-account.repository';
import { MatchBreakdownService } from './match-breakdown.service';
import { MatchDetailRepository } from './match-detail.repository';
import { MatchDetailService } from './match-detail.service';
import { MatchTimelineService } from './match-timeline.service';
import { MatchesRepository } from './matches.repository';
import { MatchesService } from './matches.service';
import { MetricsRepository } from './metrics.repository';
import { PlayerRankService } from './player-rank.service';
import { ProjectionService } from './projection.service';
import { ReviewService } from './review.service';
import { SettingsService } from './settings.service';
import { SteamProfileService } from './steam-profile.service';
import { SteamSignInService } from './steam-sign-in.service';
import { StorageService } from './storage.service';
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
  /** The detailed log switch and the log folder. */
  readonly diagnostics: Diagnostics;
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
  const {
    logger,
    settingsStore,
    http,
    database,
    signInGateway,
    archiveStore,
    compressor,
    diagnostics,
  } = adapters;
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
  // The detail state of the matches is written by the detail queue and read by the analysis: the one
  // repository for both.
  const detailRepository = new MatchDetailRepository(database);
  // The values of the metrics of every match, read by the analysis and erased with the account.
  const metrics = new MetricsRepository(database);
  // Turns the archived matches into the values of their metrics, through the very `reader` and
  // `detailRepository` above. The synchronisation runs it at the end of each run, and the analysis
  // for a match whose page finds it not analysed yet: one instance for both, since it is the one
  // that runs their projections one at a time (and the detail queue's forgetting of one, below).
  const projection = new ProjectionService({
    reader,
    metrics,
    details: detailRepository,
    logger,
    now,
  });
  const details = new MatchDetailService({
    accountSource: linkedAccounts,
    api,
    repository: detailRepository,
    archive: archiveStore,
    compressor,
    reader,
    // A match whose archive the queue refreshes forgets its projection, for the catch-up to redo it.
    // Through the projection service, in turn with its projections: one that read the old file
    // finishes its save first, and the forgetting then deletes it.
    projections: projection,
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
  // The settings, read by the interface and by the storage below, which reads the size limit there.
  const settings = new SettingsService(settingsStore, logger);
  // Keeps the archive folder under the size limit: the synchronisation enforces it inside its runs,
  // and a change of the limit enforces it inside the exclusive section of the synchronisation.
  // Typed by hand: its initializer refers to `sync`, whose initializer refers to it.
  const storage: StorageService = new StorageService({
    accountSource: linkedAccounts,
    details: detailRepository,
    archive: archiveStore,
    settings,
    // A closure over `sync`, declared below: the synchronisation takes this service, so it is built
    // after it, and this is only called once both exist (when the player changes the limit).
    runExclusive: <T>(task: () => Promise<T>): Promise<T> => sync.runExclusive(task),
    logger,
  });
  // The synchronisation runs the detail queue after the history: it gets the one `details`, and
  // keeps the rank, the size of the archive folder and the analysis of the archived matches up to
  // date inside its runs, which the suspension waits for.
  const sync = new SyncService({
    accountSource: linkedAccounts,
    api,
    details,
    matches,
    projection,
    archiveCap: storage,
    rank,
    syncState,
    logger,
    now,
  });
  // Compares a match with the community and with the habits of the player, from the projections
  // stored and from the very `reader` and `detailRepository` above. It projects a match whose page
  // asks for the analysis before a synchronisation did, inside the exclusive section of `sync`: an
  // account change waits for it, and the `sync` has to exist first.
  const analysis = new AnalysisService({
    accountSource: linkedAccounts,
    metrics,
    details: detailRepository,
    reader,
    benchmarks,
    accounts: linkedAccounts,
    projection,
    exclusive: sync,
    logger,
  });
  // The hero, item and rank catalogues name what the match page shows; they share the cache table
  // and the asset budget. The UI reads the heroes itself, and the items and the ranks only through
  // the breakdown below, which gets the very instances (so `assets` is not one of the services).
  const heroes = new HeroCatalogService({
    accountSource: linkedAccounts,
    api,
    cache: apiCache,
    logger,
    now,
  });
  const assets = new GameAssetService({
    accountSource: linkedAccounts,
    api,
    cache: apiCache,
    logger,
    now,
  });
  // Tells the damage of a match by source, and its build, from the projections stored, the archive
  // (through the very `reader` above) and the catalogues.
  const breakdown = new MatchBreakdownService({
    accountSource: linkedAccounts,
    details: detailRepository,
    metrics,
    reader,
    heroes,
    assets,
    logger,
  });
  // Tells the timeline of a match from its archive (through the very `reader` above), its detail
  // state (whether the queue downloads it again with the positions of every player) and the
  // catalogues of the very `heroes` and `assets` above.
  const timeline = new MatchTimelineService({
    accountSource: linkedAccounts,
    details: detailRepository,
    reader,
    heroes,
    assets,
    logger,
    now,
  });
  // Sums up the last matches against the tier above and the matches before them, from the stored
  // projections, the community data of the very `benchmarks` above and the catalogues. The item
  // statistics of the tier above are only read and downloaded by the review, so `itemBenchmarks` is
  // not one of the services: it shares the one `api` (and so its budgets and pause) and the cache.
  const review = new ReviewService({
    accountSource: linkedAccounts,
    accounts: linkedAccounts,
    metrics,
    benchmarks,
    itemBenchmarks: new ItemBenchmarkService({
      api,
      cache: apiCache,
      accountSource: linkedAccounts,
      logger,
      now,
    }),
    assets,
    heroes,
    logger,
  });
  // Deletes the data of an account from the very instances the other services work with, so that
  // nothing of an account stays in a repository, the archive or the memory of the detail queue.
  const accountData = new AccountDataService({
    matches,
    metrics,
    syncState,
    archive: archiveStore,
    detailRepository,
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
    settings,
    matches: new MatchesService(linkedAccounts, matches, now),
    heroes,
    details,
    sync,
    account,
    analysis,
    breakdown,
    timeline,
    review,
    storage,
    // Given to the interface as it is: the detailed log and the log folder need no service. The
    // settings page saves the switch through `settings` and applies it through `diagnostics`.
    diagnostics,
  };
}
