/**
 * The summary of a match: the metrics that stood out for the better (its strengths) and for the worse
 * (its weaknesses), as pills, strengths first.
 *
 * A pill is an arrow, the name of the metric and a word that tells a strength from a weakness. The
 * arrow is for the eye and the word for assistive technologies: the colour never says it alone. A
 * label stands before the pills and says what they are: the strengths and the weaknesses of this
 * match. It is a plain text, not a heading (the section of the analysis has its own title), and it
 * names the group that holds the label and the lists.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { Insight } from '../../../core/analysis/insights/insights';
import { INSIGHT_STYLE, metricLabel } from './analysis-format';

/** Props of {@link InsightSummary}. */
export interface InsightSummaryProps {
  /** The metrics that stood out for the better, strongest first. */
  readonly strengths: readonly Insight[];
  /** The metrics that stood out for the worse, strongest first. */
  readonly weaknesses: readonly Insight[];
}

/**
 * The pills of one side of the summary.
 *
 * @param insights - The strengths, or the weaknesses.
 * @param name - What the list is called, for assistive technologies.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The list, or nothing when there is no pill: an empty list tells nothing.
 */
function renderPills(insights: readonly Insight[], name: string, t: TFunction, language: string) {
  if (insights.length === 0) {
    return null;
  }
  return (
    <ul aria-label={name} className="flex flex-wrap gap-2">
      {insights.map((insight) => {
        const style = INSIGHT_STYLE[insight.side];
        return (
          <li
            key={insight.key}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-sm"
          >
            <span aria-hidden="true" className={style.text}>
              {style.arrow}
            </span>
            <span>{metricLabel(insight.key, t, language)}</span>
            <span className="sr-only">{t(`analysis.flag.${insight.side}`)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The strengths and the weaknesses of a match.
 *
 * @returns A group that starts with its label, then holds the two lists of pills side by side, or a
 *   sentence when nothing stood out in the match. On a wide window the label is at the left of the
 *   pills and the pills wrap to its right; on a narrow one the pills no longer fit beside it and
 *   stand under it. The label never shrinks.
 */
export function InsightSummary({ strengths, weaknesses }: InsightSummaryProps) {
  const { t, i18n } = useTranslation();
  const labelId = useId();
  const nothingStandsOut = strengths.length === 0 && weaknesses.length === 0;

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="flex flex-wrap items-baseline gap-x-4 gap-y-2"
    >
      <p id={labelId} className="max-w-full shrink-0 text-sm font-medium text-fg-muted">
        {t('analysis.summaryTitle')}
      </p>
      {nothingStandsOut ? (
        <p className="text-sm text-fg-muted">{t('analysis.noInsight')}</p>
      ) : (
        // The basis is the least width the pills need to stay beside the label: under it they wrap
        // to the next line. Over it they take what the label leaves.
        <div className="flex min-w-0 grow basis-64 flex-wrap gap-x-6 gap-y-2">
          {renderPills(strengths, t('analysis.strengths'), t, i18n.language)}
          {renderPills(weaknesses, t('analysis.weaknesses'), t, i18n.language)}
        </div>
      )}
    </div>
  );
}
