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
import type { Database } from '../ports/database.port';
import type { HttpClient } from '../ports/http-client.port';
import type { Logger } from '../ports/logger.port';
import type { SettingsStore } from '../ports/settings-store.port';
import { ApiCacheRepository } from './api-cache.repository';
import type { AppServices } from './app-services';
import { DeadlockApiService } from './deadlock-api.service';
import { HeroCatalogService } from './hero-catalog.service';
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
}

/** Options of {@link createAppServices}. */
export interface AppServicesOptions {
  /** Version of the app, sent to deadlock-api in the User-Agent. */
  readonly appVersion: string;
  /** Current time (Unix ms); `Date.now` by default, controlled by tests. */
  readonly now?: () => number;
}

/**
 * Build the application services.
 *
 * @param adapters - The adapters of the environment.
 * @param options - See {@link AppServicesOptions}.
 * @returns The services.
 */
export function createAppServices(adapters: AppAdapters, options: AppServicesOptions): AppServices {
  const { logger, settingsStore, http, database, accountSource } = adapters;
  const now = options.now ?? Date.now;
  const syncState = new SyncStateRepository(database, logger, now);
  const matches = new MatchesRepository(database, now);
  const api = new DeadlockApiService(http, syncState, logger, {
    appVersion: options.appVersion,
    now,
  });
  return {
    logger,
    settings: new SettingsService(settingsStore, logger),
    matches: new MatchesService(accountSource, matches),
    heroes: new HeroCatalogService(api, new ApiCacheRepository(database), logger, now),
    sync: new SyncService({ accountSource, api, matches, syncState, logger, now }),
  };
}
