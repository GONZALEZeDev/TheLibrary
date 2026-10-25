/**
 * TanStack Query hooks of the review: what the review page shows when it sums up the player's last
 * matches and compares them with the community and with the matches before, and the download of the
 * community data it compares with.
 *
 * Both go through `ReviewService`. Reading the review never downloads the community data: the page
 * asks for it with {@link useReviewCommunityRefresh} when it opens, and the review is read again once
 * the data is in the cache. Query keys never contain an account id: the service resolves the account
 * itself, and keys are logged when a query fails.
 *
 * @packageDocumentation
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServices } from '../../app/ServicesContext';
import { DETAILS_QUERY_KEY } from '../matches/use-matches';

/**
 * The key of the review. It sits under {@link DETAILS_QUERY_KEY}: whatever refreshes the match
 * details (a synchronisation, an account change) reads the review again, since the matches it sums
 * up are the ones the synchronisation stores and analyses.
 */
export const REVIEW_QUERY_KEY = [...DETAILS_QUERY_KEY, 'review'] as const;

/**
 * The key of the download of the community data the review compares with (see
 * {@link useReviewCommunityRefresh}).
 *
 * It is deliberately not under {@link REVIEW_QUERY_KEY}: reading the review again (which the download
 * itself asks for once it ends) must not run the download again. For the same reason it is not under
 * {@link DETAILS_QUERY_KEY}, which `useRefreshOnSync` invalidates at every match the detail queue
 * records: the community data does not change with them. The data depends on the account, whose rank
 * picks the cohort, so an account change has to reset this query explicitly (see `resetAccountData`),
 * or the page would keep the answer given for the previous account.
 */
export const REVIEW_COMMUNITY_QUERY_KEY = ['review-community'] as const;

/**
 * The review of the linked account: its last matches compared with the community of the tier above
 * and with the matches before, the strengths and the weaknesses, or why there is none yet.
 *
 * It downloads no community data: it reads what the cache holds, whatever its age, and says what is
 * missing (the only download it may make is a game catalogue that was never or is no longer cached).
 * It is cheap to ask again, so it is read again by whatever refreshes the match details, and by
 * {@link useReviewCommunityRefresh} once new community data is stored.
 *
 * @returns The TanStack Query result holding the view of the review: `no_account`, `empty` or
 *   `ready`.
 */
export function useReview() {
  const { review } = useServices();
  return useQuery({
    queryKey: REVIEW_QUERY_KEY,
    queryFn: () => review.getReview(),
  });
}

/**
 * Download the community data the review compares the matches with, unless the cache holds it still
 * fresh, and read the review again when the cache holds data the page has not seen.
 *
 * The review is read again for `updated` and `partial` (data was just stored) and for `fresh` too: a
 * page only asks while its view lacks fresh data, so a `fresh` answer means either that another
 * refresh (the page opened before this one) stored the data between the read of this page and its
 * ask, and the view is behind the cache, or that there is nothing to compare yet. Reading again
 * cannot loop: the view read again is either complete (the page then stops asking) or still not
 * (nothing more is in the cache to fetch), and the query asks again for neither, since its key does
 * not change, it does not retry and the window focus does not refetch it. Only `unavailable` leaves
 * the review alone: nothing new is in the cache.
 *
 * The query has no `staleTime` of its own: every time the page opens it asks again, which costs
 * nothing while the data is fresh (the service answers `fresh` without a request), and is how an
 * `unavailable` answer is tried again at the next opening. For the same reason it does not retry a
 * failure by itself: the failure of a page that is open is not going away, and the next opening asks
 * again.
 *
 * A rejection (the database could not store the data) stays a query error: the page shows it as "no
 * comparison for now", never as an error page, since the review itself, compared with the matches
 * before, is still there.
 *
 * The query stays pending until the review has been read again, so that the page does not stop
 * saying that the comparison is loading while it still shows the review without it.
 *
 * @param enabled - Whether the data is needed now. It is not while the review has not been read, or
 *   has no matches to compare: asking would download for nothing. It must also wait for the first
 *   read of the review to end, and not only for the matches to be there: invalidating a query that
 *   has no data yet while its first read is still going joins that read instead of starting another.
 *   That read, which may have looked at the cache before the download stored its data, would then be
 *   the last, and the page would keep showing the review without the data it just downloaded.
 * @returns The TanStack Query result holding what the service did: `updated` (new data was stored
 *   and the review read again), `partial` (some of it could not be downloaded; what could was stored
 *   and the review read again), `fresh` (the cache was good enough, and the review was read again in
 *   case it was behind) or `unavailable` (none of it could be downloaded).
 */
export function useReviewCommunityRefresh(enabled: boolean) {
  const { review } = useServices();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: REVIEW_COMMUNITY_QUERY_KEY,
    queryFn: async () => {
      const outcome = await review.refreshCommunity();
      if (outcome !== 'unavailable') {
        await queryClient.invalidateQueries({ queryKey: REVIEW_QUERY_KEY });
      }
      return outcome;
    },
    enabled,
    retry: false,
  });
}
