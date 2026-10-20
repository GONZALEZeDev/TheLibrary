/**
 * TanStack Query hooks of the match analysis: what the match page shows when it compares a match with
 * the community and with the player's habits, the analysis of a match that was not analysed yet, and
 * the download of the community data it compares with.
 *
 * All three go through `AnalysisService`. Reading the analysis never projects or downloads anything:
 * a page asks for the projection of its match with {@link useAnalyseMatch} when the analysis says it
 * is `pending`, and for the community data with {@link useCommunityRefresh} when it opens; the
 * analysis is read again once the data is in the cache. Query keys never contain an account id: the
 * service resolves the account itself, and keys are logged when a query or a mutation fails.
 *
 * @packageDocumentation
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MatchId } from '../../../core/domain/match';
import type { MatchAnalysisView } from '../../../services/analysis-view';
import { isSuspensionRefusal } from '../../../services/sync.service';
import { useServices } from '../../app/ServicesContext';
import { DETAILS_QUERY_KEY, DETAILS_SUMMARY_QUERY_KEY } from '../matches/use-matches';

/**
 * Prefix of every query that downloads the community data of a match (one per match, see
 * {@link useCommunityRefresh}).
 *
 * The data depends on the account, whose rank and matches pick the cohort: an account change resets
 * these queries (see `resetAccountData`), or a page would keep the answer given for the previous
 * account. They are deliberately not refreshed by `useRefreshOnSync`: the detail queue reports every
 * match it records, up to once a second, and the community data does not change with them. It is
 * downloaded when a page opens and kept for a day by the service, which says `fresh` until then.
 */
export const ANALYSIS_COMMUNITY_QUERY_KEY = ['analysis-community'] as const;

/**
 * The key of the analysis of a match. It sits under {@link DETAILS_QUERY_KEY}: whatever refreshes the
 * match details (a synchronisation, an account change) reads the analysis again, since the state of
 * a match (archived or not, analysed or not) follows from them. Every archived match is projected at
 * the end of each synchronisation; a page whose match is still `pending` (it, or an earlier match of
 * its habits, has no projection yet) asks for it with {@link useAnalyseMatch}.
 *
 * @param matchId - The match.
 * @returns The query key.
 */
function analysisKey(matchId: MatchId) {
  return [...DETAILS_QUERY_KEY, 'analysis', matchId] as const;
}

/**
 * The analysis of one match: its metrics compared with the community and with the habits of the
 * player, the strengths and the weaknesses, and the phase table; or why there is none yet.
 *
 * It reads local data only and is cheap to ask again, so it is read again by whatever refreshes the
 * match details, and by {@link useCommunityRefresh} once new community data is stored.
 *
 * @param matchId - The match.
 * @returns The TanStack Query result holding the view of the analysis: `ready`, `pending`, `failed`
 *   or `not_analysed`.
 */
export function useMatchAnalysis(matchId: MatchId) {
  const { analysis } = useServices();
  return useQuery({
    queryKey: analysisKey(matchId),
    queryFn: () => analysis.getMatchAnalysis(matchId),
  });
}

/**
 * Analyse a match whose analysis is not complete yet: the page of a match whose analysis is `pending`
 * (the match itself, or some of the earlier matches its habits are made of, has no projection yet)
 * asks for it when it opens (see `AnalysisSection`). The service projects what is missing, which
 * takes a moment the first time, and answers the analysis.
 *
 * On success the view is written into the analysis query, which then shows it without reading it
 * again: nothing here invalidates the analysis, so the success cannot start a loop of reads. The
 * details summary is read again, since the projection puts a match whose archive cannot be read
 * back to `pending`, which the counts of the banner show. A read of the analysis that began before
 * the success and ends after it is cancelled first: its answer, from before the projection, would
 * take the analysis away from the page.
 *
 * It does not retry: a failure is not going away by itself, and the next opening of the page asks
 * again. A failure stays a mutation error, logged once by the query client (the name of the
 * mutation, not the match).
 *
 * The service refuses the analysis while the linked account changes (`isSuspensionRefusal`). That is
 * not a failure: the page is about to go away, and the account change resets the queries. The
 * mutation then succeeds with `null`, writes nothing and logs nothing, and can be asked again.
 *
 * @param matchId - The match.
 * @returns The TanStack Query mutation; call `mutate()`. Its `data` is the view the service answered
 *   (`ready`, `failed` or `not_analysed`, never `pending`), or `null` when the analysis was refused
 *   because the account is changing and nothing was analysed.
 */
export function useAnalyseMatch(matchId: MatchId) {
  const { analysis } = useServices();
  const queryClient = useQueryClient();
  return useMutation({
    // Shows up in the log line written when the mutation fails.
    mutationKey: [...DETAILS_QUERY_KEY, 'analyse'],
    mutationFn: async (): Promise<MatchAnalysisView | null> => {
      try {
        return await analysis.analyseMatch(matchId);
      } catch (error) {
        if (isSuspensionRefusal(error)) {
          return null;
        }
        throw error;
      }
    },
    retry: false,
    onSuccess: async (view) => {
      if (view === null) {
        return;
      }
      await queryClient.cancelQueries({ queryKey: analysisKey(matchId) });
      queryClient.setQueryData(analysisKey(matchId), view);
      await queryClient.invalidateQueries({ queryKey: DETAILS_SUMMARY_QUERY_KEY });
    },
  });
}

/**
 * Download the community data a match is compared with, unless the cache holds it still fresh, and
 * read the analysis of the match again when the cache holds data the page has not seen.
 *
 * The analysis is read again for `updated` (the data was just stored) and for `fresh` too: a page
 * only asks while its view lacks fresh data, so a `fresh` answer means either that another refresh
 * of the same cohort (the page opened before this one) stored the data between the read of this
 * page and its ask, and the view is behind the cache, or that the service has nothing to compare
 * yet (the habits window of the match is still being completed). Reading again cannot loop: the view read again is either
 * fresh (the page then stops asking) or still not (nothing more is in the cache to fetch), and the
 * query asks again for neither, since its key does not change, it does not retry and the window focus
 * does not refetch it. Only `unavailable` leaves the analysis alone: nothing new is in the cache.
 *
 * The query has no `staleTime` of its own: every time a page opens it asks again, which costs
 * nothing while the data is fresh (the service answers `fresh` without a request), and is how an
 * `unavailable` answer is tried again at the next opening. For the same reason it does not retry a
 * failure by itself: the failure of a page that is open is not going away, and the next opening asks
 * again.
 *
 * A rejection (the database could not store the data) stays a query error: the page shows it as "no
 * comparison with your rank for now", never as an error page, since the analysis itself, compared
 * with the habits of the player, is still there.
 *
 * The query stays pending until the analysis has been read again, so that the page does not stop
 * saying that the comparison is loading while it still shows the analysis without it.
 *
 * @param matchId - The match.
 * @param enabled - Whether the data is needed now. It is not for a match that has no analysis to
 *   compare yet: asking would download for nothing.
 * @returns The TanStack Query result holding what the service did: `updated` (new data was stored
 *   and the analysis read again), `fresh` (the cache was good enough, and the analysis was read
 *   again in case it was behind) or `unavailable` (it could not be downloaded).
 */
export function useCommunityRefresh(matchId: MatchId, enabled: boolean) {
  const { analysis } = useServices();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: [...ANALYSIS_COMMUNITY_QUERY_KEY, matchId],
    queryFn: async () => {
      const outcome = await analysis.refreshCommunity(matchId);
      if (outcome !== 'unavailable') {
        await queryClient.invalidateQueries({ queryKey: analysisKey(matchId) });
      }
      return outcome;
    },
    enabled,
    retry: false,
  });
}
