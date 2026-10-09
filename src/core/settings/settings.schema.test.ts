/**
 * Tests of the tolerant settings parser.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, parseSettings } from './settings.schema';

describe('parseSettings', () => {
  it('returns the defaults when nothing was saved', () => {
    expect(parseSettings(undefined)).toEqual({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      language: null,
    });
    expect(DEFAULT_SETTINGS).toEqual({ schemaVersion: 1, language: null });
  });

  it('keeps valid values', () => {
    expect(parseSettings({ schemaVersion: 1, language: 'fr' })).toEqual({
      schemaVersion: 1,
      language: 'fr',
    });
  });

  it('resets only the invalid fields', () => {
    expect(parseSettings({ schemaVersion: 1, language: 'de' })).toEqual({
      schemaVersion: 1,
      language: null,
    });
  });

  it('drops unknown fields', () => {
    expect(parseSettings({ language: 'en', theme: 'pink' })).toEqual({
      schemaVersion: 1,
      language: 'en',
    });
  });

  it('treats a corrupted document as empty', () => {
    expect(parseSettings('not an object')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(['fr'])).toEqual(DEFAULT_SETTINGS);
  });
});
