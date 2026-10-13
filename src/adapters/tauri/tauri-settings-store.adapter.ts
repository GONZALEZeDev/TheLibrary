/**
 * {@link SettingsStore} backed by the Tauri store plugin (desktop app).
 *
 * The document is saved in `settings.json` under the app data folder
 * (`%APPDATA%\io.github.gonzalezedev.thelibrary\settings.json` on Windows), under a single key.
 * The Rust shell opens that file itself at startup; the webview only attaches to the store that is
 * already open and is never allowed to open a file of its own.
 *
 * The document is flushed to disk after every write, which keeps the window for losing a change
 * very small. The write itself is not atomic though (the plugin rewrites the file in place), so a
 * crash in the middle of a flush can still leave a truncated file: the plugin then opens an empty
 * store and the settings fall back to their defaults.
 *
 * @packageDocumentation
 */
import { getStore, type Store } from '@tauri-apps/plugin-store';
import type { SettingsStore } from '../../ports/settings-store.port';

/**
 * Store file, relative to the app data folder. It must stay equal to `SETTINGS_STORE_FILE` in
 * `src-tauri/src/lib.rs`, where the shell opens the store: the plugin resolves this name to the
 * same handle only if both sides spell it identically.
 */
const SETTINGS_FILE_NAME = 'settings.json';

/** Key of the settings document inside the store file. */
const SETTINGS_KEY = 'settings';

/** {@link SettingsStore} persisting the settings document with `@tauri-apps/plugin-store`. */
export class TauriSettingsStore implements SettingsStore {
  /** Store handle, looked up on first use and reused for the lifetime of the app. */
  #store: Promise<Store> | undefined;

  /**
   * Read the saved document.
   *
   * @returns The saved document, or `undefined` on first launch.
   * @throws Error if the shell did not open the settings store.
   */
  async read(): Promise<unknown> {
    const store = await this.#open();
    return store.get<unknown>(SETTINGS_KEY);
  }

  /**
   * Replace the saved document and write it to disk immediately.
   *
   * @param document - JSON-serialisable settings document.
   * @throws Error if the shell did not open the settings store.
   */
  async write(document: unknown): Promise<void> {
    const store = await this.#open();
    await store.set(SETTINGS_KEY, document);
    await store.save();
  }

  /**
   * Get the store the shell opened; concurrent callers share the same pending promise.
   *
   * @returns The store handle.
   * @throws Error if the shell did not open the settings store.
   */
  #open(): Promise<Store> {
    this.#store ??= lookUpSettingsStore().catch((error: unknown) => {
      // Forget the failed attempt, otherwise every later call would reuse the rejected promise
      // for the whole session instead of trying again.
      this.#store = undefined;
      throw error;
    });
    return this.#store;
  }
}

/**
 * Find the settings store the Rust shell opened at startup.
 *
 * The store is only looked up (`getStore`), never loaded (`load`): the `load` command can open any
 * file path, so the webview is not granted it (see `src-tauri/capabilities/default.json`).
 *
 * @returns The store handle.
 * @throws Error if the shell did not open the settings store.
 */
async function lookUpSettingsStore(): Promise<Store> {
  const store = await getStore(SETTINGS_FILE_NAME);
  if (store === null) {
    throw new Error(`The Tauri shell did not open the settings store "${SETTINGS_FILE_NAME}"`);
  }
  return store;
}
