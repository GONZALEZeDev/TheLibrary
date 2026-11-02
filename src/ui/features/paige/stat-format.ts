/**
 * The numbers of the Paige page, written the way each language does: `0.61` and `2.5s` in English,
 * `0,61` and `2,5 s` in French.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import type { StatUnit } from '../../../core/hero-page/stat-panels';

/** The units a number of the page may come with: those of the stat panels, or `m` from the API. */
export type ShownUnit = StatUnit | 'm';

/**
 * Write a number of the page.
 *
 * @param value - The number.
 * @param language - The UI language, as a BCP 47 tag.
 * @returns The number with at most two decimals, in the number format of the language.
 */
export function formatStatNumber(value: number, language: string): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(value);
}

/**
 * Write a number of the page with its unit.
 *
 * @param value - The number.
 * @param unit - Its unit: seconds, metres (`metres` or the API's `m`), metres per second, or none.
 * @param language - The UI language, as a BCP 47 tag.
 * @param t - The translator: each language writes the unit its own way (`2.5s`, `2,5 s`).
 * @returns The number and its unit.
 */
export function formatAmountWithUnit(
  value: number,
  unit: ShownUnit,
  language: string,
  t: TFunction,
): string {
  const number = formatStatNumber(value, language);
  switch (unit) {
    case 'seconds':
      return t('paige.units.seconds', { value: number });
    case 'metres':
    case 'm':
      return t('paige.units.metres', { value: number });
    case 'metresPerSecond':
      return t('paige.units.metresPerSecond', { value: number });
    case null:
      return number;
  }
}
