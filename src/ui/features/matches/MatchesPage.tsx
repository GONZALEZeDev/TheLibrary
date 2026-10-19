/**
 * Match history screen: the synchronisation banner and the most recent matches.
 *
 * Milestone M2a shows a plain table; the screens milestone (M5) brings the virtualised history,
 * its filters (the `hero` and `result` search parameters of the route) and its final design.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { History, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { HeroId } from '../../../core/domain/hero';
import { toAppError } from '../../../core/errors/app-error';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { LinkAccountButton } from '../account/LinkAccountButton';
import { MatchesTable } from './MatchesTable';
import { SyncBanner } from './SyncBanner';
import { useHeroNames, useRecentMatches } from './use-matches';

/**
 * The list part of the screen, depending on what is known.
 *
 * @param recent - State of the matches query.
 * @param heroNames - Hero names, once known.
 * @param t - Translation function.
 * @returns The loading message, the error, an empty state or the table.
 */
function renderList(
  recent: ReturnType<typeof useRecentMatches>,
  heroNames: ReadonlyMap<HeroId, string> | undefined,
  t: TFunction,
) {
  if (recent.isPending) {
    return (
      <p role="status" className="text-sm text-fg-muted">
        {t('matches.loading')}
      </p>
    );
  }
  // A failed refresh keeps the matches already shown: the error only replaces an empty screen.
  if (recent.data === undefined) {
    return (
      <p role="alert" className="text-sm text-loss">
        {t(`errors.kind.${toAppError(recent.error).kind}`)}
      </p>
    );
  }
  const { accountLinked, total, matches } = recent.data;
  if (!accountLinked) {
    // A new player can link from wherever they land: the link resets this query, so the list is
    // replaced by the matches the first synchronisation brings.
    return (
      <EmptyState
        icon={UserRound}
        title={t('matches.noAccount.title')}
        description={t('matches.noAccount.description')}
      >
        <LinkAccountButton />
      </EmptyState>
    );
  }
  if (total === 0) {
    return (
      <EmptyState
        icon={History}
        title={t('matches.empty.title')}
        description={t('matches.empty.description')}
      />
    );
  }
  return (
    <>
      {/* Only when the list leaves matches out (it shows at most RECENT_MATCHES_LIMIT). */}
      {matches.length < total && (
        <p className="mb-3 text-sm text-fg-muted">
          {t('matches.count', { shown: matches.length, total })}
        </p>
      )}
      <MatchesTable matches={matches} heroNames={heroNames} />
    </>
  );
}

/**
 * Match history screen.
 *
 * @returns The matches page.
 */
export function MatchesPage() {
  const { t } = useTranslation();
  const recent = useRecentMatches();
  const heroNames = useHeroNames(recent.data !== undefined && recent.data.total > 0);
  return (
    <>
      <PageHeader title={t('matches.title')} />
      <SyncBanner />
      {renderList(recent, heroNames.data, t)}
    </>
  );
}
