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
 * @packageDocumentation
 */
import { Link, useNavigate } from '@tanstack/react-router';
import type { TFunction } from 'i18next';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { HeroId } from '../../../core/domain/hero';
import type { MatchId } from '../../../core/domain/match';
import { matchTypeOf } from '../../../core/domain/match-type';
import type { DetailStatus } from '../../../core/match-detail/detail-status';
import type { MatchListItem } from '../../../services/matches.service';
import { OPENED_FROM_HISTORY_STATE } from '../../app/history-return';
import { ResultBadge } from '../../components/ResultBadge';
import { formatMediumDate, formatTime, localDayKey, relativeDay } from '../../format/date';
import { formatDuration } from '../../format/duration';
import { useSyncRunning } from './use-matches';
import { useWindowedRows } from './use-windowed-rows';

/**
 * Height of every row of the list, day rows and header row included, in pixels. The rows take it
 * from {@link ROW_STYLE}, so the hook and the layout use the one number.
 */
const HISTORY_ROW_HEIGHT_PX = 44;

/** The height of a row, given to every row of the table. */
const ROW_STYLE = { height: HISTORY_ROW_HEIGHT_PX } as const;

/** Rows rendered above and below the visible ones, so a fast scroll never shows an empty gap. */
const HISTORY_OVERSCAN_ROWS = 10;

/** Rows rendered when `<main>` reports no height (before the layout, or in the tests): the first ones. */
const HISTORY_MIN_RENDERED_ROWS = 30;

/**
 * A row of the list: the header of a local day, or a match. The day rows are made from the matches,
 * one before the first match of each day.
 */
type HistoryRow =
  | {
      readonly kind: 'day';
      /** The local day, `YYYY-MM-DD` (see `localDayKey`): the key of the row. */
      readonly key: string;
      /** What the row says: "Today", "Yesterday" or the date. */
      readonly label: string;
    }
  | {
      readonly kind: 'match';
      readonly item: MatchListItem;
      /** The label of the day row the match sits under: part of the name of its link. */
      readonly dayLabel: string;
      /** Whether the row is tinted: the first match of its day, then every other one. */
      readonly striped: boolean;
    };

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
 * Translation key of the label of each detail status.
 *
 * `pending` and `retry` read the same: either way the detail is waiting to be downloaded, and the
 * player has nothing to do about it. The `satisfies` clause makes the compiler reject this table
 * as soon as a status is added to {@link DetailStatus} without a label here.
 */
const DETAIL_STATUS_LABEL_KEYS = {
  pending: 'matches.table.detailStatus.waiting',
  retry: 'matches.table.detailStatus.waiting',
  ready: 'matches.table.detailStatus.ready',
  unavailable: 'matches.table.detailStatus.unavailable',
  invalid: 'matches.table.detailStatus.invalid',
  evicted: 'matches.table.detailStatus.evicted',
} as const satisfies Record<DetailStatus, string>;

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
function isLocked(status: DetailStatus | null, syncRunning: boolean): boolean {
  return syncRunning && status === 'pending';
}

/**
 * The look of a match row by what it allows: an open row is clickable and lights up under the
 * pointer and when its link has the focus; a locked row is muted and does neither. The tint of
 * {@link MATCH_ROW_STRIPE} comes first in the class list, and the light of an open row takes over
 * from it (Tailwind writes the variants after the plain utilities).
 */
const MATCH_ROW_LOOK = {
  open: 'cursor-pointer hover:bg-surface-raised focus-within:bg-surface-raised',
  locked: 'cursor-not-allowed text-fg-muted',
} as const;

/** The tint of every other match row of a day, see {@link HistoryRow}. */
const MATCH_ROW_STRIPE = 'bg-surface';

/**
 * The columns, in order: the key of the header and the width of the column. The table lays its
 * columns out from these widths (`table-fixed`) and not from the rows it renders, so the columns do
 * not move as the window of rows moves. The hero takes the room left: about 120 pixels in the
 * narrowest window the app allows (1100 pixels wide). A text that does not fit its column is cut
 * with an ellipsis and can be read whole in the tooltip of its cell.
 */
const COLUMNS = [
  { key: 'matches.table.time', width: 'w-28' },
  { key: 'matches.table.type', width: 'w-28' },
  { key: 'matches.table.hero', width: '' },
  { key: 'matches.table.result', width: 'w-20' },
  { key: 'matches.table.kda', width: 'w-28' },
  { key: 'matches.table.duration', width: 'w-20' },
  { key: 'matches.table.detail', width: 'w-36' },
] as const satisfies readonly { key: string; width: string }[];

/** Number of columns of the table: what a day row and a spacer row span. */
const COLUMN_COUNT = COLUMNS.length;

/**
 * Shared look of the cells: no padding above or below, so the row keeps its fixed height, and one
 * line cut with an ellipsis rather than a second line that would make the row taller.
 */
const CELL = 'truncate py-0 pr-6';

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
function toRows(
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

/**
 * List the elements that sit above an element inside a container: its previous siblings, then the
 * previous siblings of each of its parents up to the container.
 *
 * @param element - The element, inside the container.
 * @param container - The element to stop at.
 * @returns The elements above, nearest first.
 */
function elementsAbove(element: Element, container: Element): Element[] {
  const above: Element[] = [];
  for (
    let current: Element | null = element;
    current !== null && current !== container;
    current = current.parentElement
  ) {
    for (
      let sibling = current.previousElementSibling;
      sibling !== null;
      sibling = sibling.previousElementSibling
    ) {
      above.push(sibling);
    }
  }
  return above;
}

/**
 * The list of the matches.
 *
 * @returns The table, with only the rows near the visible part of the page.
 */
export function HistoryList({ matches, heroNames, now }: HistoryListProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  // A running synchronisation locks the rows whose detail it may still archive (see `isLocked`).
  const syncRunning = useSyncRunning();
  const rows = useMemo(
    () => toRows(matches, now, i18n.language, t),
    [matches, now, i18n.language, t],
  );

  // The body of the table, where the rows go, and `<main>`, the element that scrolls it, both set by
  // the callback ref of the body once it is mounted. `<main>` is held in state, so that the
  // windowing hook listens to it as soon as there is one; it is the closest one around the list, so
  // the list asks nothing of the shell that draws it. The body is only measured, so a ref is enough.
  const body = useRef<HTMLTableSectionElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const bodyRef = useCallback((element: HTMLTableSectionElement | null) => {
    body.current = element;
    setScrollElement(element?.closest('main') ?? null);
  }, []);

  // How far the first row is from the top of the content of `<main>`: the page header, the banner,
  // the filters and the header row sit above it. It is measured, not assumed: the top of the body
  // relative to the top of `<main>`, plus the distance `<main>` is scrolled by, which gives the same
  // number whatever the scroll position. It is measured before the browser paints, then again:
  // - whenever an element above the list changes height (an error line appears in the banner, a
  //   sentence wraps onto a second line): a `ResizeObserver` watches each element that sits above
  //   the list inside `<main>`, where the platform has one;
  // - when the window is resized and when the list changes (a filter brings a new list): the
  //   fallback where there is no `ResizeObserver` (jsdom has none), harmless where there is one.
  const [listOffset, setListOffset] = useState(0);
  useLayoutEffect(() => {
    const list = body.current;
    if (scrollElement === null || list === null) {
      return;
    }
    const measure = (): void => {
      setListOffset(
        list.getBoundingClientRect().top -
          scrollElement.getBoundingClientRect().top +
          scrollElement.scrollTop,
      );
    };
    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    for (const element of elementsAbove(list, scrollElement)) {
      observer?.observe(element);
    }
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [scrollElement, matches]);

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
   * Open a match when a click lands anywhere on its row: a shortcut for the mouse, the time link
   * being the way in for the keyboard. Two clicks are left alone:
   * - a click on the link itself (or any other link of the row), which navigates by itself and
   *   would otherwise navigate a second time as it bubbles up to the row;
   * - a click that ends a text selection, so that the player can still select and copy what the
   *   row says.
   *
   * @param event - The click on the row.
   * @param matchId - The match of the row.
   */
  const openMatch = (event: MouseEvent<HTMLTableRowElement>, matchId: MatchId): void => {
    if (event.target instanceof Element && event.target.closest('a') !== null) {
      return;
    }
    const selectedText = window.getSelection()?.toString() ?? '';
    if (selectedText !== '') {
      return;
    }
    // The same destination as the time link: no search, so the page opens on its analysis tab, and
    // the same mark on the new entry, so that the page knows its way back is the list.
    void navigate({
      to: '/matches/$matchId',
      params: { matchId },
      state: OPENED_FROM_HISTORY_STATE,
    });
  };

  /**
   * Render one row of the window.
   *
   * @param row - The row.
   * @param index - Its index in the whole list.
   * @returns The table row.
   */
  const renderRow = (row: HistoryRow, index: number) => {
    // The header row is the first row of the table, and the indexes of ARIA start at 1.
    const rowIndex = index + 2;
    if (row.kind === 'day') {
      return (
        <tr key={row.key} aria-rowindex={rowIndex} style={ROW_STYLE}>
          <th
            scope="row"
            colSpan={COLUMN_COUNT}
            className="truncate pt-0 pb-1 pl-3 align-bottom font-medium text-fg-muted"
          >
            {row.label}
          </th>
        </tr>
      );
    }
    const match = row.item;
    const matchType = matchTypeOf(match);
    const typeLabel = matchType === null ? undefined : t(`matchType.${matchType}`);
    const heroName =
      heroNames?.get(match.heroId) ?? t('matches.table.unknownHero', { id: match.heroId });
    const locked = isLocked(match.detailStatus, syncRunning);
    let detailLabel: string | undefined;
    if (locked) {
      detailLabel = t('matches.table.detailStatus.inProgress');
    } else if (match.detailStatus !== null) {
      detailLabel = t(DETAIL_STATUS_LABEL_KEYS[match.detailStatus]);
    }
    // The day is part of the name of the link, as a row header above is for the eye: a list of the
    // links of the page, or the Tab key, never gives two matches the same bare time. The space stays
    // outside the hidden text, where the name keeps it (a trailing space inside an element is
    // dropped from the name), and the eye sees none: it starts the line.
    const classes = [
      row.striped ? MATCH_ROW_STRIPE : '',
      MATCH_ROW_LOOK[locked ? 'locked' : 'open'],
    ]
      .filter(Boolean)
      .join(' ');
    return (
      // The whole row opens the match with the mouse; the keyboard goes through the time link, the
      // only link and focus stop of the row, so the row is given no role, tab stop or key handler of
      // its own. The row has the same highlight when the focus is on its link (`focus-within`) as
      // when the pointer is on it. A locked row takes no click, and its link is disabled rather than
      // removed: a synchronisation that starts while the keyboard is on it leaves the focus there.
      <tr
        key={match.matchId}
        aria-rowindex={rowIndex}
        onClick={
          locked
            ? undefined
            : (event) => {
                openMatch(event, match.matchId);
              }
        }
        style={ROW_STYLE}
        className={classes}
      >
        <td className={`${CELL} pl-3 tabular-nums`}>
          <Link
            to="/matches/$matchId"
            params={{ matchId: match.matchId }}
            state={OPENED_FROM_HISTORY_STATE}
            aria-disabled={locked ? true : undefined}
            onClick={
              locked
                ? (event) => {
                    // The router's own handler, which runs after this one, then does nothing.
                    event.preventDefault();
                  }
                : undefined
            }
            className={locked ? undefined : 'hover:text-accent-bright'}
          >
            <span className="sr-only">{`${row.dayLabel},`}</span>{' '}
            {formatTime(match.startTime, i18n.language)}
          </Link>
        </td>
        {/* Empty for a pair of mode codes the app does not know: no wrong label. The cells whose
            text can be cut by their column carry it whole in their tooltip. */}
        <td className={CELL} title={typeLabel}>
          {typeLabel}
        </td>
        <td className={CELL} title={heroName}>
          {heroName}
        </td>
        <td className={CELL}>
          <ResultBadge won={match.won} />
        </td>
        <td className={`${CELL} tabular-nums`}>
          {match.kills} / {match.deaths} / {match.assists}
        </td>
        <td className={`${CELL} tabular-nums`}>{formatDuration(match.durationS)}</td>
        {/* For a match the app does not archive, the eye sees an empty cell (no text, no dash) and a
            screen reader hears that it is not archived, rather than nothing at all. */}
        <td className={CELL} title={detailLabel}>
          {detailLabel ?? <span className="sr-only">{t('matches.table.notArchived')}</span>}
        </td>
      </tr>
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
