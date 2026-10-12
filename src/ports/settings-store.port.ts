/**
 * Settings persistence port.
 *
 * Stores the whole settings document as one JSON value. Validation is NOT the adapter's job: the
 * settings service validates what it reads with `core/settings/settings.schema.ts`.
 *
 * @packageDocumentation
 */

/** Persistence of the raw settings document. */
export interface SettingsStore {
  /**
   * Read the saved document.
   *
   * @returns The raw saved value, or `undefined` when nothing was saved yet.
   */
  read(): Promise<unknown>;

  /**
   * Replace the saved document.
   *
   * @param document - JSON-serialisable settings document.
   * @returns A promise resolved once the document is saved.
   */
  write(document: unknown): Promise<void>;
}
