/**
 * Tests of the Web Storage settings adapter. `localStorage` comes from jsdom and is cleared after
 * every test by `src/test/setup.ts`.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  LocalStorageSettingsStore,
  SETTINGS_STORAGE_KEY,
} from './local-storage-settings-store.adapter';

describe('LocalStorageSettingsStore', () => {
  it('reads undefined when nothing was saved', async () => {
    await expect(new LocalStorageSettingsStore(localStorage).read()).resolves.toBeUndefined();
  });

  it('round-trips a document', async () => {
    const store = new LocalStorageSettingsStore(localStorage);
    await store.write({ schemaVersion: 1, language: 'fr' });
    await expect(store.read()).resolves.toEqual({ schemaVersion: 1, language: 'fr' });
  });

  it('stores the document as JSON under a namespaced key', async () => {
    await new LocalStorageSettingsStore(localStorage).write({ language: 'en' });
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe('{"language":"en"}');
  });

  it('reports corrupted JSON as "nothing saved" instead of throwing', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, '{oops');
    await expect(new LocalStorageSettingsStore(localStorage).read()).resolves.toBeUndefined();
  });
});
