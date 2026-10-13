/**
 * Test helpers: the application services built on the development adapters, and a TanStack Query
 * client suited to tests.
 *
 * @packageDocumentation
 */
import type { QueryClient } from '@tanstack/react-query';
import { LocalStorageSettingsStore } from '../adapters/dev/local-storage-settings-store.adapter';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import type { Logger } from '../ports/logger.port';
import type { AppServices } from '../services/app-services';
import { SettingsService } from '../services/settings.service';
import { createQueryClient } from '../ui/app/query-client';

/** Services for a test, plus direct access to the in-memory logger to inspect what was logged. */
export interface TestServices {
  readonly services: AppServices;
  readonly logger: MemoryLogger;
}

/**
 * Build the application services on the development adapters (Web Storage settings store, memory
 * logger). jsdom's `localStorage` is cleared after each test (see `setup.ts`), so every test starts
 * from a first launch.
 *
 * @returns The services and their logger.
 */
export function createTestServices(): TestServices {
  const logger = new MemoryLogger();
  const settings = new SettingsService(new LocalStorageSettingsStore(localStorage), logger);
  return { services: { settings, logger }, logger };
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
