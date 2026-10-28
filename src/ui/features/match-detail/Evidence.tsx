/**
 * The evidence behind a metric of the match page: the numbers a row or a cell is built from.
 *
 * The page shows a gauge and a gap; the panel gives the figures they come from: the exact place among
 * the rank, the usual value of the player and how many matches make it, how far the comparison can
 * be trusted and, for a metric of the summary, why it was picked. This file decides what the panel
 * says of a metric and names the wrapper after it; showing the panel (on the pointer, on the focus, and
 * the Escape key that closes it) is the business of {@link EvidencePanel}, which the damage tab uses
 * for its own lines.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { MetricRowView } from '../../../services/analysis-view';
import {
  formatMedian as formatMedianInUnit,
  metricLabel,
  percentileSentence,
} from './analysis-format';
import { EvidencePanel, type PanelPlacement } from './EvidencePanel';

/** Props of {@link Evidence}. */
export interface EvidenceProps {
  /** The metric whose evidence the panel gives. */
  readonly row: MetricRowView;
  /** What the panel is about: the row or the cell that shows the metric. */
  readonly children: ReactNode;
  /**
   * How the usual value of the player is written. By default as the unit of the metric says
   * (`formatMedian` of `analysis-format`); a cell whose median is in another unit than the metric's
   * (the total of a phase, for a rate per minute) gives its own.
   */
  readonly formatMedian?: (median: number) => string;
  /**
   * Which edge of the wrapper the panel is anchored to: `start` (the default) lines it up with the
   * left edge of the wrapper, `end` with its right edge. A row of a list uses `end`, so that the
   * panel, which hangs over the rows below, leaves their names free: a pointer going down the names
   * then reaches the next row instead of staying on the panel of the one above.
   */
  readonly placement?: PanelPlacement;
}

/**
 * What the panel says of the place of the metric among the community.
 *
 * @param row - The metric.
 * @param t - Translation function.
 * @returns The sentence, or `null` when there is nothing to say: the community gives no comparison
 *   for this metric now (the cohort line above the families says why), and the row shows a dash.
 */
function communityLine(row: MetricRowView, t: TFunction): string | null {
  const { community } = row;
  switch (community.kind) {
    case 'percentile': {
      const place = percentileSentence(community.percentile, t);
      // The place is a raw one: tell the player when a high place is the worse side.
      return row.better === 'lower' ? `${place} ${t('analysis.evidence.lowerIsBetter')}` : place;
    }
    case 'curve':
      return t(`analysis.curve.${community.label}`);
    case 'none':
      return t('analysis.noComparison');
    case 'missing':
      return null;
  }
}

/**
 * Why a metric is in the summary.
 *
 * @param row - The metric.
 * @param t - Translation function.
 * @returns The sentence, or `null` for a metric that is not in the summary (or, which the selection
 *   does not give, one with neither reference).
 */
function reasonLine(row: MetricRowView, t: TFunction): string | null {
  if (row.insight === null) {
    return null;
  }
  const byCommunity = row.community.kind === 'percentile' || row.community.kind === 'curve';
  const byPersonal = row.personal !== null && row.personal.z !== null;
  if (byCommunity && byPersonal) {
    return t('analysis.reason.both');
  }
  if (byCommunity) {
    return t('analysis.reason.community');
  }
  return byPersonal ? t('analysis.reason.personal') : null;
}

/**
 * The lines of the panel, in reading order.
 *
 * @param row - The metric.
 * @param t - Translation function.
 * @param writeMedian - How the usual value of the player is written.
 * @returns The lines: the place in the rank, the usual value and the matches it is made of (or that
 *   there are too few), the confidence, and the reason for the summary. Each only when it applies.
 *   A metric with no value in this match has nothing to compare, and nothing will fill it: its panel
 *   gives the confidence alone, with no sentence that tells the player to wait.
 */
function evidenceLines(
  row: MetricRowView,
  t: TFunction,
  writeMedian: (median: number) => string,
): string[] {
  const { personal } = row;
  if (row.value === null) {
    return [t(`analysis.confidence.${row.confidence}`)];
  }
  return [
    communityLine(row, t),
    ...(personal === null
      ? [t('analysis.personal.notEnough')]
      : [
          t('analysis.personal.median', { value: writeMedian(personal.median) }),
          t('analysis.personal.matches', { count: personal.count }),
        ]),
    t(`analysis.confidence.${row.confidence}`),
    reasonLine(row, t),
  ].filter((line) => line !== null);
}

/**
 * A row or a cell of the match page, with the panel of the evidence behind it.
 *
 * @returns A wrapper that takes the keyboard focus, named after the metric, holding what it is given
 *   and the panel, which describes the wrapper.
 */
export function Evidence({ row, children, formatMedian, placement = 'start' }: EvidenceProps) {
  const { t, i18n } = useTranslation();
  const writeMedian =
    formatMedian ?? ((median: number) => formatMedianInUnit(median, row.unit, i18n.language));

  return (
    <EvidencePanel
      label={metricLabel(row.key, t, i18n.language)}
      lines={evidenceLines(row, t, writeMedian)}
      placement={placement}
    >
      {children}
    </EvidencePanel>
  );
}
