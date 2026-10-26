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
      storageCapMb: 500,
      debugLogging: false,
    });
    expect(DEFAULT_SETTINGS).toEqual({
      schemaVersion: 1,
      language: null,
      storageCapMb: 500,
      debugLogging: false,
    });
  });

  it('keeps valid values', () => {
    expect(parseSettings({ schemaVersion: 1, language: 'fr', storageCapMb: 2000 })).toEqual({
      schemaVersion: 1,
      language: 'fr',
      storageCapMb: 2000,
      debugLogging: false,
    });
  });

  it('resets only the invalid fields', () => {
    expect(parseSettings({ schemaVersion: 1, language: 'de', storageCapMb: 250 })).toEqual({
      schemaVersion: 1,
      language: null,
      storageCapMb: 250,
      debugLogging: false,
    });
  });

  it('reads a cap outside the presets as 500', () => {
    // Only the sizes the settings page offers are kept: any other number, or no number, is the
    // default limit.
    for (const storageCapMb of [0, 99, 300, 5120, 500.5, -100, '1000', null, true]) {
      expect(parseSettings({ language: 'en', storageCapMb })).toEqual({
        schemaVersion: 1,
        language: 'en',
        storageCapMb: 500,
        debugLogging: false,
      });
    }
  });

  it('keeps the detailed log on, and reads anything but a boolean as off', () => {
    expect(parseSettings({ debugLogging: true }).debugLogging).toBe(true);
    for (const debugLogging of [false, 'true', 1, null, {}]) {
      expect(parseSettings({ debugLogging }).debugLogging).toBe(false);
    }
  });

  it('drops unknown fields', () => {
    expect(parseSettings({ language: 'en', theme: 'pink' })).toEqual({
      schemaVersion: 1,
      language: 'en',
      storageCapMb: 500,
      debugLogging: false,
    });
  });

  it('treats a corrupted document as empty', () => {
    expect(parseSettings('not an object')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(['fr'])).toEqual(DEFAULT_SETTINGS);
  });
});
