/**
 * The list of rows of the review: a box, the header of the columns, and the rows under it. Every tab
 * of the review page lists its points with it, so that they all look and line up the same.
 *
 * The box is the one thing that decides how the header and the rows line up: they stand in it side by
 * side, share its padding, and are laid out on the same grid (`REVIEW_ROW_GRID`), so that each name
 * stays over its figures. The list inside it adds no padding of its own, and neither does a caller
 * around the box: the budget of the grid (`./review-layout`) counts the border and the padding of
 * this box, and any other padding comes out of the name column of the rows.
 *
 * The rows are listed in the order they are given: the list never sorts, filters or cuts them. A row
 * is keyed by its point (`reviewRowKey`), which no language changes and no two points share, so that
 * a list may hold the rows of several tabs and of several items.
 *
 * A list of the summary links the name of each row to the tab of its point (`reviewTabOf`); the
 * lists of the other tabs are already in that tab, and do not.
 *
 * A row about a resistance item (the minute the player buys it, how often they buy it) shows the
 * picture of the item before its name, wherever the list stands, so that the item is known at a
 * glance. The picture is decorative (an empty `alt`: the name beside it says the item), and an item
 * the catalogue has no picture for, or whose picture cannot be loaded, keeps a neutral square, so that
 * the names line up. No other row has a picture or a place for one.
 *
 * @packageDocumentation
 */
import type { ReviewRow as ReviewRowData } from '../../../services/review-view';
import { GamePicture } from '../../components/GamePicture';
import { reviewRowKey, reviewTabOf } from './review-format';
import { REVIEW_LIST_BOX } from './review-layout';
import { ReviewRow } from './ReviewRow';
import { ReviewRowHeader } from './ReviewRowHeader';

/** Props of {@link ReviewRowList}. */
export interface ReviewRowListProps {
  /** The points to list, in the order to show them. */
  readonly rows: readonly ReviewRowData[];
  /**
   * Whether the name of each row links to the tab of its point: the summary's do. `false` by
   * default.
   */
  readonly linked?: boolean;
}

/**
 * The picture that stands before the name of a row.
 *
 * It is the size of the pictures of the summary, so that an item is the same wherever the review
 * lists it, and takes the same room from the name beside it.
 *
 * @param row - The row.
 * @returns The picture of the item for a row about a resistance item, which `GamePicture` replaces by
 *   a neutral square when the catalogue has no image or it cannot be loaded; nothing for any other
 *   point.
 */
function pictureOf(row: ReviewRowData) {
  const { subject } = row;
  if (subject.kind !== 'resistance_minute' && subject.kind !== 'resistance_rate') {
    return undefined;
  }
  return <GamePicture src={subject.item.imageUrl} size="small" fit="contain" fallback="square" />;
}

/**
 * A list of rows of the review, under the header of their columns.
 *
 * @returns The box with the header and the list; nothing for no row, since a header over an empty
 *   list says nothing (the caller says in a sentence that there is nothing to list).
 */
export function ReviewRowList({ rows, linked = false }: ReviewRowListProps) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <div className={REVIEW_LIST_BOX}>
      <ReviewRowHeader />
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <ReviewRow
            key={reviewRowKey(row.subject)}
            row={row}
            picture={pictureOf(row)}
            {...(linked ? { tab: reviewTabOf(row.subject) } : {})}
          />
        ))}
      </ul>
    </div>
  );
}
