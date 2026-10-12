/**
 * {@link SettingsStore} backed by the Tauri store plugin (desktop app).
 *
 * The document is saved in `settings.json` under the app data folder
 * (`%APPDATA%\io.github.gonzalezedev.thelibrary\settings.json` on Windows), under a single key,
 * and flushed to disk after every write so a crash right after a change cannot lose it.
 *
 * @packageDocumentation
 */
import { load, type Store } from '@tauri-apps/plugin-store';
import type { SettingsStore } from '../../ports/settings-store.port';

/**
 * Store file, relative to the app data folder. The plugin performs no path sandboxing (absolute
 * paths and `..` are accepted), so this name is a constant, never built from user input.
 */
const SETTINGS_FILE_NAME = 'settings.json';

/** Key of the settings document inside the store file. */
const SETTINGS_KEY = 'settings';

/** {@link SettingsStore} persisting the settings document with `@tauri-apps/plugin-store`. */
export class TauriSettingsStore implements SettingsStore {
  /** Store handle, opened on first use and reused for the lifetime of the app. */
  #store: Promise<Store> | undefined;

  /**
   * Read the saved document.
   *
   * @returns The saved document, or `undefined` on first launch.
   */
  async read(): Promise<unknown> {
    const store = await this.#open();
    return store.get<unknown>(SETTINGS_KEY);
  }

  /**
   * Replace the saved document and write it to disk immediately.
   *
   * @param document - JSON-serialisable settings document.
   */
  async write(document: unknown): Promise<void> {
    const store = await this.#open();
    await store.set(SETTINGS_KEY, document);
    await store.save();
  }

  /**
   * Open the store file once; concurrent callers share the same pending promise.
   *
   * @returns The store handle.
   */
  #open(): Promise<Store> {
    // Auto-save is disabled because `write` saves explicitly (the plugin still saves on exit).
    this.#store ??= load(SETTINGS_FILE_NAME, { autoSave: false });
    return this.#store;
  }
}
