/**
 * Test helpers: the application services built on the development adapters, and a TanStack Query
 * client suited to tests.
 *
 * @packageDocumentation
 */
import { QueryClient } from '@tanstack/react-query';
import { LocalStorageSettingsStore } from '../adapters/dev/local-storage-settings-store.adapter';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import type { AppServices } from '../services/app-services';
import { SettingsService } from '../services/settings.service';

/** Services for a test, plus direct access to the in-memory logger to inspect what was logged. */
export interface TestServices {
  readonly services: AppServices;
  readonly logger: MemoryLogger;
}

/**
 * Build the application services on in-memory adapters. jsdom's `localStorage` is cleared after
 * each test (see `setup.ts`), so every test starts from a first launch.
 *
 * @returns The services and their logger.
 */
export function createTestServices(): TestServices {
  const logger = new MemoryLogger();
  const settings = new SettingsService(new LocalStorageSettingsStore(localStorage), logger);
  return { services: { settings, logger }, logger };
}

/**
 * Create a TanStack Query client that never retries, so a failing query fails immediately.
 *
 * @returns A fresh query client.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}
