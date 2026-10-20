/**
 * The evidence behind a metric of the match page: the numbers a row or a cell is built from.
 *
 * The page shows a gauge and a gap; the panel gives the figures they come from: the exact place among
 * the rank, the usual value of the player and how many matches make it, how far the comparison can
 * be trusted and, for a metric of the summary, why it was picked. The panel opens when the pointer is
 * over the wrapper and when the keyboard focus is on it, so that it is not for the mouse alone. The
 * Escape key closes it until the pointer and the focus have both left.
 *
 * Showing and hiding is left to the style sheet (the `group-hover` and `group-focus-visible`
 * variants): the panel is always in the page, so that it is the description of the wrapper for
 * assistive technologies whether it is on screen or not. The wrapper is named after the metric. The
 * wrapper itself takes the focus and has no focusable child, so `focus-visible` is what a keyboard
 * gives it and a click does not: a click on a row no longer pins its panel over the rows below.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { useId, useReducer, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { MetricRowView } from '../../../services/analysis-view';
import {
  formatMedian as formatMedianInUnit,
  metricLabel,
  percentileSentence,
} from './analysis-format';

/** Which edge of the wrapper the panel is anchored to. */
export type PanelPlacement = 'start' | 'end';

/** The classes that anchor the panel, by placement. Each is a complete literal for Tailwind. */
const PLACEMENT_CLASSES: Readonly<Record<PanelPlacement, string>> = {
  start: 'left-0',
  end: 'right-0 left-auto',
};

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
   * Which edge of the wrapper the panel is anchored to: `start` (the default) opens it under the
   * wrapper from its left edge, `end` from its right edge. A row of a list uses `end`, so that the
   * panel, which hangs over the rows below, leaves their names free: a pointer going down the names
   * then reaches the next row instead of staying on the panel of the one above.
   */
  readonly placement?: PanelPlacement;
}

/**
 * What decides whether the panel is on screen: where the pointer and the focus are, and whether the
 * Escape key closed the panel since either came.
 */
interface PanelState {
  /** Whether the pointer is over the wrapper (or its panel). */
  readonly hovered: boolean;
  /** Whether the focus is on the wrapper. */
  readonly focused: boolean;
  /** Whether Escape closed the panel, which stays closed until neither the pointer nor the focus is there. */
  readonly dismissed: boolean;
}

/** What happens to the panel: the pointer and the focus coming and leaving, and the Escape key. */
type PanelEvent = 'pointer_enter' | 'pointer_leave' | 'focus' | 'blur' | 'escape';

/** The state of a panel nobody has reached. */
const PANEL_CLOSED: PanelState = { hovered: false, focused: false, dismissed: false };

/**
 * Work out the state of the panel after something happened to it.
 *
 * The state is one value changed by a reducer, and not three flags, because the pointer and the
 * focus can leave one just after the other: each change must be read against the latest state, not
 * against the one a handler saw when it was made.
 *
 * @param state - The state before.
 * @param event - What happened.
 * @returns The state after. An Escape that closed the panel holds while the pointer or the focus is
 *   still there, and is forgotten when both have left, so that the panel opens again when either
 *   comes back.
 */
function nextPanelState(state: PanelState, event: PanelEvent): PanelState {
  switch (event) {
    case 'pointer_enter':
      return { ...state, hovered: true };
    case 'pointer_leave':
      return { ...state, hovered: false, dismissed: state.dismissed && state.focused };
    case 'focus':
      return { ...state, focused: true };
    case 'blur':
      return { ...state, focused: false, dismissed: state.dismissed && state.hovered };
    case 'escape':
      return { ...state, dismissed: true };
  }
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
  const panelId = useId();
  const [panel, send] = useReducer(nextPanelState, PANEL_CLOSED);
  const writeMedian =
    formatMedian ?? ((median: number) => formatMedianInUnit(median, row.unit, i18n.language));

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      send('escape');
    }
  };

  return (
    // A row of figures is no control, but the keyboard has to reach it for the panel to open without
    // a pointer, and Escape has to close the panel from there. The two rules disabled here are for
    // the cases where focus means "something to press", which this is not.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      role="group"
      aria-label={metricLabel(row.key, t, i18n.language)}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      aria-describedby={panelId}
      onKeyDown={handleKeyDown}
      onFocus={() => {
        send('focus');
      }}
      onBlur={() => {
        send('blur');
      }}
      onMouseEnter={() => {
        send('pointer_enter');
      }}
      onMouseLeave={() => {
        send('pointer_leave');
      }}
      className="group relative rounded-lg"
    >
      {children}
      <div
        id={panelId}
        role="tooltip"
        className={`absolute top-full ${PLACEMENT_CLASSES[placement]} z-20 w-max max-w-[min(18rem,100%)] space-y-1 rounded-lg border border-border bg-surface-raised p-3 text-xs leading-normal shadow-lg ${
          panel.dismissed ? 'hidden' : 'hidden group-focus-visible:block group-hover:block'
        }`}
      >
        {evidenceLines(row, t, writeMedian).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </div>
  );
}
