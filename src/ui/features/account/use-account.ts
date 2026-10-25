/**
 * TanStack Query hooks of the linked Steam account: reading it, linking one, giving up a sign-in,
 * unlinking it, and clearing what the screens cached about the account that is gone.
 *
 * Every hook goes through `AccountService`, which is the only writer of the link. The account is
 * cached under {@link ACCOUNT_QUERY_KEY}, and the service tells when it changes: the hook reads it
 * again whoever changed it (the dialog, the settings, the daily refresh of the profile).
 *
 * The match history, the synchronisation, the match details (and the analysis of a match and the
 * review, which sit under them), the downloads of the community data of a match and of the review
 * and the hero catalogue all depend on the account, and the services resolve it themselves, so their
 * query keys do not carry it. Nothing in the cache tells an account's rows from another's: an account
 * change therefore has to clear them all (see {@link resetAccountData}), or the screens would show
 * the previous account's data.
 *
 * @packageDocumentation
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { useServices } from '../../app/ServicesContext';
import { ANALYSIS_COMMUNITY_QUERY_KEY } from '../match-detail/use-match-analysis';
import {
  DETAILS_QUERY_KEY,
  HEROES_QUERY_KEY,
  MATCHES_QUERY_KEY,
  SYNC_QUERY_KEY,
} from '../matches/use-matches';
import { REVIEW_COMMUNITY_QUERY_KEY } from '../review/use-review';

/** Key of the linked account in the TanStack Query cache. */
export const ACCOUNT_QUERY_KEY = ['account'] as const;

/**
 * The prefixes of every query whose answer depends on the linked account. The hero catalogue is one
 * of them even though it is the same for every player: without an account it is empty (the app
 * contacts nobody), and that empty answer must not outlive the link, or the names of the heroes
 * would stay missing for the hour the catalogue is kept fresh.
 *
 * Add the key of every new query that depends on the account to this list. Nothing else clears it
 * when the account changes, and the query would keep showing the previous account's answer.
 */
const ACCOUNT_DEPENDENT_KEYS = [
  MATCHES_QUERY_KEY,
  SYNC_QUERY_KEY,
  DETAILS_QUERY_KEY,
  ACCOUNT_QUERY_KEY,
  HEROES_QUERY_KEY,
  ANALYSIS_COMMUNITY_QUERY_KEY,
  REVIEW_COMMUNITY_QUERY_KEY,
] as const;

/**
 * The Steam account linked to the app, kept up to date while the component that calls it is shown.
 *
 * @returns The TanStack Query result holding the account, or `null` when none is linked.
 */
export function useLinkedAccount() {
  const { account } = useServices();
  const queryClient = useQueryClient();
  // The service is told by the repository whenever the link changes: linked, switched, unlinked, or
  // its profile updated. The account is read again then, instead of guessing what changed.
  useEffect(
    () =>
      account.subscribe(() => {
        void queryClient.invalidateQueries({ queryKey: ACCOUNT_QUERY_KEY });
      }),
    [account, queryClient],
  );
  return useQuery({ queryKey: ACCOUNT_QUERY_KEY, queryFn: () => account.getLinkedAccount() });
}

/**
 * Forget everything the screens know about the account: its matches, the state of its
 * synchronisation, the details, the analyses and the review of its matches, the community data
 * downloaded for them, the account itself and the hero catalogue.
 *
 * The queries are reset, not just invalidated: an invalidated query keeps showing its old data until
 * the new data arrives, and those rows belong to an account that may be erased. A reset query has no
 * data at all, and the ones that are shown read again at once. The returned promise settles when
 * they have.
 *
 * @param queryClient - The TanStack Query client of the app.
 * @returns A promise settled once the queries that are shown have read again; it does not reject.
 */
export async function resetAccountData(queryClient: QueryClient): Promise<void> {
  await Promise.all(
    ACCOUNT_DEPENDENT_KEYS.map((queryKey) => queryClient.resetQueries({ queryKey })),
  );
}

/**
 * Sign the player in with Steam and link the account.
 *
 * The mutation succeeds whatever the sign-in's outcome: read it in `data` (`linked`,
 * `already_linked`, `cancelled`, `refused`…). It fails only when the link cannot be read or saved
 * (an `AppError` of kind `storage`). When it ends it has already updated the screens: a new account
 * clears the data of the previous one, and the same account signing in again only updates its
 * profile, because its data is as good as it was.
 *
 * @returns The TanStack Query mutation; call `mutate()`.
 */
export function useLinkAccount() {
  const { account } = useServices();
  const queryClient = useQueryClient();
  return useMutation({
    // Shows up in the log line written when the mutation fails.
    mutationKey: [...ACCOUNT_QUERY_KEY, 'link'],
    mutationFn: () => account.link(),
    onSuccess: async (result) => {
      if (result.kind === 'linked') {
        await resetAccountData(queryClient);
      } else if (result.kind === 'already_linked') {
        await queryClient.invalidateQueries({ queryKey: ACCOUNT_QUERY_KEY });
      }
      // Any other outcome changed nothing: the screens keep what they show.
    },
  });
}

/**
 * Give up the sign-in in progress (the player closed the dialog or pressed Escape). Nothing happens
 * when none is in progress.
 *
 * @returns A function that cancels the sign-in. Its identity does not change, so that an effect can
 *   depend on it. The pending `useLinkAccount` mutation then ends with the `cancelled` outcome.
 */
export function useCancelLink(): () => void {
  const { account } = useServices();
  return useCallback(() => {
    account.cancelLink();
  }, [account]);
}

/**
 * Unlink the account and delete all of its local data.
 *
 * The screens are cleared whether the unlink succeeded or not: when it fails half-way, the link may
 * be gone while some data is not, and what the screens cached no longer says what is stored.
 *
 * @returns The TanStack Query mutation; call `mutate()`. Its `data` tells whether everything was
 *   deleted (`complete`).
 */
export function useUnlinkAccount() {
  const { account } = useServices();
  const queryClient = useQueryClient();
  return useMutation({
    // Shows up in the log line written when the mutation fails.
    mutationKey: [...ACCOUNT_QUERY_KEY, 'unlink'],
    mutationFn: () => account.unlink(),
    onSettled: () => resetAccountData(queryClient),
  });
}
