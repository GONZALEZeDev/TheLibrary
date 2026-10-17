/**
 * Plain table of the most recent matches: date, hero, result, K/D/A, duration and where the archive
 * of the match detail stands. Each date links to the match detail.
 *
 * Milestone M2a ships it as a plain table; the screens milestone (M5) replaces it with the final
 * virtualised history.
 *
 * @packageDocumentation
 */
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { HeroId } from '../../../core/domain/hero';
import type { DetailStatus } from '../../../core/match-detail/detail-status';
import type { MatchListItem } from '../../../services/matches.service';

/** Props of {@link MatchesTable}. */
export interface MatchesTableProps {
  /** The matches, in display order, each with where its detail stands. */
  readonly matches: readonly MatchListItem[];
  /** English hero names by id; while unknown, heroes are shown by their id. */
  readonly heroNames: ReadonlyMap<HeroId, string> | undefined;
}

/** Shared look of the header cells. */
const HEADER_CELL = 'py-2 pr-6 font-medium';

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
} as const satisfies Record<DetailStatus, string>;

/**
 * Format a duration as `minutes:seconds`, e.g. `34:30`. Shared with the match detail page, which
 * shows the duration the same way.
 *
 * @param seconds - Duration in seconds.
 * @returns The formatted duration.
 */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Table of matches.
 *
 * @returns The table.
 */
export function MatchesTable({ matches, heroNames }: MatchesTableProps) {
  const { t, i18n } = useTranslation();
  const dateTime = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  return (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">{t('matches.table.caption')}</caption>
      <thead className="text-fg-muted">
        <tr>
          <th scope="col" className={HEADER_CELL}>
            {t('matches.table.date')}
          </th>
          <th scope="col" className={HEADER_CELL}>
            {t('matches.table.hero')}
          </th>
          <th scope="col" className={HEADER_CELL}>
            {t('matches.table.result')}
          </th>
          <th scope="col" className={HEADER_CELL}>
            {t('matches.table.kda')}
          </th>
          <th scope="col" className={HEADER_CELL}>
            {t('matches.table.duration')}
          </th>
          <th scope="col" className={HEADER_CELL}>
            {t('matches.table.detail')}
          </th>
        </tr>
      </thead>
      <tbody>
        {matches.map((match) => (
          <tr key={match.matchId} className="border-t border-border">
            <td className="py-2 pr-6">
              <Link
                to="/matches/$matchId"
                params={{ matchId: match.matchId }}
                className="hover:text-accent-bright"
              >
                {dateTime.format(match.startTime * 1000)}
              </Link>
            </td>
            <td className="py-2 pr-6">
              {heroNames?.get(match.heroId) ?? t('matches.table.unknownHero', { id: match.heroId })}
            </td>
            <td className={match.won ? 'py-2 pr-6 text-win' : 'py-2 pr-6 text-loss'}>
              {match.won ? t('matches.table.win') : t('matches.table.loss')}
            </td>
            <td className="py-2 pr-6 tabular-nums">
              {match.kills} / {match.deaths} / {match.assists}
            </td>
            <td className="py-2 pr-6 tabular-nums">{formatDuration(match.durationS)}</td>
            {/* Empty for a match the app does not archive: no text and no dash. */}
            <td className="py-2 pr-6">
              {match.detailStatus !== null && t(DETAIL_STATUS_LABEL_KEYS[match.detailStatus])}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
