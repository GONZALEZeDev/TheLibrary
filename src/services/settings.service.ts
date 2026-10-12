/**
 * Settings use cases: read the current settings and change them.
 *
 * Reads are validated by `core/settings`, so callers always get well-formed settings, even from a
 * corrupted or outdated file. Every change is saved immediately and logged. Storage failures are
 * reported as `AppError` of kind `storage`, so the UI can show a translated message.
 *
 * @packageDocumentation
 */
import { AppError } from '../core/errors/app-error';
import { parseSettings, type Settings } from '../core/settings/settings.schema';
import type { Logger } from '../ports/logger.port';
import type { SettingsStore } from '../ports/settings-store.port';

/** Changes accepted by {@link SettingsService.update}; the schema version is managed internally. */
export type SettingsPatch = Partial<Omit<Settings, 'schemaVersion'>>;

/** Reads and updates the user settings. */
export class SettingsService {
  readonly #store: SettingsStore;
  readonly #logger: Logger;

  /**
   * @param store - Where the settings document is persisted.
   * @param logger - Structured logger.
   */
  constructor(store: SettingsStore, logger: Logger) {
    this.#store = store;
    this.#logger = logger;
  }

  /**
   * Load the current settings.
   *
   * @returns Valid settings; defaults replace anything missing or invalid.
   * @throws AppError of kind `storage` when the store cannot be read.
   */
  async get(): Promise<Settings> {
    let raw: unknown;
    try {
      raw = await this.#store.read();
    } catch (error) {
      throw new AppError('storage', 'Could not read the settings', { cause: error });
    }
    return parseSettings(raw);
  }

  /**
   * Apply a partial change and save the result.
   *
   * @param patch - Fields to change.
   * @returns The settings after the change.
   * @throws AppError of kind `storage` when the store cannot be read or written.
   */
  async update(patch: SettingsPatch): Promise<Settings> {
    // Re-validating the merged document guarantees that only valid settings are ever written.
    const next = parseSettings({ ...(await this.get()), ...patch });
    try {
      await this.#store.write(next);
    } catch (error) {
      throw new AppError('storage', 'Could not save the settings', { cause: error });
    }
    this.#logger.log('info', 'settings', 'Settings updated', {
      fields: Object.keys(patch).join(','),
    });
    return next;
  }
}
