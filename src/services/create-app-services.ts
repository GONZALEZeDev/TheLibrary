/**
 * Builds the application services from the adapters of an environment.
 *
 * This is the one place where services are wired together: the composition root (`src/main.tsx`)
 * calls it with the Tauri or the development adapters, and the tests with the development ones,
 * so both run exactly the same assembly.
 *
 * @packageDocumentation
 */
import type { AccountSource } from '../ports/account-source.port';
import type { ArchiveStore } from '../ports/archive-store.port';
import type { Compressor } from '../ports/compressor.port';
import type { Database } from '../ports/database.port';
import type { HttpClient } from '../ports/http-client.port';
import type { Logger } from '../ports/logger.port';
import type { SettingsStore } from '../ports/settings-store.port';
import { ApiCacheRepository } from './api-cache.repository';
import type { AppServices } from './app-services';
import { DeadlockApiService } from './deadlock-api.service';
import { HeroCatalogService } from './hero-catalog.service';
import { MatchDetailRepository } from './match-detail.repository';
import { MatchDetailService } from './match-detail.service';
import { MatchesRepository } from './matches.repository';
import { MatchesService } from './matches.service';
import { SettingsService } from './settings.service';
import { SyncStateRepository } from './sync-state.repository';
import { SyncService } from './sync.service';

/** The adapters of an environment: one implementation of each port. */
export interface AppAdapters {
  readonly logger: Logger;
  readonly settingsStore: SettingsStore;
  readonly http: HttpClient;
  readonly database: Database;
  readonly accountSource: AccountSource;
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
  const { logger, settingsStore, http, database, accountSource, archiveStore, compressor } =
    adapters;
  const now = options.now ?? Date.now;
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
  const details = new MatchDetailService({
    accountSource,
    api,
    repository: new MatchDetailRepository(database),
    archive: archiveStore,
    compressor,
    logger,
    now,
  });
  return {
    logger,
    settings: new SettingsService(settingsStore, logger),
    matches: new MatchesService(accountSource, matches, now),
    heroes: new HeroCatalogService(api, new ApiCacheRepository(database), logger, now),
    details,
    // The synchronisation runs the detail queue after the history: it gets the one `details`.
    sync: new SyncService({ accountSource, api, details, matches, syncState, logger, now }),
  };
}
