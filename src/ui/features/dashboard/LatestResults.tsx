/**
 * The results of the latest matches on the dashboard: one badge for each match, newest first, a
 * filled one for a win and an outlined one for a loss. Each badge is a link to the page of its match.
 *
 * The row is a list, so that a screen reader says how many matches there are. A badge shows only the
 * initial of the result; the link says in words which match it opens (the result, then the day and
 * time of the match), since a row of identical letters would tell a screen reader user nothing.
 *
 * @packageDocumentation
 */
import { Link } from '@tanstack/react-router';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { MatchListItem } from '../../../services/matches.service';
import { Panel } from '../../components/Panel';
import { ResultBadge } from '../../components/ResultBadge';
import { formatMediumDateTime } from '../../format/date';
import { REVIEW_SECTION_TITLE } from '../review/review-layout';

/** What stands, in the name of a link, between the result word and the date of the match. */
const DATE_SEPARATOR = ', ';

/** Props of {@link LatestResults}. */
export interface LatestResultsProps {
  /** The latest matches, most recent first. */
  readonly matches: readonly MatchListItem[];
}

/**
 * The results of the latest matches.
 *
 * @returns A titled section with the row of results, or one sentence when there is no match.
 */
export function LatestResults({ matches }: LatestResultsProps) {
  const { t, i18n } = useTranslation();
  const headingId = useId();

  // No title for no match: "Your last 0 matches" would be a sentence about nothing.
  if (matches.length === 0) {
    return (
      <Panel padding="normal" className="text-sm">
        <p>{t('dashboard.latest.empty')}</p>
      </Panel>
    );
  }

  return (
    <Panel aria-labelledby={headingId} padding="normal">
      {/* The title says how many matches there are: a player with fewer than the limit sees the truth. */}
      <h2 id={headingId} className={REVIEW_SECTION_TITLE}>
        {t('dashboard.latest.title', { count: matches.length })}
      </h2>
      <ol className="mt-3 flex flex-wrap gap-2">
        {matches.map((match) => (
          <li key={match.matchId}>
            <Link
              to="/matches/$matchId"
              params={{ matchId: match.matchId }}
              className="inline-flex rounded"
            >
              <ResultBadge won={match.won} />
              {/* The name of the link: the result (said once, by the badge), then which match it is. The
                  separator is part of the hidden text, so that the name does not depend on how the
                  link lays out its children. */}
              <span className="sr-only">
                {`${DATE_SEPARATOR}${formatMediumDateTime(match.startTime, i18n.language)}`}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
