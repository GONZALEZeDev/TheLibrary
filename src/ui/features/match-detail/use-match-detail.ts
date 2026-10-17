/**
 * TanStack Query hooks of the match detail screen: what the page shows about one match, and the
 * "Retry" of a match whose detail failed.
 *
 * Both go through a service and read local data. Query keys never contain an account id: the
 * services resolve the account themselves, and keys are logged when a query fails.
 *
 * @packageDocumentation
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MatchId } from '../../../core/domain/match';
import { useServices } from '../../app/ServicesContext';
import {
  DETAILS_QUERY_KEY,
  DETAILS_SUMMARY_QUERY_KEY,
  MATCHES_QUERY_KEY,
} from '../matches/use-matches';

/**
 * What the page shows about the detail of one match: the facts of its archive, or why there is none.
 *
 * When the answer is `missing` or `lost`, the service has just put the match back to `pending`
 * (its archive file was gone or damaged). That changes what the banner counts and what the list says
 * of the match, so both are read again, once per answer. The query itself is not: its next answer
 * is `waiting` (or `not_eligible`, for a match past the 90 days), and it is read again by the
 * synchronisation that downloads the match, so refreshing it here would only repeat what the
 * service did.
 *
 * @param matchId - The match.
 * @returns The TanStack Query result holding the view of the match.
 */
export function useMatchDetail(matchId: MatchId) {
  const { details } = useServices();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: [...DETAILS_QUERY_KEY, 'match', matchId],
    queryFn: async () => {
      const view = await details.getMatchDetail(matchId);
      if (view.kind === 'missing' || view.kind === 'lost') {
        void queryClient.invalidateQueries({ queryKey: DETAILS_SUMMARY_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: MATCHES_QUERY_KEY });
      }
      return view;
    },
  });
}

/**
 * Try the detail of a match again: put it back in the queue and run the detail queue, without the
 * history (the "Retry" action of a match that is `unavailable` or `invalid`).
 *
 * Once the run is over, everything about the details and the matches is read again, since the match
 * changed state and so did the counts of the banner and the list. The mutation stays pending until
 * those reads are done, so the page does not offer the button again while it still shows the old
 * state.
 *
 * @param matchId - The match.
 * @returns The TanStack Query mutation; call `mutate()`. It never fails: the service logs what goes
 *   wrong, and the new state of the match is what the page shows.
 */
export function useRetryDetail(matchId: MatchId) {
  const { sync } = useServices();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...DETAILS_QUERY_KEY, 'retry'],
    mutationFn: () => sync.retryDetail(matchId),
    // Whatever became of the run, the state of the match may have changed.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: DETAILS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: MATCHES_QUERY_KEY }),
      ]),
  });
}
