/**
 * {@link SettingsStore} backed by the Web Storage API, for tests and the browser dev mode.
 *
 * In the desktop app the Tauri store plugin is used instead (`adapters/tauri`). The storage is
 * injected so tests control it; the composition root passes `window.localStorage`.
 *
 * @packageDocumentation
 */
import type { SettingsStore } from '../../ports/settings-store.port';

/** Web Storage key of the settings document (namespaced to avoid clashes on `localhost`). */
export const SETTINGS_STORAGE_KEY = 'thelibrary.settings';

/** {@link SettingsStore} persisting the settings document as JSON in a Web Storage. */
export class LocalStorageSettingsStore implements SettingsStore {
  readonly #storage: Storage;

  /**
   * @param storage - The Web Storage to use, usually `window.localStorage`.
   */
  constructor(storage: Storage) {
    this.#storage = storage;
  }

  /**
   * Read and parse the saved document.
   *
   * @returns The saved document, or `undefined` when nothing (or corrupted JSON) is stored.
   */
  read(): Promise<unknown> {
    const text = this.#storage.getItem(SETTINGS_STORAGE_KEY);
    if (text === null) {
      return Promise.resolve(undefined);
    }
    try {
      return Promise.resolve(JSON.parse(text) as unknown);
    } catch {
      // A hand-edited or truncated value must not crash the app: the settings service then falls
      // back to the defaults, exactly as on a first launch.
      return Promise.resolve(undefined);
    }
  }

  /**
   * Serialise and save the document.
   *
   * @param document - JSON-serialisable settings document.
   * @returns A promise resolved once the document is saved.
   */
  write(document: unknown): Promise<void> {
    this.#storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(document));
    return Promise.resolve();
  }
}
