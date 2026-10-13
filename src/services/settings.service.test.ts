/**
 * Tests of the settings use cases, with the development adapters.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { LocalStorageSettingsStore } from '../adapters/dev/local-storage-settings-store.adapter';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import { AppError } from '../core/errors/app-error';
import type { SettingsStore } from '../ports/settings-store.port';
import { SettingsService } from './settings.service';

/**
 * Build a service on an empty in-memory store (jsdom's localStorage is cleared after each test).
 *
 * @returns The service and the logger it writes to.
 */
function createService(): { service: SettingsService; logger: MemoryLogger } {
  const logger = new MemoryLogger();
  const service = new SettingsService(new LocalStorageSettingsStore(localStorage), logger);
  return { service, logger };
}

/** A store whose every operation fails, to test error handling. */
const brokenStore: SettingsStore = {
  read: () => Promise.reject(new Error('disk unreadable')),
  write: () => Promise.reject(new Error('disk full')),
};

describe('SettingsService.get', () => {
  it('returns the defaults on first launch', async () => {
    const { service } = createService();
    await expect(service.get()).resolves.toEqual({ schemaVersion: 1, language: null });
  });

  it('wraps storage failures in a storage AppError', async () => {
    const service = new SettingsService(brokenStore, new MemoryLogger());
    const error: unknown = await service.get().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ kind: 'storage' });
  });
});

describe('SettingsService.update', () => {
  it('saves the change and returns the new settings', async () => {
    const { service } = createService();

    await expect(service.update({ language: 'fr' })).resolves.toEqual({
      schemaVersion: 1,
      language: 'fr',
    });
    await expect(service.get()).resolves.toEqual({ schemaVersion: 1, language: 'fr' });
  });

  it('logs which fields changed', async () => {
    const { service, logger } = createService();
    await service.update({ language: 'en' });

    expect(logger.entries).toContainEqual({
      level: 'info',
      scope: 'settings',
      message: 'Settings updated',
      context: { fields: 'language' },
    });
  });

  it('wraps storage failures in a storage AppError', async () => {
    const service = new SettingsService(brokenStore, new MemoryLogger());
    await expect(service.update({ language: 'fr' })).rejects.toMatchObject({ kind: 'storage' });
  });

  it('reports a failed save as a storage AppError that keeps the cause, and does not log a change', async () => {
    // The store reads fine, so the failure comes from the write itself.
    const diskFull = new Error('disk full');
    const store: SettingsStore = {
      read: () => Promise.resolve(undefined),
      write: () => Promise.reject(diskFull),
    };
    const logger = new MemoryLogger();
    const service = new SettingsService(store, logger);

    const error: unknown = await service
      .update({ language: 'fr' })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ kind: 'storage', message: 'Could not save the settings' });
    expect((error as AppError).cause).toBe(diskFull);
    expect(logger.entries.map((entry) => entry.message)).not.toContain('Settings updated');
  });
});
