/**
 * TanStack Query hook of the timeline tab of the match page.
 *
 * It goes through `MatchTimelineService` and reads local data (the archive of the match), plus the
 * catalogues of the game, which the service answers from its cache. The view always says what it can
 * show, or why it cannot (`not_archived`, `unreadable`): a failed read is a query error, never an
 * empty tab. The query sits under the key of the tabs of one match (`BREAKDOWN_QUERY_KEY_OF`), so
 * that whatever refreshes the match details reads it again, and the account is never part of the key.
 *
 * @packageDocumentation
 */
import { useQuery } from '@tanstack/react-query';
import type { MatchId } from '../../../core/domain/match';
import { useServices } from '../../app/ServicesContext';
import { BREAKDOWN_QUERY_KEY_OF } from './use-match-breakdown';

/**
 * The timeline tab of one match: the souls of the player against their lane opponents, their kills,
 * purchases and deaths, and which deaths were avoidable; or why there is nothing to show.
 *
 * @param matchId - The match.
 * @returns The TanStack Query result holding the view of the tab: `timeline`, `not_archived` or
 *   `unreadable`.
 */
export function useTimelineTab(matchId: MatchId) {
  const { timeline } = useServices();
  return useQuery({
    queryKey: [...BREAKDOWN_QUERY_KEY_OF(matchId), 'timeline'],
    queryFn: () => timeline.getTimelineTab(matchId),
  });
}
