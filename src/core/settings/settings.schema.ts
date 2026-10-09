/**
 * Shape, defaults and validation of the persisted user settings.
 *
 * Settings are stored as one JSON document. Reading is tolerant: a missing field gets its default
 * and an invalid field is reset on its own, so a corrupted or outdated file never prevents the app
 * from starting. A field added in a later milestone only needs a default here — no migration —
 * which is why {@link SETTINGS_SCHEMA_VERSION} only changes for non-additive changes.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { SUPPORTED_LANGUAGES } from './language';

/** Version of the settings document. Bump it only for non-additive (breaking) changes. */
export const SETTINGS_SCHEMA_VERSION = 1;

/**
 * Zod schema of the settings document.
 *
 * Every field uses `.catch()`, so one invalid value falls back to its default without discarding
 * the other, still valid, fields. Unknown fields are stripped.
 */
export const settingsSchema = z.object({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION).catch(SETTINGS_SCHEMA_VERSION),
  /** `null` until the user explicitly picks a language; the system language is used meanwhile. */
  language: z.enum(SUPPORTED_LANGUAGES).nullable().catch(null),
});

/** Validated settings, as used by the rest of the application. */
export type Settings = z.infer<typeof settingsSchema>;

/**
 * Validate a raw settings document read from storage.
 *
 * @param raw - Whatever the store returned (`undefined` when nothing was saved yet).
 * @returns Valid settings; missing or invalid values are replaced by their defaults.
 */
export function parseSettings(raw: unknown): Settings {
  // Anything that is not a plain object (undefined, a corrupted string, an array…) counts as
  // "nothing saved", so every field falls back to its default.
  const isPlainObject = typeof raw === 'object' && raw !== null && !Array.isArray(raw);
  return settingsSchema.parse(isPlainObject ? raw : {});
}

/** Settings of a fresh installation. */
export const DEFAULT_SETTINGS: Settings = parseSettings(undefined);
