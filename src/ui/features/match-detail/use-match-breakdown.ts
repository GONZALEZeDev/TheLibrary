/**
 * TanStack Query hooks of the tabs of the match page that break a match down: the damage and build
 * tab, and the players tab.
 *
 * Both go through `MatchBreakdownService` and read local data (the projection and the archive of the
 * match), plus the catalogues of the game, which the service downloads at most once a week and
 * answers from its cache otherwise. A view always says what it can show, or why it cannot (`pending`,
 * `unreadable`, `catalogue_unavailable`…): a failed read is a query error, never an empty tab.
 * Query keys never contain an account id: the service resolves the account itself, and keys are
 * logged when a query fails.
 *
 * @packageDocumentation
 */
import { useQuery } from '@tanstack/react-query';
import type { MatchId } from '../../../core/domain/match';
import { useServices } from '../../app/ServicesContext';
import { DETAILS_QUERY_KEY } from '../matches/use-matches';

/**
 * The prefix of the queries of the tabs of one match that break it down, {@link useDamageTab} and
 * {@link usePlayersTab}, and of the timeline tab (`useTimelineTab`, in `./use-match-timeline`).
 *
 * It sits under {@link DETAILS_QUERY_KEY}, deliberately unlike the community queries (see
 * `useMatchAnalysis`): whatever refreshes the match details (a synchronisation, which may have
 * projected the match again, an account change) reads the three tabs again, and `resetAccountData`
 * forgets them with the rest of the account. It is exported so that the page can address the three
 * tabs of one match together (to read them again, say) without spelling the key itself.
 *
 * @param matchId - The match.
 * @returns The query key prefix.
 */
export const BREAKDOWN_QUERY_KEY_OF = (matchId: MatchId) =>
  [...DETAILS_QUERY_KEY, 'breakdown', matchId] as const;

/**
 * How long a read of a tab of a match counts as fresh: five seconds, like the analysis. The match
 * page reads every tab behind its loading gate (see `useMatchTabsReady`), and the tab that mounts as
 * the gate opens, or a moment later, takes that read instead of asking for the same one again (the
 * replay would be built twice). Everything that changes a tab reads it again whatever its age: the
 * key sits under {@link DETAILS_QUERY_KEY}, and an analysis run reads the tabs of its match again.
 */
export const TAB_STALE_TIME_MS = 5_000;

/**
 * The damage and build tab of one match: how the player's damage splits between the weapon, the
 * melee attack, the abilities and the items, compared with their habits, and the build they ended
 * the match with; or why there is nothing to show yet.
 *
 * Reading it never projects or downloads the match: a match whose analysis is `pending` is analysed
 * by the page (see `useAnalyseMatch`), and the tab is read again with the rest of the match details.
 *
 * @param matchId - The match.
 * @param options - How the tab is asked for.
 * @param options.enabled - Whether to read it now; `true` by default. The match page reads it
 *   behind its loading gate only for an archived match (see `useMatchTabsReady`).
 * @returns The TanStack Query result holding the view of the tab: `ready`, or the state that says
 *   why there is nothing to show (`not_analysed`, `pending`, `failed`, `unreadable`,
 *   `catalogue_unavailable`).
 */
export function useDamageTab(matchId: MatchId, options: { readonly enabled?: boolean } = {}) {
  const { breakdown } = useServices();
  return useQuery({
    queryKey: [...BREAKDOWN_QUERY_KEY_OF(matchId), 'damage'],
    queryFn: () => breakdown.getDamageTab(matchId),
    enabled: options.enabled ?? true,
    staleTime: TAB_STALE_TIME_MS,
  });
}

/**
 * The players tab of one match: the scoreboard of the two teams, with the hero and the rank of each
 * player, and the places of the tracked player among them; or why there is nothing to show.
 *
 * @param matchId - The match.
 * @param options - How the tab is asked for.
 * @param options.enabled - Whether to read it now; `true` by default (see {@link useDamageTab}).
 * @returns The TanStack Query result holding the view of the tab: `ready`, `not_archived` or
 *   `unreadable`.
 */
export function usePlayersTab(matchId: MatchId, options: { readonly enabled?: boolean } = {}) {
  const { breakdown } = useServices();
  return useQuery({
    queryKey: [...BREAKDOWN_QUERY_KEY_OF(matchId), 'players'],
    queryFn: () => breakdown.getPlayersTab(matchId),
    enabled: options.enabled ?? true,
    staleTime: TAB_STALE_TIME_MS,
  });
}
