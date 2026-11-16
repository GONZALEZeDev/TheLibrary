/**
 * The match history list: every match of the history, newest first, grouped under a row for each
 * local day ("Today", "Yesterday", then the date). A match row shows the time, the type, the hero,
 * the result, the K/D/A, the duration and where the archive of the match detail stands.
 *
 * **Markup.** The list is a native `<table>`: its header row names the columns, a day row is a row
 * header (`<th scope="row">`) spanning every column, and a screen reader moves through it with its
 * table commands. A native table rather than a grid of `div`s with table roles, because the whole
 * row is clickable: a `<tr>` takes a click handler as it is, while a `div` with the `row` role would
 * have to become a focus stop of its own, next to the link.
 *
 * **Navigation.** The time of each match links to the match page, and so does the rest of its row
 * for the mouse: the link stays the row's only link and the only stop of the keyboard. While a
 * synchronisation runs, a match the queue has never tried yet is locked: its link is disabled (it
 * keeps its place and the focus of the keyboard, but opens nothing), the row takes no click, and its
 * detail column says that it is in progress, until the queue has archived it or the synchronisation
 * ends. Its page would only say that the detail is on its way.
 *
 * **Rows.** The match rows of a day alternate between a tinted background and none, the first match
 * of each day tinted, so that each match reads as one line from the time to the detail. The tint is
 * worked out from the place of the match in its day, not from the rows the window renders, so a row
 * keeps its tint as the window moves.
 *
 * **Windowing.** A history holds hundreds or thousands of matches, so only the rows near the visible
 * part of `<main>` (the element that scrolls the pages) are rendered (`useWindowedRows`). The rows
 * left out above and below are replaced by two spacer rows of the same height, so the scrollbar and
 * the position of every row are those of the full list. Every row is exactly
 * {@link HISTORY_ROW_HEIGHT_PX} tall, the day rows included, as the hook needs one height. The table
 * tells a screen reader the full number of rows (`aria-rowcount`) and the place of each rendered one
 * (`aria-rowindex`), and each row keeps its key (the match id, the day) as the window moves, so a
 * screen reader keeps its place.
 *
 * **Files.** This component is the table and its windowing. The rows themselves are in
 * `./HistoryListRows` (memoised, so a row the window keeps is not drawn again), the making of the
 * rows and the layout they share in `./history-rows`, and the measure of where the list sits in
 * `<main>` in `./use-list-offset`.
 *
 * @packageDocumentation
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { HeroId } from '../../../core/domain/hero';
import type { MatchListItem } from '../../../services/matches.service';
import {
  CELL,
  COLUMN_COUNT,
  COLUMNS,
  HISTORY_ROW_HEIGHT_PX,
  ROW_STYLE,
  toRows,
  type HistoryRow,
} from './history-rows';
import { DayRow, MatchRow } from './HistoryListRows';
import { useListOffset } from './use-list-offset';
import { useSyncRunning } from './use-matches';
import { useWindowedRows } from './use-windowed-rows';

/** Rows rendered above and below the visible ones, so a fast scroll never shows an empty gap. */
const HISTORY_OVERSCAN_ROWS = 10;

/** Rows rendered when `<main>` reports no height (before the layout, or in the tests): the first ones. */
const HISTORY_MIN_RENDERED_ROWS = 30;

/** Props of {@link HistoryList}. */
export interface HistoryListProps {
  /** The matches to list, most recent first, each with where its detail stands. */
  readonly matches: readonly MatchListItem[];
  /** English hero names by id; while unknown, heroes are shown by their id. */
  readonly heroNames: ReadonlyMap<HeroId, string> | undefined;
  /** The time the days are told against, in Unix milliseconds: "today" is the local day of it. */
  readonly now: number;
}

/**
 * The list of the matches.
 *
 * @returns The table, with only the rows near the visible part of the page.
 */
export function HistoryList({ matches, heroNames, now }: HistoryListProps) {
  const { t, i18n } = useTranslation();
  // A running synchronisation locks the rows whose detail it may still archive (see `isLocked`).
  const syncRunning = useSyncRunning();
  const rows = useMemo(
    () => toRows(matches, now, i18n.language, t),
    [matches, now, i18n.language, t],
  );
  // A new list (a filter) measures again where the list starts.
  const { bodyRef, scrollElement, listOffset } = useListOffset(matches);
  const { start, end, offsetTop, totalHeight } = useWindowedRows({
    count: rows.length,
    rowHeight: HISTORY_ROW_HEIGHT_PX,
    overscan: HISTORY_OVERSCAN_ROWS,
    minRendered: HISTORY_MIN_RENDERED_ROWS,
    scrollElement,
    listOffset,
  });
  const bottomSpacer = totalHeight - offsetTop - (end - start) * HISTORY_ROW_HEIGHT_PX;

  /**
   * Render one row of the window.
   *
   * @param row - The row.
   * @param index - Its index in the whole list.
   * @returns The table row, keyed by its day or its match so that it keeps its place as the window
   *   moves.
   */
  const renderRow = (row: HistoryRow, index: number) => {
    // The header row is the first row of the table, and the indexes of ARIA start at 1.
    const rowIndex = index + 2;
    return row.kind === 'day' ? (
      <DayRow key={row.key} label={row.label} rowIndex={rowIndex} />
    ) : (
      <MatchRow
        key={row.item.matchId}
        row={row}
        rowIndex={rowIndex}
        heroNames={heroNames}
        syncRunning={syncRunning}
      />
    );
  };

  return (
    // `relative`: the hidden texts of the rows (`sr-only`, absolutely positioned) are placed inside
    // the table. Without it they would be placed against the whole window, at the height of their
    // row in the scrolled content, and give the window a scrollbar of its own next to `<main>`'s.
    <table
      aria-rowcount={rows.length + 1}
      className="relative w-full table-fixed text-left text-sm"
    >
      <caption className="sr-only">{t('matches.title')}</caption>
      <colgroup>
        {COLUMNS.map((column) => (
          <col key={column.key} className={column.width} />
        ))}
      </colgroup>
      <thead className="text-fg-muted">
        <tr aria-rowindex={1} style={ROW_STYLE}>
          {COLUMNS.map((column, index) => (
            <th
              key={column.key}
              scope="col"
              className={`${CELL} font-medium ${index === 0 ? 'pl-3' : ''}`}
            >
              {t(column.key)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody ref={bodyRef}>
        {/* The spacers stand for the rows left out of the window; they are nothing to read. */}
        {offsetTop > 0 && (
          <tr aria-hidden="true">
            <td colSpan={COLUMN_COUNT} className="p-0" style={{ height: offsetTop }} />
          </tr>
        )}
        {rows.slice(start, end).map((row, offset) => renderRow(row, start + offset))}
        {bottomSpacer > 0 && (
          <tr aria-hidden="true">
            <td colSpan={COLUMN_COUNT} className="p-0" style={{ height: bottomSpacer }} />
          </tr>
        )}
      </tbody>
    </table>
  );
}
