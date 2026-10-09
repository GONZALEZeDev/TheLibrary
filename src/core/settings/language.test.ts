/**
 * Tests of the language resolution rule.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_LANGUAGE,
  SUPPORTED_LANGUAGES,
  isLanguage,
  resolveInitialLanguage,
} from './language';

describe('isLanguage', () => {
  it('accepts the supported languages', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      expect(isLanguage(language)).toBe(true);
    }
  });

  it('rejects other values', () => {
    expect(isLanguage('de')).toBe(false);
    expect(isLanguage('FR')).toBe(false);
    expect(isLanguage(null)).toBe(false);
  });
});

describe('resolveInitialLanguage', () => {
  it('prefers the language saved by the user', () => {
    expect(resolveInitialLanguage('en', ['fr-FR'])).toBe('en');
  });

  it('otherwise uses the first supported system language', () => {
    expect(resolveInitialLanguage(null, ['de-DE', 'fr-CA', 'en-US'])).toBe('fr');
  });

  it('matches the primary subtag case-insensitively', () => {
    expect(resolveInitialLanguage(null, ['EN-gb'])).toBe('en');
  });

  it('falls back to English when no system language is supported', () => {
    expect(resolveInitialLanguage(null, ['de-DE', 'ja'])).toBe(FALLBACK_LANGUAGE);
    expect(resolveInitialLanguage(null, [])).toBe(FALLBACK_LANGUAGE);
    expect(FALLBACK_LANGUAGE).toBe('en');
  });
});
