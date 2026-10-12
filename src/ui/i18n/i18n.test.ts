/**
 * Tests of the translation catalogues and of the i18next setup.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { createI18n } from './i18n';
import enCommon from './locales/en/common.json';
import frCommon from './locales/fr/common.json';

/**
 * List the leaves of a nested catalogue as `[dotted.key, value]` pairs.
 *
 * @param catalogue - A catalogue or one of its sub-objects.
 * @param prefix - Dotted path of `catalogue` inside the root catalogue.
 * @returns Every leaf of the catalogue.
 */
function leavesOf(catalogue: Record<string, unknown>, prefix = ''): [string, unknown][] {
  return Object.entries(catalogue).flatMap(([key, value]): [string, unknown][] => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return typeof value === 'object' && value !== null
      ? leavesOf(value as Record<string, unknown>, path)
      : [[path, value]];
  });
}

describe('catalogues', () => {
  it('have exactly the same keys in French and English', () => {
    const keys = (catalogue: Record<string, unknown>) =>
      leavesOf(catalogue)
        .map(([key]) => key)
        .toSorted();
    expect(keys(frCommon)).toEqual(keys(enCommon));
  });

  it('contain no empty translation', () => {
    for (const [key, value] of [...leavesOf(enCommon), ...leavesOf(frCommon)]) {
      expect(typeof value === 'string' && value.trim() !== '', key).toBe(true);
    }
  });
});

describe('createI18n', () => {
  it('translates in the requested language and switches at runtime', async () => {
    const i18n = await createI18n('fr');
    expect(i18n.t('nav.dashboard')).toBe('Tableau de bord');

    await i18n.changeLanguage('en');
    expect(i18n.t('nav.dashboard')).toBe('Dashboard');
  });

  it('keeps <html lang> in sync with the active language', async () => {
    const i18n = await createI18n('fr');
    expect(document.documentElement.lang).toBe('fr');

    await i18n.changeLanguage('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('interpolates values', async () => {
    const i18n = await createI18n('en');
    expect(i18n.t('matchDetail.title', { matchId: '42' })).toBe('Match 42');
  });
});
