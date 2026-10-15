/**
 * Plain table of the most recent matches: date, hero, result, K/D/A and duration. Each date links
 * to the match detail.
 *
 * Milestone M2a ships it as a plain table; the screens milestone (M5) replaces it with the final
 * virtualised history.
 *
 * @packageDocumentation
 */
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { HeroId } from '../../../core/domain/hero';
import type { MatchSummary } from '../../../core/domain/match';

/** Props of {@link MatchesTable}. */
export interface MatchesTableProps {
  /** The matches, in display order. */
  readonly matches: readonly MatchSummary[];
  /** English hero names by id; while unknown, heroes are shown by their id. */
  readonly heroNames: ReadonlyMap<HeroId, string> | undefined;
}

/** Shared look of the header cells. */
const HEADER_CELL = 'py-2 pr-6 font-medium';

/**
 * Format a duration as `minutes:seconds`, e.g. `34:30`.
 *
 * @param seconds - Duration in seconds.
 * @returns The formatted duration.
 */
function formatDuration(seconds: number): string {
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
          </tr>
        ))}
      </tbody>
    </table>
  );
}
