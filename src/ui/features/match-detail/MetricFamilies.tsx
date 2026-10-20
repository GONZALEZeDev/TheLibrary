/**
 * The metrics of a match by family (combat, survival, farm, support, objectives, laning), under the
 * line that says which players they are compared with.
 *
 * A row gives the name of the metric, its value, where it stands among the community (a gauge, or the
 * distance to the average of the rank for a metric read on a curve) and how it differs from the
 * habits of the player. A metric of the summary has its arrow, a faint colour and a hidden word, so
 * that the colour never says it alone. The numbers behind a row are in its evidence panel
 * ({@link Evidence}).
 *
 * A comparison that is not there is a dash in the row, and the line above the families says why
 * (loading, or none for now), once. A metric with no value in the match has a dash in each column:
 * nothing will fill it for this match.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DURATION_WINDOWS,
  RANK_TIER_NAMES,
  type DurationWindow,
} from '../../../core/analysis/cohort';
import type { CommunityState, FamilyView, MetricRowView } from '../../../services/analysis-view';
import {
  formatDifference,
  formatMetricValue,
  INSIGHT_STYLE,
  metricLabel,
  NO_VALUE,
} from './analysis-format';
import { Evidence } from './Evidence';
import { PercentileGauge } from './PercentileGauge';

/** Props of {@link MetricFamilies}. */
export interface MetricFamiliesProps {
  /** The metrics of the match by family, in the order they are shown. */
  readonly families: readonly FamilyView[];
  /** Where the comparison with the community stands. */
  readonly community: CommunityState;
  /** Whether the community data is being downloaded now: a comparison that is missing is coming. */
  readonly communityLoading: boolean;
}

/** How many seconds make a minute. */
const SECONDS_PER_MINUTE = 60;

/**
 * The look of a row: the arrow, the name, the value, the place among the community and the gap with
 * the habits, in columns that line up from one row to the next. The name takes what the others leave.
 */
const ROW =
  'grid grid-cols-[1.25rem_minmax(0,1fr)_4.5rem_minmax(0,11rem)_minmax(0,9rem)] items-center gap-x-3 rounded-lg px-3 py-1.5';

/**
 * Say which match lengths a cohort holds.
 *
 * @param window - The duration window of the cohort.
 * @param t - Translation function.
 * @returns The text: the matches under 20 minutes, a range of minutes, or the matches of 45 minutes
 *   and longer. The English strings say "matches" themselves, where the sentence reads naturally
 *   ("matches under 20 min", "25–30 min matches"); the French cohort sentences say "parties de" before
 *   the length.
 */
function windowText(window: DurationWindow, t: TFunction): string {
  if (window.minS === DURATION_WINDOWS[0]?.minS) {
    return t('analysis.window.under');
  }
  if (window.minS === DURATION_WINDOWS.at(-1)?.minS) {
    return t('analysis.window.over');
  }
  return t('analysis.window.range', {
    from: String(window.minS / SECONDS_PER_MINUTE),
    // The bounds of a window are inclusive: it ends one second before the next one starts.
    to: String((window.maxS + 1) / SECONDS_PER_MINUTE),
  });
}

/**
 * Say which players the match is compared with, when the comparison is available.
 *
 * @param community - The comparison, which is available.
 * @param t - Translation function.
 * @param language - The language of the interface, which writes the date.
 * @returns The sentence: the rank (or every rank, or every rank because the rank has too few
 *   matches), the length of the matches, and the date of the data when it is a day old or more.
 */
function availableSentence(
  community: Extract<CommunityState, { readonly kind: 'available' }>,
  t: TFunction,
  language: string,
): string {
  const { used, fallback, stale, fetchedAt } = community;
  const window = windowText(used.window, t);
  let sentence: string;
  if (fallback) {
    sentence = t('analysis.cohort.fallback', { window });
  } else if (used.rank.kind === 'tier') {
    // The names of the ranks stay in English, like the game's, in both languages.
    sentence = t('analysis.cohort.tier', {
      tier: RANK_TIER_NAMES[used.rank.tier] ?? String(used.rank.tier),
      window,
    });
  } else {
    sentence = t('analysis.cohort.all', { window });
  }
  if (!stale) {
    return sentence;
  }
  const date = new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(fetchedAt);
  return `${sentence} ${t('analysis.cohort.stale', { date })}`;
}

/**
 * What a comparison with the community that is not there says: it is on its way, or it will not come.
 *
 * @param communityLoading - Whether the data is being downloaded now.
 * @param t - Translation function.
 * @returns The text.
 */
function missingText(communityLoading: boolean, t: TFunction): string {
  return communityLoading ? t('analysis.cohort.loading') : t('analysis.cohort.unavailable');
}

/**
 * Say where the comparison with the community stands.
 *
 * @param community - Where the comparison stands.
 * @param communityLoading - Whether the data is being downloaded now.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The sentence: which players the match is compared with, or why it is not compared.
 */
function cohortText(
  community: CommunityState,
  communityLoading: boolean,
  t: TFunction,
  language: string,
): string {
  switch (community.kind) {
    case 'available':
      return availableSentence(community, t, language);
    case 'missing':
      return missingText(communityLoading, t);
    case 'unavailable':
      return t('analysis.cohort.unavailable');
  }
}

/**
 * The place of a metric among the community, as a row shows it.
 *
 * The sentence that says why a comparison is not there (it is loading, or it will not come) is said
 * once, in the line above the families: a row only leaves its cell blank with a dash.
 *
 * @param row - The metric.
 * @param t - Translation function.
 * @returns A gauge for a metric placed among the percentiles of the community; the distance to the
 *   average of the rank, with no gauge, for a metric read on the curve of the community (a place on
 *   a curve is approximate, and the row does not announce a percentile); a sentence for a metric the
 *   community has no reference for; a dash for a comparison that is not there, and for a metric with
 *   no value in this match, which has nothing to compare.
 */
function renderCommunityCell(row: MetricRowView, t: TFunction) {
  const { community } = row;
  if (row.value === null) {
    return <p className="text-xs text-fg-muted">{NO_VALUE}</p>;
  }
  switch (community.kind) {
    case 'percentile':
      return <PercentileGauge percentile={community.percentile} />;
    case 'curve':
      return <p className="text-xs text-fg-muted">{t(`analysis.curve.${community.label}`)}</p>;
    case 'none':
      return <p className="text-xs text-fg-muted">{t('analysis.noComparison')}</p>;
    case 'missing':
      return <p className="text-xs text-fg-muted">{NO_VALUE}</p>;
  }
}

/**
 * How a row differs from the habits of the player, as the last column shows it.
 *
 * @param row - The metric.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The gap; a sentence when the player has too few earlier matches to have habits; a dash for
 *   a metric with no value in this match, which has nothing to compare.
 */
function habitsText(row: MetricRowView, t: TFunction, language: string): string {
  const { personal } = row;
  if (row.value === null) {
    return NO_VALUE;
  }
  return personal === null
    ? t('analysis.personal.notEnough')
    : t('analysis.personal.difference', {
        difference: formatDifference(personal.difference, row.unit, language, t),
      });
}

/**
 * One row: a metric of the match.
 *
 * @param row - The metric.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The item of the list, with the evidence of the metric behind it. The panel of the
 *   evidence is anchored at the right edge of the row, so that it leaves the names of the rows below
 *   free to the pointer.
 */
function renderRow(row: MetricRowView, t: TFunction, language: string) {
  const { insight } = row;
  // What marks a metric of the summary: the arrow and the colours, and the word.
  const mark = insight === null ? null : INSIGHT_STYLE[insight.side];
  return (
    <li key={row.key}>
      <Evidence row={row} placement="end">
        <div className={mark === null ? ROW : `${ROW} ${mark.tint}`}>
          <span aria-hidden="true" className={mark?.text}>
            {mark?.arrow}
          </span>
          <span className="text-sm">
            {metricLabel(row.key, t, language)}
            {insight !== null && (
              <span className="sr-only">{t(`analysis.flag.${insight.side}`)}</span>
            )}
          </span>
          <span className="text-right text-sm font-semibold tabular-nums">
            {formatMetricValue(row.value, row.unit, language)}
          </span>
          {renderCommunityCell(row, t)}
          <span className="text-xs text-fg-muted tabular-nums">{habitsText(row, t, language)}</span>
        </div>
      </Evidence>
    </li>
  );
}

/**
 * The metrics of the match by family, under the line that says what they are compared with.
 *
 * @returns The line and the families.
 */
export function MetricFamilies({ families, community, communityLoading }: MetricFamiliesProps) {
  const { t, i18n } = useTranslation();
  const idPrefix = useId();

  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">
        {cohortText(community, communityLoading, t, i18n.language)}
      </p>
      {/* On a wide window the families flow in two columns; below it every row would be too tight
          for its sentences, so they are stacked. */}
      <div className="@container">
        <div className="@7xl:columns-2 @7xl:gap-x-4">
          {families.map(({ family, rows }) => {
            const headingId = `${idPrefix}-${family}`;
            return (
              <section
                key={family}
                aria-labelledby={headingId}
                className="mb-4 break-inside-avoid last:mb-0"
              >
                <h3
                  id={headingId}
                  className="mb-1.5 ml-0.5 text-xs font-medium tracking-wide text-fg-muted uppercase"
                >
                  {t(`analysis.family.${family}`)}
                </h3>
                <ul className="divide-y divide-border rounded-xl border border-border bg-surface p-1">
                  {rows.map((row) => renderRow(row, t, i18n.language))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
