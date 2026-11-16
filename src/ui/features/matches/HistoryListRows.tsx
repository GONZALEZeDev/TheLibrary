/**
 * The two kinds of row of the match history list: the header of a local day, and a match. Each is
 * memoised: the rows come from one memoised list, so a row the window keeps while the list scrolls
 * is not drawn again.
 *
 * @packageDocumentation
 */
import { Link, useNavigate } from '@tanstack/react-router';
import { memo, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { HeroId } from '../../../core/domain/hero';
import { matchTypeOf } from '../../../core/domain/match-type';
import type { DetailStatus } from '../../../core/match-detail/detail-status';
import { OPENED_FROM_HISTORY_STATE } from '../../app/history-return';
import { ResultBadge } from '../../components/ResultBadge';
import { formatTime } from '../../format/date';
import { formatDuration } from '../../format/duration';
import { CELL, COLUMN_COUNT, isLocked, ROW_STYLE, type HistoryMatchRow } from './history-rows';

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
 * The look of a match row by what it allows: an open row is clickable and lights up under the
 * pointer and when its link has the focus; a locked row is muted and does neither. The tint of
 * {@link MATCH_ROW_STRIPE} comes first in the class list, and the light of an open row takes over
 * from it (Tailwind writes the variants after the plain utilities).
 */
const MATCH_ROW_LOOK = {
  open: 'cursor-pointer hover:bg-surface-raised focus-within:bg-surface-raised',
  locked: 'cursor-not-allowed text-fg-muted',
} as const;

/** The tint of every other match row of a day, see `HistoryRow`. */
const MATCH_ROW_STRIPE = 'bg-surface';

/** Props of {@link DayRow}. */
interface DayRowProps {
  /** What the row says: "Today", "Yesterday" or the date. */
  readonly label: string;
  /** The place of the row in the table, from 1 (`aria-rowindex`). */
  readonly rowIndex: number;
}

/**
 * The header of a local day: a row header spanning every column.
 *
 * @returns The table row.
 */
export const DayRow = memo(function DayRow({ label, rowIndex }: DayRowProps) {
  return (
    <tr aria-rowindex={rowIndex} style={ROW_STYLE}>
      <th
        scope="row"
        colSpan={COLUMN_COUNT}
        className="truncate pt-0 pb-1 pl-3 align-bottom font-medium text-fg-muted"
      >
        {label}
      </th>
    </tr>
  );
});

/** Props of {@link MatchRow}. */
interface MatchRowProps {
  /** The row. */
  readonly row: HistoryMatchRow;
  /** The place of the row in the table, from 1 (`aria-rowindex`). */
  readonly rowIndex: number;
  /** English hero names by id; while unknown, heroes are shown by their id. */
  readonly heroNames: ReadonlyMap<HeroId, string> | undefined;
  /** Whether a synchronisation runs, which locks the rows whose detail it may still archive. */
  readonly syncRunning: boolean;
}

/**
 * A match: the time (the link to its page), the type, the hero, the result, the K/D/A, the
 * duration and where its detail stands.
 *
 * @returns The table row.
 */
export const MatchRow = memo(function MatchRow({
  row,
  rowIndex,
  heroNames,
  syncRunning,
}: MatchRowProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
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
  const classes = [row.striped ? MATCH_ROW_STRIPE : '', MATCH_ROW_LOOK[locked ? 'locked' : 'open']]
    .filter(Boolean)
    .join(' ');

  /**
   * Open the match when a click lands anywhere on its row: a shortcut for the mouse, the time link
   * being the way in for the keyboard. Two clicks are left alone:
   * - a click on the link itself (or any other link of the row), which navigates by itself and
   *   would otherwise navigate a second time as it bubbles up to the row;
   * - a click that ends a text selection, so that the player can still select and copy what the
   *   row says.
   *
   * @param event - The click on the row.
   */
  const openMatch = (event: MouseEvent<HTMLTableRowElement>): void => {
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
      params: { matchId: match.matchId },
      state: OPENED_FROM_HISTORY_STATE,
    });
  };

  return (
    // The whole row opens the match with the mouse; the keyboard goes through the time link, the
    // only link and focus stop of the row, so the row is given no role, tab stop or key handler of
    // its own. The row has the same highlight when the focus is on its link (`focus-within`) as
    // when the pointer is on it. A locked row takes no click, and its link is disabled rather than
    // removed: a synchronisation that starts while the keyboard is on it leaves the focus there.
    <tr
      aria-rowindex={rowIndex}
      onClick={locked ? undefined : openMatch}
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
          {/* The day is part of the name of the link, as a row header above is for the eye: a list
              of the links of the page, or the Tab key, never gives two matches the same bare time.
              The space stays outside the hidden text, where the name keeps it (a trailing space
              inside an element is dropped from the name), and the eye sees none: it starts the
              line. */}
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
});
