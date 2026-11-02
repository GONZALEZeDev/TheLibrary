/**
 * Tests of the formatting of the numbers of the Paige page, in English and in French.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import type { Language } from '../../../core/settings/language';
import { createI18n } from '../../i18n/i18n';
import { formatAmountWithUnit, formatStatNumber } from './stat-format';

/** The translator of a language. */
async function translator(language: Language) {
  const i18n = await createI18n(language);
  return i18n.t.bind(i18n);
}

describe('formatStatNumber', () => {
  it('writes at most two decimals, with the decimal mark of the language', () => {
    expect(formatStatNumber(0.61, 'fr')).toBe('0,61');
    expect(formatStatNumber(43.4307, 'en')).toBe('43.43');
    expect(formatStatNumber(680, 'en')).toBe('680');
    expect(formatStatNumber(13.888, 'fr')).toBe('13,89');
  });
});

describe('formatAmountWithUnit', () => {
  it('writes seconds the way each language does', async () => {
    expect(formatAmountWithUnit(2.5, 'seconds', 'fr', await translator('fr'))).toBe('2,5 s');
    expect(formatAmountWithUnit(2.5, 'seconds', 'en', await translator('en'))).toBe('2.5s');
  });

  it('writes metres and metres per second', async () => {
    expect(formatAmountWithUnit(43.43, 'metresPerSecond', 'fr', await translator('fr'))).toBe(
      '43,43 m/s',
    );
    expect(formatAmountWithUnit(4, 'm', 'en', await translator('en'))).toBe('4m');
    expect(formatAmountWithUnit(4, 'metres', 'fr', await translator('fr'))).toBe('4 m');
  });

  it('writes a bare number when there is no unit', async () => {
    expect(formatAmountWithUnit(14, null, 'fr', await translator('fr'))).toBe('14');
  });
});
