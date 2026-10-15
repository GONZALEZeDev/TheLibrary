/**
 * Test helpers: the application services built on the development adapters, and a TanStack Query
 * client suited to tests.
 *
 * @packageDocumentation
 */
import type { QueryClient } from '@tanstack/react-query';
import {
  createFixtureApi,
  FixtureHttpClient,
  type FixtureHandler,
} from '../adapters/dev/fixture-http-client.adapter';
import { FIXTURE_ACCOUNT_ID } from '../adapters/dev/fixtures/match-history.fixture';
import { LocalStorageSettingsStore } from '../adapters/dev/local-storage-settings-store.adapter';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import type { SqlJsDatabase } from '../adapters/dev/sql-js-database.adapter';
import { StaticAccountSource } from '../adapters/dev/static-account-source.adapter';
import type { AccountId } from '../core/domain/account';
import type { Logger } from '../ports/logger.port';
import type { SettingsStore } from '../ports/settings-store.port';
import type { AppServices } from '../services/app-services';
import { createAppServices } from '../services/create-app-services';
import { createQueryClient } from '../ui/app/query-client';
import { createTestDatabase } from './test-data';

/** Options of {@link createTestServices}. */
export interface TestServicesOptions {
  /** Where the settings are saved; jsdom's `localStorage` by default. */
  readonly settingsStore?: SettingsStore;
  /** Answers the requests to deadlock-api; the synthetic fixtures by default. */
  readonly handler?: FixtureHandler;
  /** The linked account; the account of the fixtures by default, `null` for none. */
  readonly accountId?: AccountId | null;
  /** Current time (Unix ms); `Date.now` by default. */
  readonly now?: () => number;
}

/** Services for a test, plus direct access to the adapters to inspect what happened. */
export interface TestServices {
  readonly services: AppServices;
  readonly logger: MemoryLogger;
  readonly http: FixtureHttpClient;
  readonly database: SqlJsDatabase;
}

/**
 * Build the application services on the development adapters: Web Storage settings, synthetic
 * deadlock-api, in-memory database, memory logger. jsdom's `localStorage` is cleared after each
 * test (see `setup.ts`) and each call gets a fresh database, so every test starts from a first
 * launch.
 *
 * @param options - See {@link TestServicesOptions}.
 * @returns The services and their adapters.
 */
export function createTestServices(options: TestServicesOptions = {}): TestServices {
  const now = options.now ?? Date.now;
  const logger = new MemoryLogger();
  const http = new FixtureHttpClient(options.handler ?? createFixtureApi({ now: now() }));
  const database = createTestDatabase();
  const services = createAppServices(
    {
      logger,
      settingsStore: options.settingsStore ?? new LocalStorageSettingsStore(localStorage),
      http,
      database,
      accountSource: new StaticAccountSource(
        options.accountId === undefined ? FIXTURE_ACCOUNT_ID : options.accountId,
      ),
    },
    { appVersion: '0.0.0-test', now },
  );
  return { services, logger, http, database };
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
