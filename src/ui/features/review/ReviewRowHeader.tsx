/**
 * The header of the columns of the review: the names of the figures of a row, in one line above a
 * list of rows.
 *
 * It is laid out on the grid the rows are (`REVIEW_ROW_GRID`), so that each name stands above its
 * figures: the player's figure, the tier above with its gap (they share one column, since a row
 * writes them side by side), the weak and strong counts, and the progress. The columns of the arrow
 * and of the name have no caption. The names are the ones each figure of a row carries for assistive
 * technologies, so the header is for the eye only and is hidden from them, or they would read every
 * name twice.
 *
 * The header and the rows line up when they sit in the same box: place it inside the container of
 * the list, above the rows, not outside the padding the container gives them.
 *
 * @packageDocumentation
 */
import { useTranslation } from 'react-i18next';
import { REVIEW_ROW_GRID } from './review-layout';

/** What stands between the names of the tier and of the gap, which share a column. */
const TIER_GAP_SEPARATOR = '·';

/**
 * The names of the columns of the review rows.
 *
 * @returns The header, hidden from assistive technologies.
 */
export function ReviewRowHeader() {
  const { t } = useTranslation();

  return (
    <div aria-hidden="true" className={`${REVIEW_ROW_GRID} pb-1 text-xs font-medium text-fg-muted`}>
      {/* The columns of the arrow and of the name have no caption: empty cells keep the others in
          their columns. */}
      <span />
      <span />
      {/* The player's figures are right-aligned in a row, and so is their name. */}
      <span className="text-right">{t('review.columns.you')}</span>
      <span>{`${t('review.columns.tier')} ${TIER_GAP_SEPARATOR} ${t('review.columns.gap')}`}</span>
      <span>{t('review.columns.marks')}</span>
      <span>{t('review.columns.progress')}</span>
    </div>
  );
}
