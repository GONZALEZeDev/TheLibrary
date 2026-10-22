/**
 * How the analysis of a match is written: the value of a metric, its difference with the habits of
 * the player and the usual value those habits make, the place among the community, the total of a
 * phase, a time of the game and the name of a metric, the share of a damage source and its gap with
 * the usual one, in the language of the interface, and the marks that tell a strength from a
 * weakness.
 *
 * Everything here is pure: the same input gives the same text. A number is written with the
 * conventions of the language (the decimal separator, the space of the thousands and the one before
 * a percent sign) and a negative number with a real minus sign, which lines up with the plus sign
 * and is read as "minus" by screen readers. A value that is unknown is a dash, never a `0`.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import type { Insight } from '../../../core/analysis/insights/insights';
import type { MatchMetricKey, MetricKey, MetricUnit } from '../../../core/analysis/metric';
import { phaseMetricKey } from '../../../core/analysis/metrics/phase.metric';
import { PHASE_STATS, PHASES, type Phase, type PhaseStat } from '../../../core/analysis/phases';
import type { Difference } from '../../../core/analysis/references';
import { MATCH_METRICS } from '../../../core/analysis/registry';
import { AppError } from '../../../core/errors/app-error';
import { formatDuration } from '../matches/MatchesTable';

/** What stands in place of a value that is unknown. */
export const NO_VALUE = '—';

/**
 * The marks of a strength and of a weakness: an arrow that tells which one it is, so that the colour
 * never does it alone, the colour of the arrow, and the faint colour that tints a row or a cell of
 * the page. Colours are the theme's tokens.
 */
export const INSIGHT_STYLE = {
  strength: { arrow: '▲', text: 'text-win', tint: 'bg-win/10' },
  weakness: { arrow: '▼', text: 'text-loss', tint: 'bg-loss/10' },
} as const satisfies Record<
  Insight['side'],
  { readonly arrow: string; readonly text: string; readonly tint: string }
>;

/** The hyphen-minus that number formats write before a negative number. */
const HYPHEN_MINUS = '-';

/** The minus sign that replaces it: wider than a hyphen, as wide as the plus sign. */
const MINUS_SIGN = '\u2212';

/** The shapes a number takes in the analysis. */
const NUMBER_SHAPES = {
  /** A ratio, with its decimal: a KDA of 5 reads "5.0", so that it still reads as a ratio. */
  decimal: { minimumFractionDigits: 1, maximumFractionDigits: 1 },
  /** A whole number, with the separators of the thousands. */
  whole: { maximumFractionDigits: 0 },
  /** A number with a decimal only when it is not whole: `1` reads "1", `1.5` reads "1.5". */
  fraction: { minimumFractionDigits: 0, maximumFractionDigits: 1 },
  /** A share written with a percent sign and no decimal; the number held is from 0 to 1. */
  percent: { style: 'percent', maximumFractionDigits: 0 },
} as const satisfies Record<string, Intl.NumberFormatOptions>;

/** The name of a shape of {@link NUMBER_SHAPES}. */
type NumberShape = keyof typeof NUMBER_SHAPES;

/** The shape of the value of each unit. */
const SHAPE_OF_UNIT: Readonly<Record<MetricUnit, NumberShape>> = {
  ratio: 'decimal',
  per_min: 'whole',
  amount: 'whole',
  count: 'whole',
  percent: 'percent',
};

/**
 * The shape of the difference with the habits in each unit that is not a percentage (that one is
 * written in points). The median of the habits is often a half (the middle of an even number of
 * matches), and a half kill written as a whole one would double the gap, so the difference of a count
 * keeps one decimal when it is not whole. A rate per minute and an amount are large enough to be
 * whole, like their values: a decimal on a gap beside "1,020" would be noise.
 */
const SHAPE_OF_GAP: Readonly<Record<Exclude<MetricUnit, 'percent'>, NumberShape>> = {
  ratio: 'decimal',
  per_min: 'whole',
  amount: 'whole',
  count: 'fraction',
};

/**
 * The number formats already made, by language, shape and sign display: making one is far costlier
 * than using it, and a page writes dozens of numbers.
 */
const NUMBER_FORMATS = new Map<string, Intl.NumberFormat>();

/**
 * Write a number.
 *
 * @param value - The number.
 * @param shape - How to write it.
 * @param language - The language of the interface.
 * @param signDisplay - `exceptZero` to write the sign of a number that is not zero (a difference),
 *   `negative` to write only the minus of a negative number (a value). A number that rounds to zero
 *   has no sign either way: never "−0" or "−0.0".
 * @returns The text, with a real minus sign.
 */
function writeNumber(
  value: number,
  shape: NumberShape,
  language: string,
  signDisplay: 'negative' | 'exceptZero' = 'negative',
): string {
  const cacheKey = `${language}|${shape}|${signDisplay}`;
  let format = NUMBER_FORMATS.get(cacheKey);
  if (format === undefined) {
    format = new Intl.NumberFormat(language, { ...NUMBER_SHAPES[shape], signDisplay });
    NUMBER_FORMATS.set(cacheKey, format);
  }
  return format.format(value).replace(HYPHEN_MINUS, MINUS_SIGN);
}

/**
 * Write the value of a metric.
 *
 * A ratio has one decimal, a rate, an amount and a count are whole numbers with the separators of the
 * language, and a percentage (from 0 to 1) has no decimal.
 *
 * @param value - The value, or `null` when it is unknown.
 * @param unit - What the value counts.
 * @param language - The language of the interface.
 * @returns The text, or a dash for an unknown value.
 */
export function formatMetricValue(
  value: number | null,
  unit: MetricUnit,
  language: string,
): string {
  return value === null ? NO_VALUE : writeNumber(value, SHAPE_OF_UNIT[unit], language);
}

/**
 * Write how a value differs from the habits of the player.
 *
 * A relative difference is a signed percentage (`+12 %`). An absolute one is signed in the unit of the
 * metric: a ratio with its decimal (`+0.5`), an amount or a rate per minute as a whole number, a
 * count with a decimal when it is not whole (`+1`, `+0.5`, `+1.4`). A gap between two accuracies is
 * written in points (`−4 pts`), since a percentage of a percentage means little.
 *
 * @param difference - The difference.
 * @param unit - What the value of the metric counts.
 * @param language - The language of the interface.
 * @param t - Translation function, for the points.
 * @returns The text. A difference that rounds to zero is written without sign.
 */
export function formatDifference(
  difference: Difference,
  unit: MetricUnit,
  language: string,
  t: TFunction,
): string {
  if (difference.kind === 'relative') {
    return writeNumber(difference.ratio, 'percent', language, 'exceptZero');
  }
  if (unit === 'percent') {
    // A percentage is held from 0 to 1: 0.04 is four points.
    const points = writeNumber(difference.amount * 100, 'whole', language, 'exceptZero');
    return t('analysis.points', { value: points });
  }
  return writeNumber(difference.amount, SHAPE_OF_GAP[unit], language, 'exceptZero');
}

/**
 * Write the usual value of the player: the median of their earlier matches.
 *
 * It is written with the shapes of the difference with the habits, so that the two agree when they
 * are read side by side: a median of 5.37 deaths is "5.4" next to a gap of "+1.6", not "5" next to
 * "+1.6". A ratio has its decimal, a count a decimal when it is not whole, an amount or a rate per
 * minute is whole, and a percentage (from 0 to 1) is written as a percent.
 *
 * @param value - The median, in the unit the page shows it in.
 * @param unit - What the median counts.
 * @param language - The language of the interface.
 * @returns The text.
 */
export function formatMedian(value: number, unit: MetricUnit, language: string): string {
  return writeNumber(value, unit === 'percent' ? 'percent' : SHAPE_OF_GAP[unit], language);
}

/** The lowest share written as a number (1 %): a share that is less than a percent is "< 1%". */
const LOWEST_SHARE = 0.01;

/** The highest share written as a number (99 %): a share that is more, and not all, is "> 99%". */
const HIGHEST_SHARE = 0.99;

/** Under half a percent, a share rounds to 0 %: it is written "< 1%" instead (when it is over 0). */
const ROUNDS_TO_ZERO_BELOW = 0.005;

/** From 99.5 %, a share rounds to 100 %: it is written "> 99%" instead (when it is under 1). */
const ROUNDS_TO_ALL_FROM = 0.995;

/**
 * Write a share of the damage a source dealt, or the usual share of the player: a percentage with no
 * decimal, written like every percentage of the page (`41%` in English, `41 %` in French).
 *
 * A share is never rounded into a lie about what it is made of, like `percentileText` does for a
 * place: a source that dealt damage never reads `0%` and one that is not all the damage never reads
 * `100%`. A share under half a percent (and over 0) is written `< 1%`, and one of 99.5 % or more (and
 * under 1) is written `> 99%`. Exactly 0 and exactly 1 are exact.
 *
 * @param share - The share, from 0 to 1.
 * @param language - The language of the interface.
 * @returns The text. A share has no sign: a negative one that rounds to zero (which the data does not
 *   give) reads `0%`, never `−0%`.
 */
export function formatShare(share: number, language: string): string {
  if (share > 0 && share < ROUNDS_TO_ZERO_BELOW) {
    return `< ${formatMetricValue(LOWEST_SHARE, 'percent', language)}`;
  }
  if (share >= ROUNDS_TO_ALL_FROM && share < 1) {
    return `> ${formatMetricValue(HIGHEST_SHARE, 'percent', language)}`;
  }
  return formatMetricValue(share, 'percent', language);
}

/**
 * Write how a share differs from the usual one, in points: `+4 pts`, `−10 pts`. A percentage of a
 * percentage means little, so the gap is never a relative one; it is written like the gap between two
 * accuracies ({@link formatDifference}).
 *
 * @param gap - The share minus the usual share, as a share (0.1 is 10 points).
 * @param language - The language of the interface.
 * @param t - Translation function, for the points.
 * @returns The text, with a real minus sign. A gap that rounds to zero is written without sign.
 */
export function formatShareGap(gap: number, language: string, t: TFunction): string {
  return formatDifference({ kind: 'absolute', amount: gap }, 'percent', language, t);
}

/** The lowest place the community data can give: below it, a value is under the first percentile. */
const LOWEST_PERCENTILE = 1;

/** The highest place the community data can give: above it, a value is over the 99th percentile. */
const HIGHEST_PERCENTILE = 99;

/**
 * Write a place among the community.
 *
 * The placement is clamped to 1 and 99 (the community data stops at those points), so the clamps do
 * not tell an exact place but "below the first" and "above the last": they are written `< 1` and
 * `> 99`.
 *
 * @param percentile - The place, from 1 to 99.
 * @returns The text.
 */
export function percentileText(percentile: number): string {
  if (percentile <= LOWEST_PERCENTILE) {
    return `< ${String(LOWEST_PERCENTILE)}`;
  }
  if (percentile >= HIGHEST_PERCENTILE) {
    return `> ${String(HIGHEST_PERCENTILE)}`;
  }
  return String(Math.round(percentile));
}

/**
 * Say a place among the community in words.
 *
 * @param percentile - The place, from 1 to 99.
 * @param t - Translation function.
 * @returns The sentence ("Percentile 84 of your rank").
 */
export function percentileSentence(percentile: number, t: TFunction): string {
  return t('analysis.evidence.percentile', { value: percentileText(percentile) });
}

/**
 * The unit the figures of a phase are written in: the souls and the damage as amounts, the kills as a
 * count. Every phase metric is a rate per minute, but a cell of the phase table shows the total of
 * its phase, and so do its gap with the habits and the usual value of the player: written as rates
 * they would lose their decimals (a median of 3.5 kills would read "4") or gain some (an amount of
 * damage "+1,234.6"). This is the one place that decides it.
 */
export const PHASE_STAT_UNIT: Readonly<Record<PhaseStat, MetricUnit>> = {
  souls: 'amount',
  hero_damage: 'amount',
  objective_damage: 'amount',
  kills: 'count',
};

/**
 * Write what the player did in a phase: the souls and the damage as amounts, the kills as a count
 * ({@link PHASE_STAT_UNIT}).
 *
 * @param total - The total, or `null` when the archive does not tell.
 * @param stat - The figure of the phase.
 * @param language - The language of the interface.
 * @returns The text, or a dash for an unknown total.
 */
export function formatPhaseTotal(total: number | null, stat: PhaseStat, language: string): string {
  return formatMetricValue(total, PHASE_STAT_UNIT[stat], language);
}

/**
 * Write a time of the game as `minutes:seconds` (`10:00`), like the duration of a match elsewhere.
 *
 * @param seconds - The time, in seconds since the start of the match.
 * @returns The text.
 */
export function formatGameTime(seconds: number): string {
  return formatDuration(seconds);
}

/** The figure and the phase a phase metric rates. */
interface PhaseMetricParts {
  /** The figure. */
  readonly stat: PhaseStat;
  /** The phase. */
  readonly phase: Phase;
}

/** The keys of the metrics of the whole match, which have a text of their own. */
const MATCH_METRIC_KEYS: ReadonlySet<MetricKey> = new Set(
  MATCH_METRICS.map((metric) => metric.key),
);

/**
 * The figure and the phase of each phase metric, by key. The key of a cell of the phase table comes
 * from the table of the phase metrics (`phaseMetricKey`), not from the text of the key. The early
 * souls are `souls_at_10min`, a metric of the whole match with its own text, so they are left out.
 */
const PHASE_METRIC_PARTS: ReadonlyMap<MetricKey, PhaseMetricParts> = new Map(
  PHASE_STATS.flatMap((stat) =>
    PHASES.map((phase) => ({ key: phaseMetricKey(stat, phase), stat, phase })),
  )
    .filter(({ key }) => !MATCH_METRIC_KEYS.has(key))
    .map(({ key, stat, phase }) => [key, { stat, phase }] as const),
);

/**
 * Tell a metric of the whole match from a metric of a phase.
 *
 * @param key - The key of a metric.
 * @returns Whether the metric is one of the whole match.
 */
function isMatchMetricKey(key: MetricKey): key is MatchMetricKey {
  return MATCH_METRIC_KEYS.has(key);
}

/**
 * The name of a metric, in the language of the interface.
 *
 * A metric of the whole match has its own text. A metric of a phase is written from its figure and
 * its phase: "Souls in mid", "Âmes en mid".
 *
 * @param key - The key of the metric.
 * @param t - Translation function.
 * @param language - The language of the interface, which lowercases the name of the phase.
 * @returns The name.
 * @throws AppError of kind `unexpected` when the key is neither a metric of the whole match nor one
 *   of a phase (the types allow no other: a key read back from a damaged record).
 */
export function metricLabel(key: MetricKey, t: TFunction, language: string): string {
  if (isMatchMetricKey(key)) {
    return t(`analysis.metric.${key}`);
  }
  const parts = PHASE_METRIC_PARTS.get(key);
  if (parts === undefined) {
    throw new AppError('unexpected', 'No name is known for the metric', { context: { key } });
  }
  return t('analysis.phaseMetric', {
    stat: t(`analysis.phaseStat.${parts.stat}`),
    // "Souls in mid": the phase is a word in the middle of the sentence.
    phase: t(`analysis.phase.${parts.phase}`).toLocaleLowerCase(language),
  });
}
