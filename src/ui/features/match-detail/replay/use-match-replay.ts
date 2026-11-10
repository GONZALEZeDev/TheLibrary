/**
 * TanStack Query hook of the map replay of the timeline tab.
 *
 * It goes through `MatchReplayService`, which reads the archive of the match and the cached map and
 * hero catalogues. The view always says what it can show, or why it cannot (`not_archived`,
 * `unreadable`): a failed read is a query error, never an empty map. The query sits under the key of
 * the tabs of one match (`BREAKDOWN_QUERY_KEY_OF`), so that whatever refreshes the match reads it
 * again, and the account is never part of the key.
 *
 * @packageDocumentation
 */
import { useQuery } from '@tanstack/react-query';
import type { MatchId } from '../../../../core/domain/match';
import { useServices } from '../../../app/ServicesContext';
import { BREAKDOWN_QUERY_KEY_OF } from '../use-match-breakdown';

/**
 * The replay of one match.
 *
 * @param matchId - The match.
 * @returns The TanStack Query result holding the replay view: `replay`, `not_archived` or `unreadable`.
 */
export function useMatchReplay(matchId: MatchId) {
  const { replay } = useServices();
  return useQuery({
    queryKey: [...BREAKDOWN_QUERY_KEY_OF(matchId), 'replay'],
    queryFn: () => replay.getReplay(matchId),
  });
}
