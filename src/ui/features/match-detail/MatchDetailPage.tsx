/**
 * Match detail screen. Milestone M1 only shows the match id and an empty state;
 * the timeline, strengths and weaknesses, scoreboard and build order arrive in later milestones.
 *
 * @packageDocumentation
 */
import { getRouteApi } from '@tanstack/react-router';
import { ScrollText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';

/** Typed access to the parameters of the `/matches/$matchId` route (see `ui/app/router.ts`). */
const matchDetailRoute = getRouteApi('/matches/$matchId');

/**
 * Match detail screen.
 *
 * @returns The match detail page.
 */
export function MatchDetailPage() {
  const { t } = useTranslation();
  const { matchId } = matchDetailRoute.useParams();
  return (
    <>
      <PageHeader title={t('matchDetail.title', { matchId })} />
      <EmptyState
        icon={ScrollText}
        title={t('matchDetail.empty.title')}
        description={t('matchDetail.empty.description')}
      />
    </>
  );
}
