/**
 * The rows of the match history list and the layout they share with it: which rows the list holds
 * (a row for each local day, then its matches), when a match row is locked, and the columns, the
 * height and the look of the cells. Kept apart from the components so that the list and its rows
 * read one set of numbers, and so that the making of the rows is plain code.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import type { DetailStatus } from '../../../core/match-detail/detail-status';
import type { MatchListItem } from '../../../services/matches.service';
import { formatMediumDate, localDayKey, relativeDay } from '../../format/date';

/**
 * Height of every row of the list, day rows and header row included, in pixels. The rows take it
 * from {@link ROW_STYLE}, so the windowing hook and the layout use the one number.
 */
export const HISTORY_ROW_HEIGHT_PX = 44;

/** The height of a row, given to every row of the table. */
export const ROW_STYLE = { height: HISTORY_ROW_HEIGHT_PX } as const;

/**
 * The columns, in order: the key of the header and the width of the column. The table lays its
 * columns out from these widths (`table-fixed`) and not from the rows it renders, so the columns do
 * not move as the window of rows moves. The hero takes the room left: about 120 pixels in the
 * narrowest window the app allows (1100 pixels wide). A text that does not fit its column is cut
 * with an ellipsis and can be read whole in the tooltip of its cell.
 */
export const COLUMNS = [
  { key: 'matches.table.time', width: 'w-28' },
  { key: 'matches.table.type', width: 'w-28' },
  { key: 'matches.table.hero', width: '' },
  { key: 'matches.table.result', width: 'w-20' },
  { key: 'matches.table.kda', width: 'w-28' },
  { key: 'matches.table.duration', width: 'w-20' },
  { key: 'matches.table.detail', width: 'w-36' },
] as const satisfies readonly { key: string; width: string }[];

/** Number of columns of the table: what a day row and a spacer row span. */
export const COLUMN_COUNT = COLUMNS.length;

/**
 * Shared look of the cells: no padding above or below, so the row keeps its fixed height, and one
 * line cut with an ellipsis rather than a second line that would make the row taller.
 */
export const CELL = 'truncate py-0 pr-6';

/**
 * A row of the list: the header of a local day, or a match. The day rows are made from the matches,
 * one before the first match of each day.
 */
export type HistoryRow =
  | {
      readonly kind: 'day';
      /** The local day, `YYYY-MM-DD` (see `localDayKey`): the key of the row. */
      readonly key: string;
      /** What the row says: "Today", "Yesterday" or the date. */
      readonly label: string;
    }
  | HistoryMatchRow;

/** A match row of the list. */
export interface HistoryMatchRow {
  readonly kind: 'match';
  readonly item: MatchListItem;
  /** The label of the day row the match sits under: part of the name of its link. */
  readonly dayLabel: string;
  /** Whether the row is tinted: the first match of its day, then every other one. */
  readonly striped: boolean;
}

/**
 * Whether a match row is locked: a synchronisation runs and the queue has never tried the detail of
 * the match (`pending`), which it takes in this run unless a pause or the budget stops it first. The
 * row unlocks as soon as the queue has archived it (the list is read again as the queue goes) or the
 * run ends. A `retry` match is not locked: it failed once and waits for a next attempt that may be
 * hours away, so a running synchronisation says nothing of it, and its page explains the wait.
 *
 * @param status - Where the detail of the match stands; `null` for a match the app does not archive.
 * @param syncRunning - Whether a synchronisation runs.
 * @returns `true` when the row must not open its match.
 */
export function isLocked(status: DetailStatus | null, syncRunning: boolean): boolean {
  return syncRunning && status === 'pending';
}

/**
 * Turn the matches into the rows of the list: a day row before the first match of each local day,
 * then the match rows of that day.
 *
 * @param matches - The matches, most recent first.
 * @param now - The time the days are told against, in Unix milliseconds.
 * @param language - Language of the interface, for the dates.
 * @param t - Translation function, for "today" and "yesterday".
 * @returns The rows, in display order.
 */
export function toRows(
  matches: readonly MatchListItem[],
  now: number,
  language: string,
  t: TFunction,
): HistoryRow[] {
  const rows: HistoryRow[] = [];
  let currentDay: string | null = null;
  let dayLabel = '';
  // The place of the match in its day, from 0: the even places are tinted.
  let indexInDay = 0;
  for (const item of matches) {
    const key = localDayKey(item.startTime);
    // The matches come newest first, so the matches of one day follow each other.
    if (key !== currentDay) {
      currentDay = key;
      indexInDay = 0;
      const relative = relativeDay(item.startTime, now);
      dayLabel =
        relative === null
          ? formatMediumDate(item.startTime, language)
          : t(`matches.day.${relative}`);
      rows.push({ kind: 'day', key, label: dayLabel });
    }
    rows.push({ kind: 'match', item, dayLabel, striped: indexInDay % 2 === 0 });
    indexInDay += 1;
  }
  return rows;
}
