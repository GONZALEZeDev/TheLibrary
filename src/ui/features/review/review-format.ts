/**
 * How the review is written: the figure of a point and its gap with the tier above, in how many
 * matches it was weak or strong, how it moved since the matches before, and the name of the point, in
 * the language of the interface. It also gives the key that tells the points of one list apart, which
 * no language changes.
 *
 * The number formats are those of the analysis of a match (`../match-detail/analysis-format`), so
 * that the review and the match page write the same figure the same way: a decimal separator and a
 * percent sign of the language, a real minus sign, and a dash for a figure that is unknown, never a
 * `0`. What the review adds is the unit of its own points (a minute, a place, a number of deaths for
 * ten minutes), which it writes through the strings of the interface, and the decimal of a count:
 * the figure of a match is whole, but the middle of many matches is often a half, and the gap beside
 * it is written with that half.
 *
 * Everything here is pure: the same input gives the same text.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import type { Difference } from '../../../core/analysis/references';
import type { PlaceStat } from '../../../core/match-detail/scoreboard';
import type {
  ResistanceItemView,
  ReviewRow,
  ReviewSubject,
  ReviewUnit,
} from '../../../services/review-view';
import {
  formatDecimalIfNeeded,
  formatDifference,
  formatMetricValue,
  formatOneDecimal,
  formatSignedPercent,
  metricLabel,
  NO_VALUE,
} from '../match-detail/analysis-format';

/** What stands between the figure the player had before and the one they have now. */
const PROGRESS_ARROW = '→';

/** What stands between the two figures of a progress and the word that says how it went. */
const PROGRESS_WORD_SEPARATOR = '·';

/** What stands between the name of a resistance item and what the row says of it. */
const ITEM_ROW_SEPARATOR = '·';

/**
 * The text that names each figure of a place among the players: the full name of the figure, which
 * the analysis of a match already has for its metrics and its phases. The columns of the players
 * table are not used, as they are abbreviated ("Dégâts obj.") to fit the table.
 */
const PLACE_LABEL_KEYS = {
  netWorth: 'analysis.phaseStat.souls',
  heroDamage: 'analysis.phaseStat.hero_damage',
  objectiveDamage: 'analysis.phaseStat.objective_damage',
  support: 'players.columns.support',
  lastHits: 'analysis.metric.last_hits',
} as const satisfies Record<PlaceStat, string>;

/**
 * Write the figure of a point of the review.
 *
 * - A number of deaths has one decimal, alone (`1.8`) or for ten minutes (`1.8 per 10 min`).
 * - A minute reads "12.4 min", a place "5.7 of 12" and a place in Valve's top three "1.5 of 3": a
 *   decimal only when the figure is not whole.
 * - A rate (how often something happened) is a percentage.
 * - A count has a decimal only when it is not whole (`8`, `4.5`), as the gap beside it does: the
 *   figure of the tier is the middle of many matches, often a half, and written whole it would
 *   contradict a gap of `+3.5` between 8 and 4.5. The figure of one match is whole and reads whole.
 * - The unit of another metric of the match page is written as that page writes it.
 *
 * @param value - The figure, or `null` when it is unknown.
 * @param unit - What the figure counts.
 * @param language - The language of the interface.
 * @param t - Translation function, for the units that have a text of their own.
 * @returns The text, or a dash for an unknown figure.
 */
export function formatReviewValue(
  value: number | null,
  unit: ReviewUnit,
  language: string,
  t: TFunction,
): string {
  if (value === null) {
    return NO_VALUE;
  }
  switch (unit) {
    case 'deaths':
      return formatOneDecimal(value, language);
    case 'deaths_per_10_min':
      return t('review.unit.per10', { value: formatOneDecimal(value, language) });
    case 'minute':
      return t('review.unit.minute', { value: formatDecimalIfNeeded(value, language) });
    case 'place':
      return t('review.unit.place', { value: formatDecimalIfNeeded(value, language) });
    case 'top_three_place':
      return t('review.unit.topThreePlace', { value: formatDecimalIfNeeded(value, language) });
    case 'rate':
      return formatMetricValue(value, 'percent', language);
    case 'count':
      // Not `formatMetricValue`, which writes a count whole: the gap of a count keeps its decimal
      // (`formatDifference`), and the two figures must agree with it.
      return formatDecimalIfNeeded(value, language);
    default:
      // What is left is the unit of a metric of the match page.
      return formatMetricValue(value, unit, language);
  }
}

/**
 * Write the gap between the figure of the player and the one of the tier above, for the gap column
 * of a row.
 *
 * A relative gap is a signed percentage, whatever the unit. An absolute one is signed in the unit of
 * the row, with the same decimals as its figures:
 *
 * - deaths, alone or for ten minutes, have one decimal (`+0.3`);
 * - a minute keeps its unit (`+1.5 min`);
 * - a place, in the twelve or in Valve's top three, is a signed number (`−0.8`);
 * - a gap between two rates is in points (`+4 pts`), since a percentage of a percentage means little;
 * - the unit of a metric of the match page is written as that page writes its gap.
 *
 * The sign says higher or lower, never better or worse: that is for the page to say.
 *
 * @param difference - The gap, or `null` when the row has no figure of the tier.
 * @param unit - What the figures of the row count.
 * @param language - The language of the interface.
 * @param t - Translation function, for the units that have a text of their own.
 * @returns The text, with a real minus sign, or a dash for a row with no gap. A gap that rounds to
 *   zero is written without sign.
 */
export function formatReviewGap(
  difference: Difference | null,
  unit: ReviewUnit,
  language: string,
  t: TFunction,
): string {
  if (difference === null) {
    return NO_VALUE;
  }
  if (difference.kind === 'relative') {
    // A share of the tier's figure is a percentage in every unit.
    return formatSignedPercent(difference.ratio, language);
  }
  const { amount } = difference;
  switch (unit) {
    case 'deaths':
    case 'deaths_per_10_min':
      return formatOneDecimal(amount, language, { signed: true });
    case 'minute':
      return t('review.unit.minute', {
        value: formatDecimalIfNeeded(amount, language, { signed: true }),
      });
    case 'place':
    case 'top_three_place':
      return formatDecimalIfNeeded(amount, language, { signed: true });
    case 'rate':
      // A rate is a share held from 0 to 1, so its gap is written in points like a percentage's.
      return formatDifference(difference, 'percent', language, t);
    default:
      // What is left is the unit of a metric of the match page.
      return formatDifference(difference, unit, language, t);
  }
}

/**
 * Write in how many of the last matches a point was weak and in how many it was strong, out of the
 * matches a rule could judge it in ("weak in 7/18 · strong in 2/18").
 *
 * @param row - The row of the point.
 * @param t - Translation function.
 * @returns The text, or an empty text for a point no match could judge: it has nothing to count.
 */
export function formatMarks(row: ReviewRow, t: TFunction): string {
  if (row.marked === 0) {
    return '';
  }
  return t('review.marks', { weak: row.weak, strong: row.strong, marked: row.marked });
}

/**
 * Write how the figure of a point moved since the matches before the last ones, with the word that
 * says how it went ("1.8 → 1.6 · better").
 *
 * A point that is neither better nor worse when higher (how often an item is bought) has no word:
 * its figures are told and nothing says more. Without a figure on either side (too few matches in
 * the last ones or in the ones before) there is nothing to set side by side, and a dash stands in.
 *
 * @param row - The row of the point.
 * @param language - The language of the interface.
 * @param t - Translation function.
 * @returns The text, or a dash when there is no progress to tell.
 */
export function formatProgress(row: ReviewRow, language: string, t: TFunction): string {
  const { before, direction } = row.progress;
  if (before === null || row.value === null) {
    return NO_VALUE;
  }
  const move = [
    formatReviewValue(before, row.unit, language, t),
    PROGRESS_ARROW,
    formatReviewValue(row.value, row.unit, language, t),
  ].join(' ');
  return direction === null
    ? move
    : `${move} ${PROGRESS_WORD_SEPARATOR} ${t(`review.progress.${direction}`)}`;
}

/**
 * The name of a resistance item: its English name, or its class name when the item catalogue does
 * not know it (such an item has no id either, so nothing else could name it).
 *
 * @param item - The item.
 * @returns The name.
 */
function itemNameOf(item: ResistanceItemView): string {
  return item.name ?? item.className;
}

/**
 * Name a point of the review, in the language of the interface.
 *
 * - A metric has the name it has on the match page.
 * - The deaths of a phase are "Deaths in mid"; the phase is a word in the middle of the sentence,
 *   like the phase of a metric.
 * - A resistance item is named by its English name, or by its class name when the item catalogue does
 *   not know it, then by what the row says of it: the two rows of one item (when it is bought, how
 *   often) read differently.
 * - A place among the players is named by the figure it is on.
 *
 * @param subject - The point.
 * @param t - Translation function.
 * @param language - The language of the interface, which lowercases the name of a phase.
 * @returns The name.
 * @throws AppError of kind `unexpected` when the point is a metric that has no name (see
 *   `metricLabel`).
 */
export function reviewLabel(subject: ReviewSubject, t: TFunction, language: string): string {
  switch (subject.kind) {
    case 'metric':
      return metricLabel(subject.key, t, language);
    case 'phase_deaths':
      return t('review.deaths.phase', {
        phase: t(`analysis.phase.${subject.phase}`).toLocaleLowerCase(language),
      });
    case 'resistance_minute':
      return `${itemNameOf(subject.item)} ${ITEM_ROW_SEPARATOR} ${t('review.deaths.boughtAt')}`;
    case 'resistance_rate':
      return `${itemNameOf(subject.item)} ${ITEM_ROW_SEPARATOR} ${t('review.deaths.bought')}`;
    case 'first_resistance_minute':
      return t('review.deaths.firstMinute');
    case 'deaths_before_resistance':
      return t('review.deaths.deathsBefore');
    case 'place':
      return t('review.players.place', { stat: t(PLACE_LABEL_KEYS[subject.stat]) });
    case 'valve_top_three':
      return t('review.players.topThree');
    case 'valve_top_three_place':
      return t('review.players.topThreePlace');
  }
}

/**
 * Key a point of the review, to tell the rows of one list apart.
 *
 * A key names what the point is about and nothing a language writes, so it is the same from one
 * render to the next and when the language changes (the rows are not mounted again, and keep what
 * they hold). It is different for every point of the review, whichever tabs the rows come from.
 *
 * - A metric is keyed by its key (the metrics of a phase have a key of their own).
 * - The deaths of a phase are keyed by the phase, a place among the players by the figure it is on.
 * - A resistance item is keyed by its class name, which every item has whether or not the catalogue
 *   knows it (its name may be missing, or shared), with the kind of the row: the two rows of one item
 *   (when it is bought, how often) are different points.
 * - A point with no parameter is keyed by its kind.
 *
 * @param subject - The point.
 * @returns The key.
 */
export function reviewRowKey(subject: ReviewSubject): string {
  switch (subject.kind) {
    case 'metric':
      return `${subject.kind}.${subject.key}`;
    case 'phase_deaths':
      return `${subject.kind}.${subject.phase}`;
    case 'resistance_minute':
    case 'resistance_rate':
      return `${subject.kind}.${subject.item.className}`;
    case 'place':
      return `${subject.kind}.${subject.stat}`;
    case 'first_resistance_minute':
    case 'deaths_before_resistance':
    case 'valve_top_three':
    case 'valve_top_three_place':
      return subject.kind;
  }
}
