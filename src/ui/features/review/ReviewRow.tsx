/**
 * One row of the review: a point (a metric, the deaths of a phase, a resistance item, a place among
 * the players…), with the player's figure over the last matches, the figure of the tier above and the
 * gap to it, in how many matches the point was weak or strong, and how it moved since the matches
 * before. Every tab of the review page lists its points with this row.
 *
 * The row is a grid whose columns line up from one row to the next: the arrow of a flagged point, its
 * name (with a picture before it for an item), the player's figure with the number of matches it
 * counts, the tier's figure with its gap, the weak and strong counts, and the progress. A point that
 * the summary flags as a weakness or a strength has its arrow, a faint colour and a hidden word, the
 * same as the metrics of the match page, so that the colour never says it alone. Each figure carries
 * the name of its column for assistive technologies: the header of the columns (`ReviewRowHeader`),
 * which is laid out on the same grid, is for the eye.
 *
 * A figure that is not there is a dash, never a made-up number. The row always says how many matches
 * it counted, even when it shows no figure (too few matches give none): the player then sees how far
 * the point is from having one. The gap to the tier is measured on the player's figure over the
 * matches that were compared with the tier, which can differ from the figure of the first column; when
 * it does, the row says so under the tier's figure, so that the gap visibly refers to the figure it
 * was measured on.
 *
 * The matches behind the row are in its evidence panel ({@link EvidencePanel}): one line for each,
 * most recent first, with the word of the flag after the ones that were weak or strong. A row with no
 * match to list has no panel: it has nothing to open.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewMark } from '../../../core/analysis/review/review-rules';
import type { ReviewMatchValue, ReviewRow as ReviewRowData } from '../../../services/review-view';
import { INSIGHT_STYLE, NO_VALUE } from '../match-detail/analysis-format';
import { EvidencePanel } from '../match-detail/EvidencePanel';
import {
  formatMarks,
  formatProgress,
  formatReviewGap,
  formatReviewValue,
  reviewLabel,
} from './review-format';
import { REVIEW_ROW_GRID } from './review-layout';

/** Props of {@link ReviewRow}. */
export interface ReviewRowProps {
  /** The point, with every figure the row shows. */
  readonly row: ReviewRowData;
  /**
   * A picture to show before the name of the point (the image of a resistance item). It is
   * decorative: the name beside it already names the point, so the caller gives an image with an
   * empty `alt` (or `aria-hidden`), or a screen reader would say the item twice.
   */
  readonly picture?: ReactNode;
}

/** How many milliseconds make a second: the start of a match is in seconds. */
const MS_PER_SECOND = 1_000;

/** What stands between the text of a match in the evidence panel and the word of its flag. */
const EVIDENCE_FLAG_SEPARATOR = '·';

/**
 * The side of the summary that each verdict on a match stands for, which names the word said after a
 * match in the evidence panel (the words of the flags of the analysis).
 */
const SIDE_OF_MARK = {
  weak: 'weakness',
  strong: 'strength',
} as const satisfies Record<ReviewMark, keyof typeof INSIGHT_STYLE>;

/**
 * The look of a row: the grid it shares with the header of the columns, which lines the arrow, the
 * name, the player's figure, the tier with its gap, the marks and the progress up from one row to the
 * next, with rounded corners for its tint and room above and below its figures.
 */
const ROW = `${REVIEW_ROW_GRID} rounded-lg py-1.5`;

/** The classes of the text of a figure that is a small print: the marks, the progress, the gap. */
const SMALL_FIGURE = 'text-xs text-fg-muted tabular-nums';

/**
 * A figure of a row, with the name of its column for assistive technologies: a bare "1.3" would not
 * say whether it is the player's figure, the tier's or the gap.
 *
 * @param column - The name of the column.
 * @param figure - The figure, already written.
 * @param className - The classes of the text.
 * @returns The line.
 */
function renderFigure(column: string, figure: string, className: string) {
  return (
    <p className={className}>
      <span className="sr-only">{column} </span>
      {figure}
    </p>
  );
}

/**
 * The player's figure with the number of matches it counts.
 *
 * @param row - The point.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The figure, then how many matches it counts: a dash for a figure that is not there, and
 *   the count all the same, so that the player sees how many matches the point still needs.
 */
function renderPlayerCell(row: ReviewRowData, t: TFunction, language: string) {
  return (
    <div className="text-right">
      {renderFigure(
        t('review.columns.you'),
        formatReviewValue(row.value, row.unit, language, t),
        row.value === null
          ? 'text-sm text-fg-muted tabular-nums'
          : 'text-sm font-semibold tabular-nums',
      )}
      <p className={SMALL_FIGURE}>{t('review.count', { count: row.count })}</p>
    </div>
  );
}

/**
 * Say the figure of the player that the gap to the tier was measured on, when it is not the one of
 * the first column.
 *
 * The comparison with the tier is made over the matches that have tier data, on the stretch of the
 * match the tier's figure covers, so the figure it uses can differ from the one over all the matches.
 * Figures are compared once written, so that a difference the format rounds away says nothing.
 *
 * @param row - The point.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The sentence, or `null` when the gap was measured on the figure of the first column (or
 *   when there is no gap).
 */
function comparedLine(row: ReviewRowData, t: TFunction, language: string): string | null {
  if (row.reference === null || row.comparedValue === null) {
    return null;
  }
  const compared = formatReviewValue(row.comparedValue, row.unit, language, t);
  return compared === formatReviewValue(row.value, row.unit, language, t)
    ? null
    : t('review.compared', { value: compared });
}

/**
 * The figure of the tier above, with the gap to it and the figure the gap was measured on.
 *
 * @param row - The point.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The figure and its gap, and the figure of the player the gap was measured on when it is
 *   not the one of the first column; a dash, with no gap, for a point that has no figure of the tier.
 */
function renderTierCell(row: ReviewRowData, t: TFunction, language: string) {
  if (row.reference === null) {
    return renderFigure(t('review.columns.tier'), NO_VALUE, 'text-sm text-fg-muted tabular-nums');
  }
  const compared = comparedLine(row, t, language);
  return (
    <div>
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm tabular-nums">
        <span>
          <span className="sr-only">{t('review.columns.tier')} </span>
          {formatReviewValue(row.reference, row.unit, language, t)}
        </span>
        {row.difference !== null && (
          <>
            {/* The space is not drawn in a flex line, but it keeps the two figures apart in the text
                that a screen reader or a copy reads: "1.3 Gap +0.3", not "1.3Gap +0.3". */}{' '}
            <span className="text-xs text-fg-muted">
              <span className="sr-only">{t('review.columns.gap')} </span>
              {formatReviewGap(row.difference, row.unit, language, t)}
            </span>
          </>
        )}
      </p>
      {compared !== null && <p className={SMALL_FIGURE}>{compared}</p>}
    </div>
  );
}

/**
 * The line of one match in the evidence panel.
 *
 * @param match - The match.
 * @param unit - What the value of the point counts.
 * @param dateFormat - How the start of the match is written.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The date and the value of the match, and the word of the flag after a match that was weak
 *   or strong.
 */
function matchLine(
  match: ReviewMatchValue,
  unit: ReviewRowData['unit'],
  dateFormat: Intl.DateTimeFormat,
  t: TFunction,
  language: string,
): string {
  const line = t('review.evidence.match', {
    date: dateFormat.format(match.startTime * MS_PER_SECOND),
    value: formatReviewValue(match.value, unit, language, t),
  });
  return match.mark === null
    ? line
    : `${line} ${EVIDENCE_FLAG_SEPARATOR} ${t(`analysis.flag.${SIDE_OF_MARK[match.mark]}`)}`;
}

/**
 * Tell apart the lines of a list that are the same text, by numbering the repeats.
 *
 * @param lines - The lines, in order.
 * @returns The same lines: the first of each text as it is, the next ones with their number after
 *   it (`(2)`, `(3)`…). A number is not a word of a language, so it is written the same in both.
 */
function numberRepeats(lines: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const occurrence = (seen.get(line) ?? 0) + 1;
    seen.set(line, occurrence);
    return occurrence === 1 ? line : `${line} (${String(occurrence)})`;
  });
}

/**
 * The lines of the evidence panel of a row: one for each of the matches, most recent first as the
 * row gives them, and all different from one another, since a panel keys its lines by their text.
 *
 * A match is dated by its day. Two matches of one day with the same value (and the same flag) would
 * then be the same line, so such lines are written with the time of the match too. Matches that
 * start in the same minute with the same value and flag, which the data of one player should not
 * hold but nothing here rules out, are still the same line then: the repeats are numbered, so that no
 * match is ever lost from the panel or shares its key with another.
 *
 * @param row - The point.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The lines, all different from one another.
 */
function evidenceLines(row: ReviewRowData, t: TFunction, language: string): string[] {
  const day = new Intl.DateTimeFormat(language, { dateStyle: 'medium' });
  const dayAndTime = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });
  const dated = row.matches.map((match) => ({
    match,
    line: matchLine(match, row.unit, day, t, language),
  }));
  return numberRepeats(
    dated.map(({ match, line }) =>
      dated.filter((other) => other.line === line).length === 1
        ? line
        : matchLine(match, row.unit, dayAndTime, t, language),
    ),
  );
}

/**
 * One row of the review.
 *
 * @returns The item of the list, with the evidence of the point behind it when it has matches to
 *   list. The panel is anchored at the right edge of the row, so that it leaves the names of the rows
 *   below free to the pointer.
 */
export function ReviewRow({ row, picture }: ReviewRowProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  // What marks a point of the summary: the arrow and the colours, and the word.
  const mark = row.side === null ? null : INSIGHT_STYLE[row.side];
  const label = reviewLabel(row.subject, t, language);
  const marks = formatMarks(row, t);

  const cells = (
    <div className={mark === null ? ROW : `${ROW} ${mark.tint}`}>
      <span aria-hidden="true" className={mark?.text}>
        {mark?.arrow}
      </span>
      <div className="flex min-w-0 items-center gap-2.5">
        {picture}
        <span className="text-sm">
          {label}
          {row.side !== null && (
            <>
              {' '}
              <span className="sr-only">{t(`analysis.flag.${row.side}`)}</span>
            </>
          )}
        </span>
      </div>
      {renderPlayerCell(row, t, language)}
      {renderTierCell(row, t, language)}
      {renderFigure(t('review.columns.marks'), marks === '' ? NO_VALUE : marks, SMALL_FIGURE)}
      {renderFigure(t('review.columns.progress'), formatProgress(row, language, t), SMALL_FIGURE)}
    </div>
  );

  return (
    <li>
      {row.matches.length === 0 ? (
        cells
      ) : (
        <EvidencePanel label={label} lines={evidenceLines(row, t, language)} placement="end">
          {cells}
        </EvidencePanel>
      )}
    </li>
  );
}
